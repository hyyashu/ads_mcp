import { sql } from "drizzle-orm";
import type { Db } from "../db";
import type { Limiter, LimitResult } from "./rate-limit";

/**
 * Token bucket stored in Postgres, so the limit holds across all instances. One atomic statement refills the
 * bucket and takes tokens only if enough are available; concurrent callers cannot both win the last token.
 * The database clock is the single time source (an override exists for tests).
 */
export class DbRateLimiter implements Limiter {
  constructor(
    private db: Db,
    private o: { namespace: string; capacity: number; refillPerSecond: number; now?: () => Date },
  ) {}

  async take(key: string, cost = 1): Promise<LimitResult> {
    const k = `${this.o.namespace}:${key}`;
    const { capacity: cap, refillPerSecond: rate } = this.o;
    const nowParam = this.o.now ? this.o.now().toISOString() : null;
    const clock = sql`coalesce(${nowParam}::timestamptz, clock_timestamp())`;

    const res = await this.db.execute(sql`
      INSERT INTO rate_limit_bucket (key, tokens, updated_at)
      VALUES (${k}, ${cap - cost}, ${clock})
      ON CONFLICT (key) DO UPDATE
        SET tokens = LEAST(${cap}::float8, rate_limit_bucket.tokens + GREATEST(0, EXTRACT(EPOCH FROM (${clock} - rate_limit_bucket.updated_at))) * ${rate}::float8) - ${cost}::float8,
            updated_at = ${clock}
        WHERE LEAST(${cap}::float8, rate_limit_bucket.tokens + GREATEST(0, EXTRACT(EPOCH FROM (${clock} - rate_limit_bucket.updated_at))) * ${rate}::float8) >= ${cost}::float8
      RETURNING tokens
    `);
    const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as unknown[];
    if (rows.length > 0) return { ok: true };

    const cur = await this.db.execute(sql`SELECT tokens, EXTRACT(EPOCH FROM (${clock} - updated_at)) AS idle FROM rate_limit_bucket WHERE key = ${k}`);
    const r = ((Array.isArray(cur) ? cur : (cur as { rows?: unknown[] }).rows ?? [])[0] ?? { tokens: 0, idle: 0 }) as { tokens: number; idle: number };
    const have = Math.min(cap, Number(r.tokens) + Math.max(0, Number(r.idle)) * rate);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((cost - have) / rate)) };
  }

  /** Delete buckets that have been idle long enough to be full again. */
  async sweep(idleSeconds = 3600): Promise<void> {
    await this.db.execute(sql`DELETE FROM rate_limit_bucket WHERE key LIKE ${this.o.namespace + ":%"} AND updated_at < clock_timestamp() - (${idleSeconds} * interval '1 second')`);
  }
}
