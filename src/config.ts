/**
 * Configuration manager for mcp-cache
 */

import { homedir } from 'os';
import { join } from 'path';
import { StreamConfig, DEFAULT_CONFIG, CLIENT_PRESETS, ClientInfo } from './types.js';

export class ConfigManager {
  private config: StreamConfig;

  constructor(clientInfo?: ClientInfo) {
    this.config = this.loadConfig(clientInfo);
  }

  private loadConfig(clientInfo?: ClientInfo): StreamConfig {
    const config = { ...DEFAULT_CONFIG };

    // 1. Apply client-specific presets
    if (clientInfo) {
      const clientName = clientInfo.name;
      config.maxTokens = CLIENT_PRESETS[clientName] || CLIENT_PRESETS['default'];
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

  getCacheDir(): string {
    return this.config.cacheDir;
  }

  isDebug(): boolean {
    return this.config.debug;
  }
}