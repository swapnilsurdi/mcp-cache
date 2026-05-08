/**
 * Cache manager for mcp-cache.
 *
 * Key capabilities beyond basic storage:
 * - Deterministic dedup keys: SHA-256(tool + sorted args) prevents redundant upstream calls
 * - Session scoping: every entry records which session created it
 * - Per-tool TTL: each tool type can have a different expiry
 * - Pinning: mark entries to survive context compaction hints
 * - Hit tracking: counts how many times an entry was served from cache
 * - Stats: aggregate hit/miss/bypass counters for the current session
 */

import { mkdir, writeFile, readFile, readdir, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { randomBytes, createHash } from 'crypto';
import { CachedResponse, ResponseMetadata, CacheStats } from './types.js';

export class CacheManager {
  private readonly cacheDir: string;
  private readonly defaultTtl: number;
  private cleanupInterval?: NodeJS.Timeout;

  /** In-memory dedup index: argsHash → responseId */
  private readonly dedupMap = new Map<string, string>();

  /** Session-level stats (reset per process lifetime) */
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    bypassed: 0,
    loopBreaks: 0,
    totalCachedBytes: 0,
    totalEntries: 0,
    pinnedEntries: 0,
  };

  constructor(cacheDir: string, defaultTtl: number) {
    this.cacheDir = cacheDir;
    this.defaultTtl = defaultTtl;
    this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await this.buildDedupIndex();
      this.startAutoCleanup();
    } catch (error) {
      console.error('mcp-cache: Failed to initialize cache directory:', error);
    }
  }

  /**
   * Scan existing metadata files to rebuild the dedup index on startup.
   * This allows the same (tool, args) called in a previous session to hit
   * cache immediately if the entry hasn't expired.
   */
  private async buildDedupIndex(): Promise<void> {
    try {
      const files = await readdir(this.cacheDir);
      const metaFiles = files.filter(f => f.endsWith('.meta.json'));
      const now = new Date();

      for (const file of metaFiles) {
        try {
          const raw = await readFile(join(this.cacheDir, file), 'utf8');
          const meta = JSON.parse(raw) as ResponseMetadata;
          if (meta.argsHash && new Date(meta.expiresAt) > now) {
            this.dedupMap.set(meta.argsHash, meta.id);
          }
        } catch {}
      }
    } catch {}
  }

  private startAutoCleanup(): void {
    const INTERVAL = 5 * 60 * 1000;
    this.cleanupInterval = setInterval(async () => {
      const cleaned = await this.cleanup();
      if (cleaned > 0) {
        console.error(`mcp-cache: Cleaned up ${cleaned} expired cache entries`);
      }
    }, INTERVAL);
    this.cleanupInterval.unref();
  }

  stop(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
  }

  // ─── Dedup ───────────────────────────────────────────────────────────────

  /**
   * Compute a canonical SHA-256 hash for a (tool, args) pair.
   * Args are deep-sorted so key order differences don't create separate entries.
   */
  hashArgs(toolName: string, args: unknown): string {
    const canonical = JSON.stringify([toolName, deepSort(args)]);
    return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  }

  /** Returns the cached responseId for this (tool, args) if one exists and hasn't expired. */
  async getDedupId(argsHash: string): Promise<string | null> {
    const id = this.dedupMap.get(argsHash);
    if (!id) return null;

    const meta = await this.getMetadata(id);
    if (!meta || new Date(meta.expiresAt) < new Date()) {
      this.dedupMap.delete(argsHash);
      return null;
    }
    return id;
  }

  // ─── Core CRUD ────────────────────────────────────────────────────────────

  /**
   * Save a tool response to cache.
   *
   * @param toolName  MCP tool name
   * @param args      Original tool arguments (stored for debugging)
   * @param data      Tool response data
   * @param client    Client name (e.g. 'claude-code')
   * @param sessionId Active session ID
   * @param ttl       TTL in seconds (falls back to defaultTtl)
   * @param isLarge   Whether this response exceeded the token threshold
   */
  async save(
    toolName: string,
    args: unknown,
    data: unknown,
    client: string,
    sessionId: string,
    ttl?: number,
    isLarge = false
  ): Promise<string> {
    const id = 'resp_' + randomBytes(6).toString('hex');
    const argsHash = this.hashArgs(toolName, args);
    const effectiveTtl = ttl ?? this.defaultTtl;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + effectiveTtl * 1000);

    const dataStr = JSON.stringify(data);
    const sizeBytes = Buffer.byteLength(dataStr, 'utf8');

    const cached: CachedResponse = {
      id,
      sessionId,
      tool: toolName,
      argsHash,
      args,
      data,
      sizeBytes,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      client,
      chunks: Math.ceil(dataStr.length / 10000),
      indexed: false,
      pinned: false,
      hitCount: 0,
      isLarge,
    };

    const metadata: ResponseMetadata = {
      id,
      sessionId,
      tool: toolName,
      argsHash,
      sizeBytes,
      createdAt: cached.createdAt,
      expiresAt: cached.expiresAt,
      client,
      chunks: cached.chunks,
      indexed: false,
      pinned: false,
      hitCount: 0,
      isLarge,
    };

    await writeFile(this.dataPath(id), dataStr, 'utf8');
    await writeFile(this.metaPath(id), JSON.stringify(metadata, null, 2), 'utf8');

    // Register in dedup index (overwrites any stale entry for same hash)
    this.dedupMap.set(argsHash, id);

    this.stats.totalEntries++;
    if (isLarge) this.stats.totalCachedBytes += sizeBytes;

    return id;
  }

  async get(id: string): Promise<unknown | null> {
    const metadata = await this.getMetadata(id);
    if (!metadata) return null;
    if (new Date(metadata.expiresAt) < new Date()) {
      await this.delete(id);
      return null;
    }

    try {
      const raw = await readFile(this.dataPath(id), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async getMetadata(id: string): Promise<ResponseMetadata | null> {
    try {
      const raw = await readFile(this.metaPath(id), 'utf8');
      return JSON.parse(raw) as ResponseMetadata;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      const meta = await this.getMetadata(id);
      if (meta) this.dedupMap.delete(meta.argsHash);
      await unlink(this.dataPath(id)).catch(() => {});
      await unlink(this.metaPath(id)).catch(() => {});
      this.stats.totalEntries = Math.max(0, this.stats.totalEntries - 1);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<ResponseMetadata[]> {
    try {
      const files = await readdir(this.cacheDir);
      const results = await Promise.all(
        files.filter(f => f.endsWith('.meta.json')).map(async f => {
          const id = f.replace('.meta.json', '');
          return this.getMetadata(id);
        })
      );
      return results.filter((m): m is ResponseMetadata => m !== null);
    } catch {
      return [];
    }
  }

  async cleanup(): Promise<number> {
    const now = new Date();
    const items = await this.list();
    let cleaned = 0;
    for (const item of items) {
      if (new Date(item.expiresAt) < now) {
        await this.delete(item.id);
        cleaned++;
      }
    }
    return cleaned;
  }

  async refresh(id: string): Promise<boolean> {
    const metadata = await this.getMetadata(id);
    if (!metadata) return false;
    metadata.expiresAt = new Date(Date.now() + this.defaultTtl * 1000).toISOString();
    await writeFile(this.metaPath(id), JSON.stringify(metadata, null, 2), 'utf8');
    return true;
  }

  // ─── Hit tracking ─────────────────────────────────────────────────────────

  async recordHit(id: string): Promise<void> {
    const metadata = await this.getMetadata(id);
    if (!metadata) return;
    metadata.hitCount = (metadata.hitCount ?? 0) + 1;
    await writeFile(this.metaPath(id), JSON.stringify(metadata, null, 2), 'utf8');
    this.stats.hits++;
  }

  recordMiss(): void {
    this.stats.misses++;
  }

  recordBypass(): void {
    this.stats.bypassed++;
  }

  recordLoopBreak(): void {
    this.stats.loopBreaks++;
  }

  // ─── Pinning ──────────────────────────────────────────────────────────────

  async pin(id: string, reason?: string): Promise<boolean> {
    const metadata = await this.getMetadata(id);
    if (!metadata) return false;
    metadata.pinned = true;
    if (reason) metadata.pinnedReason = reason;
    await writeFile(this.metaPath(id), JSON.stringify(metadata, null, 2), 'utf8');
    this.stats.pinnedEntries++;
    return true;
  }

  async unpin(id: string): Promise<boolean> {
    const metadata = await this.getMetadata(id);
    if (!metadata) return false;
    metadata.pinned = false;
    delete metadata.pinnedReason;
    await writeFile(this.metaPath(id), JSON.stringify(metadata, null, 2), 'utf8');
    this.stats.pinnedEntries = Math.max(0, this.stats.pinnedEntries - 1);
    return true;
  }

  async getPinned(): Promise<ResponseMetadata[]> {
    const all = await this.list();
    return all.filter(m => m.pinned);
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  getStats(): CacheStats {
    return { ...this.stats };
  }

  async getCacheSize(): Promise<number> {
    try {
      const files = await readdir(this.cacheDir);
      let total = 0;
      for (const file of files) {
        const s = await stat(join(this.cacheDir, file)).catch(() => null);
        if (s) total += s.size;
      }
      return total;
    } catch {
      return 0;
    }
  }

  // ─── Paths ────────────────────────────────────────────────────────────────

  private dataPath(id: string): string {
    return join(this.cacheDir, `${id}.json`);
  }

  private metaPath(id: string): string {
    return join(this.cacheDir, `${id}.meta.json`);
  }
}

function deepSort(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepSort);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).sort()) {
    sorted[key] = deepSort((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
