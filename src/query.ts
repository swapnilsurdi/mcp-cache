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
      // Remove leading/trailing slashes and extract flags
      const lastSlash = query.lastIndexOf('/');
      const pattern = query.slice(1, lastSlash);
      const flags = query.slice(lastSlash + 1) || 'gi'; // Default to case-insensitive

      const regex = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');

      const dataStr = JSON.stringify(data, null, 2);
      const lines = dataStr.split('\n');
      const matches: Array<{ line: number; content: string; match: string; chunk?: number }> = [];

      lines.forEach((line, index) => {
        const lineMatches = line.match(regex);
        if (lineMatches) {
          matches.push({
            line: index + 1,
            content: line.trim(),
            match: lineMatches[0],
            chunk: Math.floor((index * 100) / lines.length) // Approximate chunk %
          });
        }
      });

      return this.applyPaginationWithContext(matches, lines, options);
    } catch (error) {
      throw new Error(`Regex query failed: ${(error as Error).message}`);
    }
  }

  /**
   * Simple text search with improved matching
   */
  private queryText(data: any, query: string, options: QueryOptions): any {
    const dataStr = JSON.stringify(data, null, 2);
    const lines = dataStr.split('\n');
    const matchingLines: Array<{ line: number; content: string; chunk?: number; context?: { before: string[]; after: string[] } }> = [];

    const caseSensitive = options.caseSensitive ?? false;
    const searchQuery = caseSensitive ? query : query.toLowerCase();

    lines.forEach((line, index) => {
      const searchLine = caseSensitive ? line : line.toLowerCase();

      if (searchLine.includes(searchQuery)) {
        matchingLines.push({
          line: index + 1,
          content: line.trim(),
          chunk: Math.floor((index * 100) / lines.length) // Approximate chunk %
        });
      }
    });

    return this.applyPaginationWithContext(matchingLines, lines, options);
  }

  /**
   * Apply pagination with context to results
   */
  private applyPaginationWithContext(
    matches: Array<{ line: number; content: string; chunk?: number; match?: string }>,
    allLines: string[],
    options: QueryOptions
  ): any {
    const contextLines = options.contextLines ?? 2; // Default 2 lines of context

    // Add context to each match
    const matchesWithContext = matches.map(match => {
      const lineIndex = match.line - 1;
      const before: string[] = [];
      const after: string[] = [];

      // Get context before
      for (let i = Math.max(0, lineIndex - contextLines); i < lineIndex; i++) {
        before.push(allLines[i].trim());
      }

      // Get context after
      for (let i = lineIndex + 1; i <= Math.min(allLines.length - 1, lineIndex + contextLines); i++) {
        after.push(allLines[i].trim());
      }

      return {
        ...match,
        context: {
          before,
          after
        }
      };
    });

    const limit = options.limit || 100;
    const offset = options.offset || 0;
    const paginated = matchesWithContext.slice(offset, offset + limit);

    return {
      results: paginated,
      total: matches.length,
      limit,
      offset,
      hasMore: offset + limit < matches.length
    };
  }

  /**
   * Apply pagination to results (for JSONPath)
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