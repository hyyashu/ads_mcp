export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Anything that can rate-limit by key. In-memory for one instance, database-backed for many. */
export interface Limiter {
  take(key: string, cost?: number): LimitResult | Promise<LimitResult>;
}

/** Token bucket keyed by string (tenant id, or tenant+account). Time is injectable for tests. */
export class RateLimiter implements Limiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private capacity: number,
    private refillPerSecond: number,
    private now: () => number = Date.now,
  ) {}

  take(key: string, cost = 1): LimitResult {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSecond);
    b.at = t;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      this.buckets.set(key, b);
      return { ok: true };
    }
    this.buckets.set(key, b);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((cost - b.tokens) / this.refillPerSecond)) };
  }

  /** Drop idle buckets so the map cannot grow without bound. */
  sweep(idleMs = 10 * 60_000) {
    const cutoff = this.now() - idleMs;
    for (const [k, b] of this.buckets) if (b.at < cutoff) this.buckets.delete(k);
  }
}
