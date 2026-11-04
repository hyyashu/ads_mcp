import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db";
import * as schema from "../db/schema";
import { JobQueue } from "../jobs/queue";
import { registerSystemJobs } from "../jobs/system";
import { ToolError } from "../mcp/errors";
import type { ApprovalService } from "../security/approvals";
import { testDb } from "./helpers";

let db: Db;
let clock: number;
const now = () => new Date(clock);
const q = (workerId = "w1") => new JobQueue(db, { workerId, now, random: () => 1 });
const jobs = () => db.select().from(schema.job);
const byId = (id: string) => db.select().from(schema.job).where(eq(schema.job.id, id)).then((r) => r[0]!);

beforeEach(async () => {
  db = await testDb();
  clock = Date.parse("2026-11-04T12:00:00Z");
});

describe("job queue", () => {
  it("runs a due job once and marks it done; a job is never run before run_after", async () => {
    let runs = 0;
    const queue = q().register("t.ok", { run: async () => void runs++ });
    const later = await queue.enqueue({ kind: "t.ok", runAfter: new Date(clock + 60_000) });
    expect(await queue.runOnce()).toBe(false);
    clock += 60_000;
    expect(await queue.runOnce()).toBe(true);
    expect(await queue.runOnce()).toBe(false);
    expect(runs).toBe(1);
    expect(await byId(later!.id)).toMatchObject({ status: "done", attempts: 1, leaseUntil: null });
  });

  it("refuses unknown kinds and payloads are stored as given (ids only by convention)", async () => {
    const queue = q().register("t.ok", { run: async () => {} });
    await expect(queue.enqueue({ kind: "t.nope" })).rejects.toThrow(/unknown job kind/);
    expect(() => queue.register("Bad Kind", { run: async () => {} })).toThrow();
    const j = await queue.enqueue({ kind: "t.ok", payload: { account_id: "a1" } });
    expect(j!.payload).toEqual({ account_id: "a1" });
  });

  it("a dedupe key allows one queued or running job; after it finishes another can be queued", async () => {
    const queue = q().register("t.ok", { run: async () => {} });
    expect(await queue.enqueue({ kind: "t.ok", dedupeKey: "k" })).not.toBeNull();
    expect(await queue.enqueue({ kind: "t.ok", dedupeKey: "k" })).toBeNull();
    await queue.runOnce();
    expect(await queue.enqueue({ kind: "t.ok", dedupeKey: "k" })).not.toBeNull();
  });

  it("retries retryable failures with backoff, then fails after max attempts; non-retryable errors fail at once", async () => {
    let n = 0;
    const queue = q()
      .register("t.flaky", { maxAttempts: 3, run: async () => void (n++, (() => { throw new ToolError("transient", "down", { retryable: true }); })()) })
      .register("t.bad", { run: async () => { throw new ToolError("invalid_argument", "no"); } });
    const flaky = await queue.enqueue({ kind: "t.flaky" });
    await queue.runOnce();
    let row = await byId(flaky!.id);
    expect(row).toMatchObject({ status: "queued", attempts: 1, lastError: "transient" });
    expect(row.runAfter.getTime()).toBe(clock + 2_000); // full jitter with random()=1: 1s * 2^attempts
    expect(await queue.runOnce()).toBe(false); // not due yet
    clock += 2_000;
    await queue.runOnce();
    clock += 4_000;
    await queue.runOnce();
    row = await byId(flaky!.id);
    expect(row).toMatchObject({ status: "failed", attempts: 3 });
    expect(n).toBe(3);

    const bad = await queue.enqueue({ kind: "t.bad" });
    await queue.runOnce();
    expect(await byId(bad!.id)).toMatchObject({ status: "failed", attempts: 1, lastError: "invalid_argument" });
  });

  it("two workers never claim the same job", async () => {
    const a = q("a").register("t.ok", { run: async () => {} });
    const b = q("b").register("t.ok", { run: async () => {} });
    for (let i = 0; i < 6; i++) await a.enqueue({ kind: "t.ok" });
    const claimed = await Promise.all([a.claim(), b.claim(), a.claim(), b.claim(), a.claim(), b.claim(), a.claim()]);
    const ids = claimed.filter(Boolean).map((r) => r!.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it("an expired lease is reclaimed by another worker, and the old worker can no longer finish it", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const a = q("a").register("t.slow", { leaseMs: 60_000, run: async () => slow });
    const b = q("b").register("t.slow", { leaseMs: 60_000, run: async () => {} });
    const j = await a.enqueue({ kind: "t.slow" });
    const running = a.runOnce();
    await new Promise((r) => setTimeout(r, 20));
    expect(await b.claim()).toBeNull(); // lease still valid
    clock += 61_000;
    const stolen = await b.claim();
    expect(stolen?.id).toBe(j!.id);
    expect(stolen).toMatchObject({ lockedBy: "b", attempts: 2 });
    release();
    await running;
    expect(await byId(j!.id)).toMatchObject({ status: "running", lockedBy: "b" }); // a's "done" did not overwrite b's claim
  });

  it("the handler is told to stop before its lease runs out", async () => {
    let aborted = false;
    const queue = new JobQueue(db, { workerId: "w", random: () => 1 }).register("t.long", {
      leaseMs: 5_200, // abort fires 5s before expiry, at 200ms
      run: ({ signal }) => new Promise<void>((resolve) => signal.addEventListener("abort", () => ((aborted = true), resolve()))),
    });
    await queue.enqueue({ kind: "t.long" });
    await queue.runOnce();
    expect(aborted).toBe(true);
  });

  it("recurring jobs: one instance however many times scheduled, next run after each run, and a failure keeps the schedule", async () => {
    let fail = false;
    const queue = q().register("t.tick", { everyMs: 60_000, maxAttempts: 1, run: async () => { if (fail) throw new ToolError("internal", "x"); } });
    await queue.ensureRecurring();
    await queue.ensureRecurring();
    await q("other").register("t.tick", { everyMs: 60_000, run: async () => {} }).ensureRecurring();
    expect((await jobs()).filter((j) => j.status === "queued")).toHaveLength(1);
    await queue.runOnce();
    const next = (await jobs()).find((j) => j.status === "queued")!;
    expect(next.runAfter.getTime()).toBe(clock + 60_000);
    fail = true;
    clock += 60_000;
    await queue.runOnce();
    expect((await jobs()).filter((j) => j.status === "failed")).toHaveLength(1);
    expect((await jobs()).filter((j) => j.status === "queued")).toHaveLength(1);
  });

  it("prunes finished jobs older than the retention, keeping queued ones", async () => {
    const queue = q().register("t.ok", { run: async () => {} });
    await queue.enqueue({ kind: "t.ok" });
    await queue.runOnce();
    await queue.enqueue({ kind: "t.ok", runAfter: new Date(clock + 30 * 86_400_000) });
    clock += 8 * 86_400_000;
    expect(await queue.prune(7)).toBe(1);
    expect(await jobs()).toHaveLength(1);
  });

  it("start() drains due jobs and stops cleanly", async () => {
    let runs = 0;
    const queue = new JobQueue(db).register("t.ok", { run: async () => void runs++ });
    for (let i = 0; i < 3; i++) await queue.enqueue({ kind: "t.ok" });
    const w = queue.start({ idleMs: 10 });
    await new Promise((r) => setTimeout(r, 200));
    await w.stop();
    expect(runs).toBe(3);
  });
});

describe("system jobs", () => {
  it("reconcile runs stuck recovery then reconciliation with the verifier; prune jobs are scheduled daily", async () => {
    const order: string[] = [];
    const verifier = async () => ({ outcome: "indeterminate" as const });
    const approvals = {
      recoverStuck: async () => (order.push("recover"), 0),
      reconcileUnknown: async (v: unknown) => (order.push(v === verifier ? "reconcile" : "wrong-verifier"), { applied: 0, notApplied: 0, indeterminate: 0, skipped: 0 }),
    } as unknown as ApprovalService;
    const queue = registerSystemJobs(q(), { db, approvals, verifier });
    await queue.ensureRecurring();
    const kinds = (await jobs()).map((j) => j.kind).sort();
    expect(kinds).toEqual(["system.prune_executions", "system.prune_jobs", "system.reconcile"]);
    while (await queue.runOnce());
    expect(order).toEqual(["recover", "reconcile"]);
    const next = (await jobs()).filter((j) => j.status === "queued");
    expect(next.find((j) => j.kind === "system.reconcile")!.runAfter.getTime()).toBe(clock + 60_000);
    expect(next.find((j) => j.kind === "system.prune_jobs")!.runAfter.getTime()).toBe(clock + 86_400_000);
  });
});
