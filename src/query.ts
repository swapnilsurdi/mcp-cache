/**
 * Query engine for cached responses
 */

import { JSONPath } from 'jsonpath-plus';
import { QueryOptions } from './types.js';

export class QueryEngine {
  /**
   * Query a response with various modes
   */
  query(data: any, query: string, options: QueryOptions = {}): any {
    const mode = options.mode || this.detectMode(query);

    switch (mode) {
      case 'jsonpath':
        return this.queryJsonPath(data, query, options);
      case 'regex':
        return this.queryRegex(data, query, options);
      case 'text':
      default:
        return this.queryText(data, query, options);
    }
  }

  /**
   * Auto-detect query mode based on pattern
   */
  private detectMode(query: string): 'text' | 'jsonpath' | 'regex' {
    if (query.startsWith('$')) return 'jsonpath';
    if (query.startsWith('/') && query.endsWith('/')) return 'regex';
    return 'text';
  }

  /**
   * JSONPath query
   */
  private queryJsonPath(data: any, query: string, options: QueryOptions): any {
    try {
      const results = JSONPath({ path: query, json: data });
      return this.applyPagination(results, options);
    } catch (error) {
      throw new Error(`JSONPath query failed: ${(error as Error).message}`);
    }
  }

  /**
   * Regex query on stringified data
   */
  private queryRegex(data: any, query: string, options: QueryOptions): any {
    try {
      // Remove leading/trailing slashes
      const pattern = query.slice(1, -1);
      const regex = new RegExp(pattern, 'g');

      const dataStr = JSON.stringify(data, null, 2);
      const matches: string[] = [];
      let match;

      while ((match = regex.exec(dataStr)) !== null) {
        matches.push(match[0]);
      }

      return this.applyPagination(matches, options);
    } catch (error) {
      throw new Error(`Regex query failed: ${(error as Error).message}`);
    }
  }

  /**
   * Simple text search
   */
  private queryText(data: any, query: string, options: QueryOptions): any {
    const dataStr = JSON.stringify(data, null, 2);
    const lines = dataStr.split('\n');
    const matchingLines: Array<{ line: number; content: string }> = [];

    const lowerQuery = query.toLowerCase();

    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(lowerQuery)) {
        matchingLines.push({
          line: index + 1,
          content: line.trim()
        });
      }
    });

    return this.applyPagination(matchingLines, options);
  }

  /**
   * Apply pagination to results
   */
  private applyPagination(results: any[], options: QueryOptions): any {
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const paginated = results.slice(offset, offset + limit);

    return {
      results: paginated,
      total: results.length,
      limit,
      offset,
      hasMore: offset + limit < results.length
    };
  }

  /**
   * Extract chunk from data
   */
  extractChunk(data: any, chunkNumber: number, chunkSize: number): any {
    const dataStr = JSON.stringify(data, null, 2);
    const totalChunks = Math.ceil(dataStr.length / chunkSize);

    if (chunkNumber < 0 || chunkNumber >= totalChunks) {
      throw new Error(`Invalid chunk number. Valid range: 0-${totalChunks - 1}`);
    }

    const start = chunkNumber * chunkSize;
    const end = Math.min(start + chunkSize, dataStr.length);
    const chunk = dataStr.slice(start, end);

    return {
      chunk,
      chunkNumber,
      totalChunks,
      chunkSize: chunk.length,
      hasMore: chunkNumber < totalChunks - 1
    };
  }
}