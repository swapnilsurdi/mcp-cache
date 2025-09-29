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
  ttl: number; // seconds
  cacheDir: string;
  enableIndexing: boolean;
  compression: boolean;
  debug: boolean;
}

export interface CachedResponse {
  id: string;
  tool: string;
  data: any;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
  client: string;
  chunks: number;
  indexed: boolean;
}

export interface ResponseMetadata {
  id: string;
  tool: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
  client: string;
  chunks: number;
  indexed: boolean;
}

export interface QueryOptions {
  mode?: 'text' | 'jsonpath' | 'regex';
  limit?: number;
  offset?: number;
  contextLines?: number; // Lines of context before/after match
  caseSensitive?: boolean; // Default: false
}

export const CLIENT_PRESETS: Record<string, number> = {
  'claude-ai': 25000,
  'claude-code': 25000,
  'cursor': 30000,
  'cline': 25000,
  'default': 20000
};

export const DEFAULT_CONFIG: StreamConfig = {
  maxTokens: 25000,
  chunkSize: 10000,
  ttl: 3600, // 1 hour
  cacheDir: '~/.mcp-cache/cache',
  enableIndexing: true,
  compression: true,
  debug: false
};