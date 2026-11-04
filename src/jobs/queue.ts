import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { job } from "../db/schema";
import { toToolError } from "../mcp/errors";
import { logger } from "../obs/logger";

export type JobRow = typeof job.$inferSelect;

export interface JobContext {
  db: Db;
  job: JobRow;
  /** Aborted when the lease is about to expire or the runner stops. Handlers must stop promptly. */
  signal: AbortSignal;
}

export interface JobKind {
  /** Must be safe to run more than once with the same payload (leases can expire under a slow worker). */
  run(ctx: JobContext): Promise<void>;
  /** For recurring system jobs: when set, the next run is scheduled this long after each finished run. */
  everyMs?: number;
  /** Default 5. Retryable failures back off exponentially (full jitter) up to this many attempts. */
  maxAttempts?: number;
  /** Default 5 minutes. */
  leaseMs?: number;
}

export interface QueueOptions {
  workerId?: string;
  now?: () => Date;
  random?: () => number;
}

/**
 * Postgres job queue. Claiming uses FOR UPDATE SKIP LOCKED, so any number of server instances can run workers without
 * coordinating and no job is claimed twice while its lease is valid. Expired leases are reclaimed.
 */
export class JobQueue {
  private kinds = new Map<string, JobKind>();
  readonly workerId: string;
  private now: () => Date;
  private random: () => number;

  constructor(
    private db: Db,
    o: QueueOptions = {},
  ) {
    this.workerId = o.workerId ?? `w-${randomUUID().slice(0, 8)}`;
    this.now = o.now ?? (() => new Date());
    this.random = o.random ?? Math.random;
  }

  register(kind: string, k: JobKind): this {
    if (!/^[a-z][a-z0-9_.]{1,63}$/.test(kind)) throw new Error(`invalid job kind: ${kind}`);
    this.kinds.set(kind, k);
    return this;
  }

  /** Queues a job. With a dedupe key, nothing is queued while another job with that key is queued or running. */
  async enqueue(o: { kind: string; tenantId?: string | null; payload?: Record<string, unknown>; dedupeKey?: string; runAfter?: Date }): Promise<JobRow | null> {
    const k = this.kinds.get(o.kind);
    if (!k) throw new Error(`unknown job kind: ${o.kind}`);
    const [row] = await this.db
      .insert(job)
      .values({ kind: o.kind, tenantId: o.tenantId ?? null, payload: o.payload ?? {}, dedupeKey: o.dedupeKey ?? null, runAfter: o.runAfter ?? this.now(), maxAttempts: k.maxAttempts ?? 5 })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  /** Makes sure every recurring kind has exactly one queued or running instance. Safe to call from every instance. */
  async ensureRecurring(): Promise<void> {
    for (const [kind, k] of this.kinds) if (k.everyMs) await this.enqueue({ kind, dedupeKey: `recurring:${kind}` });
  }

  /** Claims the next due job (or an expired lease), or returns null. */
  async claim(): Promise<JobRow | null> {
    const now = this.now();
    const kinds = [...this.kinds.keys()];
    if (!kinds.length) return null;
    return this.db.transaction(async (tx) => {
      const [next] = await tx
        .select({ id: job.id, kind: job.kind })
        .from(job)
        .where(
          and(
            inArray(job.kind, kinds),
            // Typed column comparisons, not a raw sql`` template: postgres.js refuses a bare Date parameter in raw SQL
            // ("The string argument must be of type string... Received an instance of Date"); PGlite (the tests) accepts it.
            or(and(eq(job.status, "queued"), lte(job.runAfter, now)), and(eq(job.status, "running"), lt(job.leaseUntil, now))),
          ),
        )
        .orderBy(job.runAfter)
        .limit(1)
        .for("update", { skipLocked: true });
      if (!next) return null;
      const leaseMs = this.kinds.get(next.kind)?.leaseMs ?? 5 * 60_000;
      const [row] = await tx
        .update(job)
        .set({ status: "running", leaseUntil: new Date(now.getTime() + leaseMs), lockedBy: this.workerId, attempts: sql`${job.attempts} + 1` })
        .where(eq(job.id, next.id))
        .returning();
      return row ?? null;
    });
  }

  /** Claims and runs one job. Returns false when nothing was due. */
  async runOnce(): Promise<boolean> {
    const row = await this.claim();
    if (!row) return false;
    const k = this.kinds.get(row.kind)!;
    const leaseMs = k.leaseMs ?? 5 * 60_000;
    const ctl = new AbortController();
    // Stop the handler a little before the lease runs out, so another worker never runs it concurrently for long.
    const timer = setTimeout(() => ctl.abort(), Math.max(100, leaseMs - 5_000));
    try {
      await k.run({ db: this.db, job: row, signal: ctl.signal });
      await this.finish(row, "done", null);
      if (k.everyMs) await this.enqueue({ kind: row.kind, dedupeKey: `recurring:${row.kind}`, runAfter: new Date(this.now().getTime() + k.everyMs) });
    } catch (e) {
      const err = toToolError(e);
      const retry = (err.retryable || err.code === "internal" || err.code === "transient") && row.attempts < row.maxAttempts;
      if (retry) {
        const delay = Math.floor(this.random() * 1_000 * 2 ** Math.min(row.attempts, 10));
        await this.db.update(job).set({ status: "queued", runAfter: new Date(this.now().getTime() + delay), leaseUntil: null, lockedBy: null, lastError: err.code }).where(and(eq(job.id, row.id), eq(job.lockedBy, this.workerId)));
      } else {
        await this.finish(row, "failed", err.code);
        // A failed recurring job must not stop the schedule.
        if (k.everyMs) await this.enqueue({ kind: row.kind, dedupeKey: `recurring:${row.kind}`, runAfter: new Date(this.now().getTime() + k.everyMs) });
      }
      logger.warn("job.failed", { kind: row.kind, jobId: row.id, attempt: row.attempts, code: err.code, willRetry: retry });
    } finally {
      clearTimeout(timer);
    }
    return true;
  }

  /** Only the worker that holds the job may finish it (a reclaimed job belongs to its new worker). */
  private async finish(row: JobRow, status: "done" | "failed", lastError: string | null) {
    await this.db
      .update(job)
      .set({ status, finishedAt: this.now(), leaseUntil: null, lastError })
      .where(and(eq(job.id, row.id), eq(job.lockedBy, this.workerId), eq(job.status, "running")));
  }

  /** Deletes finished jobs older than `days`. */
  async prune(days = 7): Promise<number> {
    const cutoff = new Date(this.now().getTime() - days * 86_400_000);
    const rows = await this.db.delete(job).where(and(inArray(job.status, ["done", "failed"]), lt(job.finishedAt, cutoff))).returning({ id: job.id });
    return rows.length;
  }

  /** Runs jobs until stopped: drains due jobs, then waits `idleMs`. */
  start(o: { idleMs?: number } = {}): { stop: () => Promise<void> } {
    let stopped = false;
    let wake: (() => void) | undefined;
    const loop = (async () => {
      await this.ensureRecurring().catch((e) => logger.warn("job.ensure_failed", { error: e }));
      while (!stopped) {
        let worked = false;
        try {
          worked = await this.runOnce();
        } catch (e) {
          logger.warn("job.loop_error", { error: e });
        }
        if (!worked && !stopped) await new Promise<void>((r) => ((wake = r), setTimeout(r, o.idleMs ?? 5_000).unref?.()));
      }
    })();
    return {
      stop: async () => {
        stopped = true;
        wake?.();
        await loop;
      },
    };
  }
}
