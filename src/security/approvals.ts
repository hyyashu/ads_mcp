import { and, eq, lt, sql } from "drizzle-orm";
import type { VerifyResult } from "../mcp/tool";
import type { Role } from "../auth/context";
import type { Db } from "../db";
import { approvalRequest } from "../db/schema";
import { ToolError } from "../mcp/errors";
import type { Risk } from "../mcp/tool";
import { audit } from "./audit";
import { hashArgs, sha256 } from "./canonical";

type ApprovalRow = typeof approvalRequest.$inferSelect;
export type WriteRisk = Exclude<Risk, "read">;

export interface ApprovalOptions {
  now?: () => Date;
  /** How long a request stays approvable. */
  ttlMs?: number;
  /** Identical requests inside this window are the same mutation (idempotency). */
  dedupeWindowMs?: number;
  /** Requests stuck "executing" longer than this are marked unknown_outcome, never retried. */
  stuckAfterMs?: number;
}

/** Outcomes of an executor: a definite result, or a ToolError saying whether the mutation may have happened. */
export type Executor = (row: ApprovalRow) => Promise<unknown>;

const MAX_CHECKS = 20;
const APPROVER_ROLES: Role[] = ["owner", "admin"];
/** Errors that prove nothing was changed. Anything else after a send is an unknown outcome. */
const DEFINITE_FAILURE = new Set(["invalid_argument", "platform_permission_denied", "not_found", "auth_expired", "quota_exceeded", "conflict", "unsupported", "permission_denied"]);

export class ApprovalService {
  private now: () => Date;
  private ttlMs: number;
  private dedupeMs: number;
  private stuckMs: number;

  constructor(
    private db: Db,
    opts: ApprovalOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? 24 * 3600_000;
    this.dedupeMs = opts.dedupeWindowMs ?? 10 * 60_000;
    this.stuckMs = opts.stuckAfterMs ?? 10 * 60_000;
  }

