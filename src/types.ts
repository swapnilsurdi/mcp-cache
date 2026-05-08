/**
 * Type definitions for mcp-cache
 */

export interface ClientInfo {
  name: string;
  version: string;
}

export interface StreamConfig {
  maxTokens: number;
  chunkSize: number;
  ttl: number;               // default TTL in seconds
  cacheDir: string;
  enableIndexing: boolean;
  compression: boolean;
  debug: boolean;
  // Per-tool TTL overrides: { 'read_file': 86400, 'web_search': 300 }
  toolTtls: Record<string, number>;
  // Glob-like patterns for tools that must never be served from cache
  alwaysFreshPatterns: string[];
  // Loop detector settings
  loopThreshold: number;     // identical non-cacheable calls before circuit trips
  loopWindowMs: number;      // sliding window for loop detection (ms)
  // Minimum response size to cache for deduplication (bytes)
  dedupMinBytes: number;
}

export interface CachedResponse {
  id: string;
  sessionId: string;         // session that created this entry
  tool: string;
  argsHash: string;          // SHA-256 of (tool + sorted args) for dedup lookup
  args?: unknown;            // original args, stored for debugging
  data: unknown;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
  client: string;
  chunks: number;
  indexed: boolean;
  pinned: boolean;           // survives context compaction hints
  pinnedReason?: string;
  hitCount: number;          // how many times served from cache
  isLarge: boolean;          // true if response exceeded token threshold (returned as token)
}

export interface ResponseMetadata {
  id: string;
  sessionId: string;
  tool: string;
  argsHash: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
  client: string;
  chunks: number;
  indexed: boolean;
  pinned: boolean;
  pinnedReason?: string;
  hitCount: number;
  isLarge: boolean;
}

export interface QueryOptions {
  mode?: 'text' | 'jsonpath' | 'regex';
  limit?: number;
  offset?: number;
  contextLines?: number;
  caseSensitive?: boolean;
}

export interface CacheStats {
  hits: number;              // total cache hits (dedup saved a round-trip)
  misses: number;            // total cache misses (forwarded to target)
  bypassed: number;          // always-fresh calls that skipped cache
  loopBreaks: number;        // times the circuit breaker fired
  totalCachedBytes: number;  // bytes saved from context by tokens
  totalEntries: number;
  pinnedEntries: number;
  sessionId?: string;
}

export const CLIENT_PRESETS: Record<string, number> = {
  'claude-ai': 25000,
  'claude-code': 25000,
  'cursor': 30000,
  'cline': 25000,
  'default': 20000,
};

/** Tool name patterns that are side-effect-bearing and must never be cached. */
export const BUILTIN_ALWAYS_FRESH_PATTERNS: string[] = [
  'write_*',
  'create_*',
  'delete_*',
  'remove_*',
  'update_*',
  'edit_*',
  'run_*',
  'execute_*',
  'send_*',
  'post_*',
  'patch_*',
  'bash',
  'shell',
  'terminal',
  'apply_*',
  'insert_*',
  'replace_*',
  'move_*',
  'rename_*',
  'mkdir_*',
  'touch_*',
];

export const DEFAULT_CONFIG: StreamConfig = {
  maxTokens: 25000,
  chunkSize: 10000,
  ttl: 3600,
  cacheDir: '~/.mcp-cache/cache',
  enableIndexing: true,
  compression: true,
  debug: false,
  toolTtls: {
    // Stable content — cache aggressively
    read_file: 86400,         // 24h
    get_file_contents: 86400,
    // Listings change occasionally
    list_files: 3600,         // 1h
    list_directory: 3600,
    list_responses: 300,
    // Search results are session-specific
    search_files: 1800,       // 30min
    search_code: 1800,
    grep: 1800,
    // External/live data
    web_search: 300,          // 5min
    fetch: 300,
    http_request: 300,
  },
  alwaysFreshPatterns: [],
  loopThreshold: 4,
  loopWindowMs: 60_000,
  dedupMinBytes: 200,
};
