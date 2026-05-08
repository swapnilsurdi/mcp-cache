/**
 * Loop detector / circuit breaker for mcp-cache.
 * Tracks call frequency for non-cacheable (always-fresh) tool calls
 * and breaks the circuit when the same call repeats suspiciously fast.
 *
 * This prevents the autocompact-loop pattern where repeated identical
 * tool calls burn tokens exponentially (e.g., the "$235 in 4 days" incident).
 */

import { createHash } from 'crypto';

interface CallWindow {
  timestamps: number[];
}

export interface LoopCheckResult {
  blocked: boolean;
  count: number;
  hash: string;
  message?: string;
}

export class LoopDetector {
  private readonly calls = new Map<string, CallWindow>();
  private readonly threshold: number;
  private readonly windowMs: number;

  constructor(threshold = 4, windowMs = 60_000) {
    this.threshold = threshold;
    this.windowMs = windowMs;
  }

  /**
   * Compute a canonical hash for a (tool, args) pair.
   * Args are deep-sorted so {b:2, a:1} === {a:1, b:2}.
   */
  hashCall(tool: string, args: unknown): string {
    const canonical = JSON.stringify([tool, deepSort(args)]);
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  /**
   * Record a call and check if the circuit should trip.
   * Returns blocked=true when threshold is exceeded within the window.
   */
  check(tool: string, args: unknown): LoopCheckResult {
    const hash = this.hashCall(tool, args);
    const now = Date.now();
    const windowStart = now - this.windowMs;

    const window = this.calls.get(hash) ?? { timestamps: [] };
    window.timestamps = window.timestamps.filter(t => t >= windowStart);
    window.timestamps.push(now);
    this.calls.set(hash, window);

    const count = window.timestamps.length;
    const blocked = count >= this.threshold;

    return {
      blocked,
      count,
      hash,
      ...(blocked ? {
        message:
          `[mcp-cache] Circuit breaker triggered: "${tool}" called ${count} times ` +
          `within ${Math.round(this.windowMs / 1000)}s with identical arguments. ` +
          `This looks like an infinite loop. ` +
          `If you need fresh data, wait ${Math.round(this.windowMs / 1000)}s or call reset_loop("${hash}"). ` +
          `If results are cached, use query_response or get_chunk instead.`,
      } : {}),
    };
  }

  /** Manually reset the circuit for a specific call signature. */
  reset(hashOrTool: string, args?: unknown): void {
    if (args !== undefined) {
      this.calls.delete(this.hashCall(hashOrTool, args));
    } else {
      // treat first arg as a hash directly
      this.calls.delete(hashOrTool);
    }
  }

  getActiveCircuits(): Array<{ hash: string; count: number }> {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const result: Array<{ hash: string; count: number }> = [];

    for (const [hash, window] of this.calls.entries()) {
      const active = window.timestamps.filter(t => t >= windowStart).length;
      if (active > 0) result.push({ hash, count: active });
    }

    return result.sort((a, b) => b.count - a.count);
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