  /**
   * Queues a mutation for approval. The same tenant+account+tool+arguments yields the same
   * idempotency key, so a retried or duplicated request returns the existing row instead of creating a second mutation.
   */
  async request(o: {
    tenantId: string;
    accountId: string;
    tool: string;
    risk: WriteRisk;
    args: unknown;
    summary: string;
    snapshot?: unknown;
    requestedBy: string;
  }): Promise<{ row: ApprovalRow; deduplicated: boolean }> {
    const argsHash = hashArgs(o.args);
    const key = sha256(`${o.tenantId}|${o.accountId}|${o.tool}|${argsHash}`);
    const now = this.now();

    return this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(approvalRequest).where(eq(approvalRequest.idempotencyKey, key));
      if (existing) {
        const age = now.getTime() - existing.createdAt.getTime();
        const live = existing.status === "pending" && existing.expiresAt > now;
        if (live || existing.status === "executing") return { row: existing, deduplicated: true };
        if (existing.status === "executed" && age < this.dedupeMs) return { row: existing, deduplicated: true };
        if (existing.status === "unknown_outcome") {
          throw new ToolError("conflict", "A previous attempt at this exact change has an unconfirmed outcome. Check the ad platform, then change the arguments or resolve it before retrying.");
        }
        // Finished long ago, rejected, failed or expired: free the key so the change can be requested again.
        await tx.update(approvalRequest).set({ idempotencyKey: `${key}:${existing.id}` }).where(eq(approvalRequest.id, existing.id));
      }
      const [row] = await tx
        .insert(approvalRequest)
        .values({
          tenantId: o.tenantId,
          accountId: o.accountId,
          tool: o.tool,
          risk: o.risk,
          args: o.args as object,
          argsHash,
          summary: o.summary,
          planSnapshot: (o.snapshot ?? null) as object | null,
          idempotencyKey: key,
          requestedBy: o.requestedBy,
          // One clock for every comparison (age, expiry): never mix the app clock with the database clock.
          createdAt: now,
          expiresAt: new Date(now.getTime() + this.ttlMs),
        })
        .returning();
      return { row: row!, deduplicated: false };
    });
  }

  /** Approve (and execute) or reject. The decision is verified here, on the server, from the authenticated caller. */
  async decide(o: {
    tenantId: string;
    approvalId: string;
    decider: { userId: string; role: Role };
    decision: "approve" | "reject";
    execute: Executor;
  }): Promise<ApprovalRow> {
    const now = this.now();
    const [row] = await this.db
      .select()
      .from(approvalRequest)
      .where(and(eq(approvalRequest.id, o.approvalId), eq(approvalRequest.tenantId, o.tenantId)));
    if (!row) throw new ToolError("not_found", "No such approval request.");
    if (!APPROVER_ROLES.includes(o.decider.role)) throw new ToolError("permission_denied", "Only owners and admins can approve or reject changes.");
    if (row.risk !== "write" && row.requestedBy === o.decider.userId) {
      throw new ToolError("permission_denied", "High-impact and destructive changes must be approved by someone other than the requester.");
    }
    if (row.status === "pending" && row.expiresAt <= now) {
      await this.db.update(approvalRequest).set({ status: "expired" }).where(and(eq(approvalRequest.id, row.id), eq(approvalRequest.status, "pending")));
      throw new ToolError("conflict", "This approval request expired. Request the change again.");
    }

    // Atomic claim: only one caller can move pending -> executing/rejected.
    const [claimed] = await this.db
      .update(approvalRequest)
      .set({
        status: o.decision === "approve" ? "executing" : "rejected",
        decidedBy: o.decider.userId,
        decidedAt: now,
        executingSince: o.decision === "approve" ? now : null,
      })
      .where(and(eq(approvalRequest.id, row.id), eq(approvalRequest.tenantId, o.tenantId), eq(approvalRequest.status, "pending")))
      .returning();
    if (!claimed) throw new ToolError("conflict", `This request is already ${row.status}.`);

    await audit(this.db, { tenantId: o.tenantId, userId: o.decider.userId, event: `approval.${o.decision}`, tool: row.tool, accountId: row.accountId, refId: row.id });
    if (o.decision === "reject") return claimed;

    let status: string;
    let result: unknown;
    try {
      result = await o.execute(claimed);
      status = "executed";
    } catch (e) {
      const err = e instanceof ToolError ? e : new ToolError("internal", "Execution failed");
      // `definite`: the executor proved no change was sent to the platform, so whatever the error, nothing happened.
      status = DEFINITE_FAILURE.has(err.code) || err.opts.definite ? "failed" : "unknown_outcome";
      result = { error: { code: err.code, message: err.message } };
    }
    const [done] = await this.db
      .update(approvalRequest)
      .set({ status, result: result as object, executingSince: null })
      .where(eq(approvalRequest.id, row.id))
      .returning();
    await audit(this.db, { tenantId: o.tenantId, userId: o.decider.userId, event: `approval.${status}`, tool: row.tool, accountId: row.accountId, refId: row.id, outcome: status });
    return done!;
  }

  /** Crash recovery. A request stuck "executing" is never retried: the mutation may or may not have happened. */
  async recoverStuck(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - this.stuckMs);
    const rows = await this.db
      .update(approvalRequest)
      .set({ status: "unknown_outcome", executingSince: null, result: sql`'{"error":{"code":"unknown_outcome","message":"The server stopped while applying this change. Check the ad platform before retrying."}}'::jsonb` })
      .where(and(eq(approvalRequest.status, "executing"), lt(approvalRequest.executingSince, cutoff)))
      .returning({ id: approvalRequest.id });
    return rows.length;
  }

  /**
   * Reconciles requests whose outcome is unknown by asking the platform what actually happened. It never re-sends a
   * mutation: `not_applied` only frees the request so a human can approve it again; `applied` records the truth.
   * Checks back off exponentially and stop after MAX_CHECKS (the request is then left for manual review).
   */
  async reconcileUnknown(verify: (row: ApprovalRow) => Promise<VerifyResult>, o: { minAgeMs?: number; limit?: number } = {}): Promise<{ applied: number; notApplied: number; indeterminate: number; skipped: number }> {
    const now = this.now();
    const rows = await this.db.select().from(approvalRequest).where(eq(approvalRequest.status, "unknown_outcome")).limit(o.limit ?? 50);
    const tally = { applied: 0, notApplied: 0, indeterminate: 0, skipped: 0 };

    for (const row of rows) {
      const meta = ((row.result as { reconcile?: { checks: number; last: string } } | null)?.reconcile ?? { checks: 0, last: "" }) as { checks: number; last: string };
      const waitMs = Math.min(6 * 3600_000, (o.minAgeMs ?? 60_000) * 2 ** meta.checks);
      const since = meta.last ? now.getTime() - new Date(meta.last).getTime() : Number.POSITIVE_INFINITY;
      if (meta.checks >= MAX_CHECKS || since < waitMs || (row.decidedAt && now.getTime() - row.decidedAt.getTime() < (o.minAgeMs ?? 60_000))) {
        tally.skipped++;
        continue;
      }
      let res: VerifyResult;
      try {
        res = await verify(row);
      } catch {
        res = { outcome: "indeterminate", detail: "verification failed" };
      }
      const base = (row.result ?? {}) as Record<string, unknown>;
      const reconcile = { checks: meta.checks + 1, last: now.toISOString(), outcome: res.outcome, ...(res.detail ? { detail: res.detail.slice(0, 200) } : {}) };
      const status = res.outcome === "applied" ? "executed" : res.outcome === "not_applied" ? "not_applied" : "unknown_outcome";
      // Compare-and-set on status so a concurrent change is never overwritten.
      const [done] = await this.db
        .update(approvalRequest)
        .set({ status, result: { ...base, reconcile } as object })
        .where(and(eq(approvalRequest.id, row.id), eq(approvalRequest.status, "unknown_outcome")))
        .returning({ id: approvalRequest.id });
      if (!done) continue;
      if (res.outcome === "applied") tally.applied++;
      else if (res.outcome === "not_applied") tally.notApplied++;
      else tally.indeterminate++;
      await audit(this.db, { tenantId: row.tenantId, event: "approval.reconciled", tool: row.tool, accountId: row.accountId, refId: row.id, outcome: res.outcome });
    }
    return tally;
  }

  async get(tenantId: string, approvalId: string) {
    const [row] = await this.db.select().from(approvalRequest).where(and(eq(approvalRequest.id, approvalId), eq(approvalRequest.tenantId, tenantId)));
    return row ?? null;
  }
}
