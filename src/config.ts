/**
 * Configuration manager for mcp-cache
 */

import { homedir } from 'os';
import { join } from 'path';
import {
  StreamConfig,
  DEFAULT_CONFIG,
  CLIENT_PRESETS,
  ClientInfo,
  BUILTIN_ALWAYS_FRESH_PATTERNS,
} from './types.js';

export class ConfigManager {
  private config: StreamConfig;

  constructor(clientInfo?: ClientInfo) {
    this.config = this.loadConfig(clientInfo);
  }

  private loadConfig(clientInfo?: ClientInfo): StreamConfig {
    const config: StreamConfig = {
      ...DEFAULT_CONFIG,
      toolTtls: { ...DEFAULT_CONFIG.toolTtls },
      alwaysFreshPatterns: [...DEFAULT_CONFIG.alwaysFreshPatterns],
    };

    // 1. Apply client-specific token presets
    if (clientInfo) {
      config.maxTokens = CLIENT_PRESETS[clientInfo.name] ?? CLIENT_PRESETS['default'];
    }

    // 2. Override with environment variables
    if (process.env.MCP_CACHE_MAX_TOKENS) {
      config.maxTokens = parseInt(process.env.MCP_CACHE_MAX_TOKENS, 10);
    }
    if (process.env.MCP_CACHE_CHUNK_SIZE) {
      config.chunkSize = parseInt(process.env.MCP_CACHE_CHUNK_SIZE, 10);
    }
    if (process.env.MCP_CACHE_TTL) {
      config.ttl = parseInt(process.env.MCP_CACHE_TTL, 10);
    }
    if (process.env.MCP_CACHE_CACHE_DIR) {
      config.cacheDir = process.env.MCP_CACHE_CACHE_DIR;
    }
    if (process.env.MCP_CACHE_ENABLE_INDEXING !== undefined) {
      config.enableIndexing = process.env.MCP_CACHE_ENABLE_INDEXING === 'true';
    }
    if (process.env.MCP_CACHE_COMPRESSION !== undefined) {
      config.compression = process.env.MCP_CACHE_COMPRESSION === 'true';
    }
    if (process.env.MCP_CACHE_DEBUG !== undefined) {
      config.debug = process.env.MCP_CACHE_DEBUG === 'true';
    }
    if (process.env.MCP_CACHE_LOOP_THRESHOLD) {
      config.loopThreshold = parseInt(process.env.MCP_CACHE_LOOP_THRESHOLD, 10);
    }
    if (process.env.MCP_CACHE_LOOP_WINDOW_MS) {
      config.loopWindowMs = parseInt(process.env.MCP_CACHE_LOOP_WINDOW_MS, 10);
    }
    if (process.env.MCP_CACHE_DEDUP_MIN_BYTES) {
      config.dedupMinBytes = parseInt(process.env.MCP_CACHE_DEDUP_MIN_BYTES, 10);
    }

    // Per-tool TTL overrides: MCP_CACHE_TOOL_TTLS=read_file:86400,web_search:300
    if (process.env.MCP_CACHE_TOOL_TTLS) {
      for (const pair of process.env.MCP_CACHE_TOOL_TTLS.split(',')) {
        const [tool, ttlStr] = pair.trim().split(':');
        if (tool && ttlStr) {
          const ttl = parseInt(ttlStr, 10);
          if (!isNaN(ttl)) config.toolTtls[tool.trim()] = ttl;
        }
      }
    }

    // Always-fresh tool patterns: MCP_CACHE_ALWAYS_FRESH=bash,run_*,execute_*
    if (process.env.MCP_CACHE_ALWAYS_FRESH) {
      const extra = process.env.MCP_CACHE_ALWAYS_FRESH
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      config.alwaysFreshPatterns.push(...extra);
    }

    // 3. Expand home directory
    if (config.cacheDir.startsWith('~')) {
      config.cacheDir = join(homedir(), config.cacheDir.slice(1));
    }

    return config;
  }

  getConfig(): StreamConfig {
    return this.config;
  }

  updateConfig(updates: Partial<StreamConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  getMaxTokens(): number {
    return this.config.maxTokens;
  }

  getChunkSize(): number {
    return this.config.chunkSize;
  }

  getTTL(): number {
    return this.config.ttl;
  }

  /**
   * Returns the effective TTL for a specific tool name.
   * Checks exact match first, then glob patterns, then falls back to global TTL.
   */
  getToolTTL(toolName: string): number {
    // Exact match
    if (this.config.toolTtls[toolName] !== undefined) {
      return this.config.toolTtls[toolName];
    }
    // Glob pattern match (e.g., 'read_*')
    for (const [pattern, ttl] of Object.entries(this.config.toolTtls)) {
      if (matchGlob(pattern, toolName)) return ttl;
    }
    return this.config.ttl;
  }

  getCacheDir(): string {
    return this.config.cacheDir;
  }

  isDebug(): boolean {
    return this.config.debug;
  }

  /**
   * Check whether a tool should always bypass the cache.
   * Combines built-in side-effect patterns with user-configured patterns.
   */
  isAlwaysFresh(toolName: string): boolean {
    const allPatterns = [...BUILTIN_ALWAYS_FRESH_PATTERNS, ...this.config.alwaysFreshPatterns];
    return allPatterns.some(p => matchGlob(p, toolName));
  }
}

/** Simple glob matching supporting * wildcard. */
function matchGlob(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}
