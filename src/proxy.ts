/**
 * Core MCP proxy for mcp-cache.
 *
 * Wraps any MCP server and adds:
 * - Idempotent deduplication: identical (tool, args) calls within TTL return from cache
 * - Cache tokens: large responses stored on disk; returned as lightweight tokens
 * - inflate_response: re-expand a token back into context (for post-compaction recovery)
 * - Session management: ULID-based sessions with fork/branch support
 * - Loop detection: circuit breaker for repeated non-cacheable calls
 * - Per-tool TTL: configurable freshness per tool type
 * - Pin/unpin: mark responses to survive context compaction
 * - Cache stats: hit/miss rates and token savings
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { CacheManager } from './cache.js';
import { QueryEngine } from './query.js';
import { ConfigManager } from './config.js';
import { TargetServerTransport } from './transport.js';
import { SessionManager } from './session.js';
import { LoopDetector } from './loop-detector.js';
import { ClientInfo } from './types.js';

const MANAGEMENT_TOOLS = new Set([
  'query_response',
  'get_chunk',
  'list_responses',
  'get_response_info',
  'refresh_response',
  'delete_response',
  'inflate_response',
  'pin_response',
  'unpin_response',
  'get_pinned_responses',
  'get_session_info',
  'list_sessions',
  'fork_session',
  'get_cache_stats',
]);

export class MCPProxy {
  private server: Server;
  private targetTransport: TargetServerTransport;
  private cacheManager: CacheManager;
  private queryEngine: QueryEngine;
  private configManager: ConfigManager;
  private sessionManager: SessionManager;
  private loopDetector: LoopDetector;
  private clientInfo?: ClientInfo;
  private targetTools: Tool[] = [];

  constructor(
    private targetCommand: string,
    private targetArgs: string[],
    private options: {
      sessionId?: string;
      forkFrom?: string;
      sessionLabel?: string;
    } = {}
  ) {
    this.server = new Server(
      { name: 'mcp-cache', version: '0.2.0' },
      { capabilities: { tools: {} } }
    );

    this.targetTransport = new TargetServerTransport(targetCommand, targetArgs);
    this.configManager = new ConfigManager();
    const config = this.configManager.getConfig();
    this.cacheManager = new CacheManager(config.cacheDir, config.ttl);
    this.sessionManager = new SessionManager(config.cacheDir);
    this.loopDetector = new LoopDetector(config.loopThreshold, config.loopWindowMs);
    this.queryEngine = new QueryEngine();

    this.setupHandlers();
  }

  // ─── Request handlers ─────────────────────────────────────────────────────

  private setupHandlers(): void {
    this.server.onclose = async () => {
      console.error('mcp-cache: Client disconnected');
      await this.cleanup();
    };

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (this.targetTools.length === 0) {
        try {
          const result = await this.targetTransport.sendRequest('tools/list');
          this.targetTools = result.tools || [];
        } catch (error) {
          console.error('mcp-cache: Failed to get tools from target:', error);
        }
      }
      return { tools: [...this.targetTools, ...this.getManagementTools()] };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments || {};

      if (MANAGEMENT_TOOLS.has(toolName)) {
        return this.handleManagementTool(toolName, args) as any;
      }
      return this.forwardToolCall(toolName, args) as any;
    });
  }

  // ─── Tool forwarding with dedup, loop detection, caching ──────────────────

  private async forwardToolCall(toolName: string, args: unknown): Promise<unknown> {
    const config = this.configManager.getConfig();
    const session = this.sessionManager.getCurrent();
    const sessionId = session?.id ?? 'unknown';

    // Touch session on activity
    this.sessionManager.touch();

    try {
      // ── 1. Always-fresh tools bypass cache entirely ──────────────────────
      if (this.configManager.isAlwaysFresh(toolName)) {
        const loop = this.loopDetector.check(toolName, args);
        if (loop.blocked) {
          this.cacheManager.recordLoopBreak();
          return textResponse(loop.message!);
        }
        this.cacheManager.recordBypass();
        return this.forwardRaw(toolName, args);
      }

      // ── 2. Dedup check: have we seen this exact call before? ─────────────
      const argsHash = this.cacheManager.hashArgs(toolName, args);
      const cachedId = await this.cacheManager.getDedupId(argsHash);

      if (cachedId) {
        const meta = await this.cacheManager.getMetadata(cachedId);
        if (meta) {
          await this.cacheManager.recordHit(cachedId);

          if (meta.isLarge) {
            // Large response: return cache token (data already on disk)
            return textResponse(this.buildCacheToken(cachedId, meta, toolName, true));
          } else {
            // Small response: return original data directly (transparent dedup)
            const data = await this.cacheManager.get(cachedId);
            if (data) {
              const dataObj = data as { content?: unknown };
              // If it looks like an MCP response, return it directly
              if (dataObj && typeof dataObj === 'object' && 'content' in dataObj) {
                return data;
              }
              return textResponse(JSON.stringify(data, null, 2));
            }
          }
        }
      }

      // ── 3. Cache miss — forward to target ───────────────────────────────
      this.cacheManager.recordMiss();
      const response = await this.forwardRaw(toolName, args);

      const responseSize = JSON.stringify(response).length;
      const tokenLimit = this.configManager.getMaxTokens() * 4;
      const sizeThreshold = Math.min(900_000, tokenLimit);
      const toolTtl = this.configManager.getToolTTL(toolName);

      // ── 4a. Large response — cache and return token ──────────────────────
      if (responseSize >= sizeThreshold) {
        const id = await this.cacheManager.save(
          toolName, args, response,
          this.clientInfo?.name ?? 'unknown',
          sessionId, toolTtl, true
        );
        const meta = await this.cacheManager.getMetadata(id);
        return textResponse(this.buildCacheToken(id, meta!, toolName, false));
      }

      // ── 4b. Medium/small response — cache for dedup, return data ─────────
      if (responseSize >= config.dedupMinBytes) {
        await this.cacheManager.save(
          toolName, args, response,
          this.clientInfo?.name ?? 'unknown',
          sessionId, toolTtl, false
        );
      }

      return response;

    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes('maximum length') || msg.includes('exceeds')) {
        return textResponse(
          `Response exceeded MCP protocol size limit (1MB).\n` +
          `Try using a more specific query or breaking the operation into smaller parts.`
        );
      }
      return { content: [{ type: 'text', text: `Error calling ${toolName}: ${msg}` }], isError: true };
    }
  }

  private async forwardRaw(toolName: string, args: unknown): Promise<unknown> {
    return this.targetTransport.sendRequest('tools/call', { name: toolName, arguments: args });
  }

  // ─── Cache token formatting ────────────────────────────────────────────────

  private buildCacheToken(
    id: string,
    meta: { tool: string; sizeBytes: number; chunks: number; expiresAt: string; sessionId: string; argsHash: string },
    toolName: string,
    isHit: boolean
  ): string {
    const sizeKB = (meta.sizeBytes / 1024).toFixed(1);
    const hitStr = isHit ? 'CACHE HIT' : 'CACHED (first call)';

    return (
      `[CACHE_TOKEN:${id}]\n` +
      `${'─'.repeat(56)}\n` +
      `  Tool:     ${toolName}\n` +
      `  Status:   ${hitStr}\n` +
      `  Size:     ${sizeKB} KB  |  Chunks: ${meta.chunks}\n` +
      `  Session:  ${meta.sessionId}\n` +
      `  Expires:  ${meta.expiresAt}\n` +
      `${'─'.repeat(56)}\n` +
      `INSTRUCTIONS: This response is stored in cache. To work with it:\n` +
      `  inflate_response("${id}")              → first chunk + summary\n` +
      `  query_response("${id}", "term")        → text search\n` +
      `  query_response("${id}", "/regex/")     → regex search\n` +
      `  query_response("${id}", "$.path")      → JSONPath query\n` +
      `  get_chunk("${id}", N)                  → read chunk N (0-indexed)\n` +
      `  pin_response("${id}", "reason")        → survive context compaction\n` +
      `NOTE: Subsequent identical calls to "${toolName}" with the same arguments\n` +
      `will return this cache token directly (deduplication active).`
    );
  }

  // ─── Management tool dispatch ─────────────────────────────────────────────

  private async handleManagementTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      switch (toolName) {
        case 'query_response':      return this.handleQueryResponse(args);
        case 'get_chunk':           return this.handleGetChunk(args);
        case 'list_responses':      return this.handleListResponses(args);
        case 'get_response_info':   return this.handleGetResponseInfo(args);
        case 'refresh_response':    return this.handleRefreshResponse(args);
        case 'delete_response':     return this.handleDeleteResponse(args);
        case 'inflate_response':    return this.handleInflateResponse(args);
        case 'pin_response':        return this.handlePinResponse(args);
        case 'unpin_response':      return this.handleUnpinResponse(args);
        case 'get_pinned_responses': return this.handleGetPinnedResponses();
        case 'get_session_info':    return this.handleGetSessionInfo();
        case 'list_sessions':       return this.handleListSessions();
        case 'fork_session':        return this.handleForkSession(args);
        case 'get_cache_stats':     return this.handleGetCacheStats();
        default: throw new Error(`Unknown management tool: ${toolName}`);
      }
    } catch (error) {
      return textResponse(`Error: ${(error as Error).message}`);
    }
  }

  // ─── Existing handlers (enhanced) ─────────────────────────────────────────

  private async handleQueryResponse(args: Record<string, unknown>): Promise<unknown> {
    const { response_id, query, mode, limit, contextLines, caseSensitive } = args;
    const data = await this.cacheManager.get(response_id as string);
    if (!data) throw new Error(`Response ${response_id} not found or expired`);

    const results = this.queryEngine.query(data, query as string, {
      mode: mode as 'text' | 'jsonpath' | 'regex' | undefined,
      limit: limit as number | undefined,
      contextLines: contextLines as number | undefined,
      caseSensitive: caseSensitive as boolean | undefined,
    });

    const text = JSON.stringify(results, null, 2);
    const MAX = 800_000;
    if (text.length > MAX) {
      return textResponse(
        `Results too large (${(text.length / 1024).toFixed(1)}KB). Showing first 800KB:\n\n` +
        text.slice(0, MAX) +
        `\n\n[... truncated. Use a more specific query or lower 'limit' (current: ${limit ?? 100}).`
      );
    }
    return textResponse(text);
  }

  private async handleGetChunk(args: Record<string, unknown>): Promise<unknown> {
    const { response_id, chunk_number } = args;
    const data = await this.cacheManager.get(response_id as string);
    if (!data) throw new Error(`Response ${response_id} not found or expired`);

    const config = this.configManager.getConfig();
    const result = this.queryEngine.extractChunk(data, chunk_number as number, config.chunkSize);
    return textResponse(`Chunk ${(chunk_number as number) + 1}/${result.totalChunks} of ${response_id}:\n\n${result.chunk}`);
  }

  private async handleListResponses(args: Record<string, unknown>): Promise<unknown> {
    const { session_id } = args;
    let responses = await this.cacheManager.list();
    if (session_id) {
      responses = responses.filter(r => r.sessionId === session_id);
    }
    return textResponse(JSON.stringify(responses, null, 2));
  }

  private async handleGetResponseInfo(args: Record<string, unknown>): Promise<unknown> {
    const meta = await this.cacheManager.getMetadata(args.response_id as string);
    if (!meta) throw new Error(`Response ${args.response_id} not found`);
    return textResponse(JSON.stringify(meta, null, 2));
  }

  private async handleRefreshResponse(args: Record<string, unknown>): Promise<unknown> {
    const id = args.response_id as string;
    const ok = await this.cacheManager.refresh(id);
    if (!ok) throw new Error(`Failed to refresh ${id}`);
    const meta = await this.cacheManager.getMetadata(id);
    return textResponse(`Refreshed ${id}. New expiry: ${meta?.expiresAt}`);
  }

  private async handleDeleteResponse(args: Record<string, unknown>): Promise<unknown> {
    const id = args.response_id as string;
    const ok = await this.cacheManager.delete(id);
    return textResponse(ok ? `Deleted ${id}` : `Failed to delete ${id}`);
  }

  // ─── New handlers ─────────────────────────────────────────────────────────

  /**
   * inflate_response: Re-expand a cache token back into context.
   * Returns the first ~3KB of the response plus full metadata.
   * Designed for post-compaction recovery — the AI can call this after
   * losing a cache token from context to restore situational awareness.
   */
  private async handleInflateResponse(args: Record<string, unknown>): Promise<unknown> {
    const id = args.response_id as string;
    const meta = await this.cacheManager.getMetadata(id);
    if (!meta) throw new Error(`Response ${id} not found or expired`);

    const data = await this.cacheManager.get(id);
    if (!data) throw new Error(`Response ${id} data missing or expired`);

    const config = this.configManager.getConfig();
    const firstChunk = this.queryEngine.extractChunk(data, 0, config.chunkSize);
    const sizeKB = (meta.sizeBytes / 1024).toFixed(1);

    const text =
      `[INFLATED:${id}]\n` +
      `${'═'.repeat(56)}\n` +
      `  Tool:     ${meta.tool}\n` +
      `  Size:     ${sizeKB} KB  |  Total chunks: ${meta.chunks}\n` +
      `  Session:  ${meta.sessionId}\n` +
      `  Created:  ${meta.createdAt}\n` +
      `  Expires:  ${meta.expiresAt}\n` +
      `  Pinned:   ${meta.pinned}${meta.pinnedReason ? ` (${meta.pinnedReason})` : ''}\n` +
      `  Hit count: ${meta.hitCount}\n` +
      `${'═'.repeat(56)}\n` +
      `FIRST CHUNK (chunk 1/${meta.chunks}):\n\n` +
      firstChunk.chunk +
      (meta.chunks > 1
        ? `\n\n[${meta.chunks - 1} more chunk(s). Use get_chunk("${id}", N) to read them.]`
        : '');

    return textResponse(text);
  }

  private async handlePinResponse(args: Record<string, unknown>): Promise<unknown> {
    const id = args.response_id as string;
    const reason = args.reason as string | undefined;
    const ok = await this.cacheManager.pin(id, reason);
    if (!ok) throw new Error(`Response ${id} not found`);
    return textResponse(
      `Pinned ${id}${reason ? ` (reason: ${reason})` : ''}.\n` +
      `This response will be surfaced by get_pinned_responses() after context compaction.`
    );
  }

  private async handleUnpinResponse(args: Record<string, unknown>): Promise<unknown> {
    const id = args.response_id as string;
    const ok = await this.cacheManager.unpin(id);
    if (!ok) throw new Error(`Response ${id} not found`);
    return textResponse(`Unpinned ${id}.`);
  }

  private async handleGetPinnedResponses(): Promise<unknown> {
    const pinned = await this.cacheManager.getPinned();
    if (pinned.length === 0) {
      return textResponse(
        `No pinned responses.\n` +
        `Use pin_response("<id>", "reason") to mark important responses that should survive context compaction.`
      );
    }

    const lines = [
      `${pinned.length} pinned response(s). Call inflate_response("<id>") to restore any of them:\n`,
      ...pinned.map(m =>
        `  [${m.id}] ${m.tool} | ${(m.sizeBytes / 1024).toFixed(1)}KB | ` +
        `expires ${m.expiresAt}` +
        (m.pinnedReason ? ` | "${m.pinnedReason}"` : '')
      ),
    ];
    return textResponse(lines.join('\n'));
  }

  private async handleGetSessionInfo(): Promise<unknown> {
    const session = this.sessionManager.getCurrent();
    if (!session) return textResponse('No active session.');

    const allResponses = await this.cacheManager.list();
    const sessionResponses = allResponses.filter(r => r.sessionId === session.id);
    const stats = this.cacheManager.getStats();

    const info = {
      ...session,
      responseCount: sessionResponses.length,
      totalSizeBytes: sessionResponses.reduce((s, r) => s + r.sizeBytes, 0),
      stats: {
        hits: stats.hits,
        misses: stats.misses,
        bypassed: stats.bypassed,
        loopBreaks: stats.loopBreaks,
        hitRate: stats.hits + stats.misses > 0
          ? `${((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1)}%`
          : 'n/a',
      },
    };
    return textResponse(JSON.stringify(info, null, 2));
  }

  private async handleListSessions(): Promise<unknown> {
    const tree = await this.sessionManager.getTree();
    const current = this.sessionManager.getCurrent();
    return textResponse(
      `Current session: ${current?.id ?? 'none'}\n\n` +
      JSON.stringify(tree, null, 2)
    );
  }

  private async handleForkSession(args: Record<string, unknown>): Promise<unknown> {
    const label = args.label as string | undefined;
    const fork = await this.sessionManager.fork(label);
    return textResponse(
      `Forked session created.\n` +
      `  New session ID: ${fork.id}\n` +
      `  Forked from:    ${fork.forkOf}\n` +
      (fork.label ? `  Label:          ${fork.label}\n` : '') +
      `\nThis session continues from the same cache state as the parent.\n` +
      `To use the fork, restart mcp-cache with: --session ${fork.id}`
    );
  }

  private async handleGetCacheStats(): Promise<unknown> {
    const stats = this.cacheManager.getStats();
    const totalSize = await this.cacheManager.getCacheSize();
    const all = await this.cacheManager.list();
    const session = this.sessionManager.getCurrent();

    const report = {
      session: session?.id ?? 'unknown',
      cache: {
        totalEntries: all.length,
        pinnedEntries: all.filter(m => m.pinned).length,
        totalSizeBytes: totalSize,
        totalSizeKB: (totalSize / 1024).toFixed(1),
      },
      performance: {
        hits: stats.hits,
        misses: stats.misses,
        bypassed: stats.bypassed,
        loopBreaks: stats.loopBreaks,
        hitRate: stats.hits + stats.misses > 0
          ? `${((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1)}%`
          : 'n/a',
        estimatedTokensSaved: Math.round(stats.totalCachedBytes / 4),
      },
      loopDetector: this.loopDetector.getActiveCircuits(),
    };
    return textResponse(JSON.stringify(report, null, 2));
  }

  // ─── Management tool schemas ───────────────────────────────────────────────

  private getManagementTools(): Tool[] {
    return [
      {
        name: 'query_response',
        description:
          'Search a cached large response. Supports text (case-insensitive), ' +
          'regex (/pattern/flags), and JSONPath ($.path). Results include line numbers and context. ' +
          'Start with limit=10 for large responses.',
        inputSchema: {
          type: 'object',
          properties: {
            response_id: { type: 'string', description: 'Cache token ID (e.g. resp_abc123)' },
            query: {
              type: 'string',
              description: 'Search query: plain text, /regex/flags, or $.jsonpath',
            },
            mode: { type: 'string', enum: ['text', 'jsonpath', 'regex'], description: 'Auto-detected if omitted' },
            limit: { type: 'number', description: 'Max results (default 100, recommended 10-20)' },
            contextLines: { type: 'number', description: 'Lines of context around each match (default 2)' },
            caseSensitive: { type: 'boolean', description: 'Case-sensitive text search (default false)' },
          },
          required: ['response_id', 'query'],
        },
      },
      {
        name: 'get_chunk',
        description: 'Read a specific chunk of a cached large response (0-indexed).',
        inputSchema: {
          type: 'object',
          properties: {
            response_id: { type: 'string' },
            chunk_number: { type: 'number', description: 'Chunk index starting at 0' },
          },
          required: ['response_id', 'chunk_number'],
        },
      },
      {
        name: 'inflate_response',
        description:
          'Restore a cached response token into context. Returns metadata + first chunk. ' +
          'Use this after context compaction to recover a response you previously had. ' +
          'Equivalent to re-running the original tool call but cheaper (no upstream call).',
        inputSchema: {
          type: 'object',
          properties: {
            response_id: { type: 'string', description: 'Cache token ID from a [CACHE_TOKEN:...] reference' },
          },
          required: ['response_id'],
        },
      },
      {
        name: 'list_responses',
        description: 'List all cached responses, optionally filtered by session.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Filter by session ID (optional)' },
          },
        },
      },
      {
        name: 'get_response_info',
        description: 'Get full metadata for a cached response (size, TTL, hit count, pinned status, etc.).',
        inputSchema: {
          type: 'object',
          properties: {
            response_id: { type: 'string' },
          },
          required: ['response_id'],
        },
      },
      {
        name: 'refresh_response',
        description: 'Extend the TTL of a cached response by the default TTL duration.',
        inputSchema: {
          type: 'object',
          properties: { response_id: { type: 'string' } },
          required: ['response_id'],
        },
      },
      {
        name: 'delete_response',
        description: 'Delete a cached response and remove it from the dedup index.',
        inputSchema: {
          type: 'object',
          properties: { response_id: { type: 'string' } },
          required: ['response_id'],
        },
      },
      {
        name: 'pin_response',
        description:
          'Mark a cached response as important so it survives context compaction. ' +
          'After compaction, call get_pinned_responses() to see what was pinned.',
        inputSchema: {
          type: 'object',
          properties: {
            response_id: { type: 'string' },
            reason: { type: 'string', description: 'Why this is important (helps recall after compaction)' },
          },
          required: ['response_id'],
        },
      },
      {
        name: 'unpin_response',
        description: 'Remove the pin from a cached response.',
        inputSchema: {
          type: 'object',
          properties: { response_id: { type: 'string' } },
          required: ['response_id'],
        },
      },
      {
        name: 'get_pinned_responses',
        description:
          'List all pinned responses. Call this immediately after context compaction to recover ' +
          'important cached results. Then use inflate_response() to bring any of them back into context.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_session_info',
        description: 'Get current session details: ID, fork ancestry, response count, cache hit rate.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_sessions',
        description: 'List all sessions as a fork tree, newest first.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'fork_session',
        description:
          'Create a named fork of the current session. Forks inherit the parent cache state ' +
          '(same dedup entries) but accumulate their own responses independently.',
        inputSchema: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Human-readable label for this fork (e.g. "try-redis-approach")' },
          },
        },
      },
      {
        name: 'get_cache_stats',
        description:
          'Show cache performance metrics: hit rate, bytes saved, loop breaks, active circuits.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  private async cleanup(): Promise<void> {
    try {
      await this.targetTransport.stop();
      this.cacheManager.stop();
    } catch (error) {
      console.error('mcp-cache: Error during cleanup:', error);
    }
  }

  async start(): Promise<void> {
    // Start target server
    await this.targetTransport.start();

    const initResult = await this.targetTransport.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-cache', version: '0.2.0' },
    });

    await this.targetTransport.sendNotification('notifications/initialized');

    // Initialize session
    const session = await this.sessionManager.init({
      id: this.options.sessionId,
      forkOf: this.options.forkFrom,
      label: this.options.sessionLabel,
    });

    // Establish client info (default; we don't have access to actual client init here)
    this.clientInfo = { name: 'claude-code', version: '0.1.0' };
    this.configManager = new ConfigManager(this.clientInfo);
    const config = this.configManager.getConfig();
    this.cacheManager = new CacheManager(config.cacheDir, config.ttl);

    // Connect to MCP client via stdio
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      console.error(`mcp-cache: ${signal} received, shutting down...`);
      await this.cleanup();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('uncaughtException', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
        this.cleanup().then(() => process.exit(0));
      } else {
        console.error('mcp-cache: Uncaught exception:', error);
        this.cleanup().then(() => process.exit(1));
      }
    });

    console.error(`mcp-cache: v0.2.0 started`);
    console.error(`  Target: ${initResult.serverInfo?.name} v${initResult.serverInfo?.version}`);
    console.error(`  Session: ${session.id}${session.forkOf ? ` (fork of ${session.forkOf})` : ''}`);
    console.error(`  Cache dir: ${config.cacheDir}`);
    console.error(`  Client: ${this.clientInfo.name} (token limit: ${this.configManager.getMaxTokens()})`);
  }
}

function textResponse(text: string): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: 'text', text }] };
}
