import type { z } from "zod";
import { resolveAccount } from "../auth/accounts";
import type { AuthContext } from "../auth/context";
import type { Db } from "../db";
import { recordExecution, type ExecutionOutcome } from "../obs/executions";
import { logger } from "../obs/logger";
import type { Change, ChangeSet } from "../policy/change-set";
import { loadRules, matchRules } from "../policy/automation";
import { effectiveRisk, riskRank, type WriteRisk } from "../policy/risk";
import { audit, recordUsage } from "../security/audit";
import type { ApprovalService, Executor } from "../security/approvals";
import { canonicalJson } from "../security/canonical";
import type { Limiter } from "../security/rate-limit";
import { type Envelope, approvalEnvelope, errorEnvelope, okEnvelope } from "./envelope";
import { ERROR_CODES, ToolError, toToolError } from "./errors";
import type { ToolRegistry } from "./registry";
import { type AnyTool, type ResolvedAccount, type ToolContext, type VerifyResult, riskOf } from "./tool";

export interface PipelineDeps {
  db: Db;
  registry: ToolRegistry;
  approvals: ApprovalService;
  tenantLimiter: Limiter;
  accountLimiter: Limiter;
  /**
   * Builds the platform clients for one account (decrypts credentials server-side; handlers never see tokens).
   * `signal` aborts upstream requests when the call is cancelled or runs past its deadline.
   */
  /** Overrides for the default deadlines (operator configuration; tests use short ones). */
  timeouts?: Partial<{ call: number; execute: number; verify: number }>;
  createServices(o: { tenantId: string; account: { id: string; platform: string; externalId: string; loginCustomerId: string | null; connectionId: string; currencyCode?: string | null }; signal?: AbortSignal }): Promise<unknown>;
}

/** Default deadlines. Reads and planning are bounded tightly; executing an approved change gets longer. */
export const DEFAULT_TIMEOUT_MS = { call: 30_000, execute: 60_000, verify: 30_000 } as const;

/** The caller's signal combined with a deadline. `timedOut` tells a deadline apart from a client cancellation. */
function withDeadline(parent: AbortSignal, ms: number) {
  const timer = AbortSignal.timeout(ms);
  return { signal: AbortSignal.any([parent, timer]), timedOut: () => timer.aborted };
}

const abortError = (timedOut: boolean, sent: boolean) =>
  timedOut
    ? new ToolError("deadline_exceeded", sent ? "The call ran past its time limit." : "The call ran past its time limit. Nothing was changed; retry or narrow the request.")
    : new ToolError("cancelled", "The call was cancelled.", { retryable: false });

/**
 * Settles as soon as the signal aborts, even if `work` ignores it. ONLY for read-only work: abandoning a mutation this way
 * would report a result while the change might still be sent.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal, timedOut: () => boolean): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(timedOut(), false));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(timedOut(), false));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

async function buildContext(deps: PipelineDeps, tool: AnyTool, args: Record<string, unknown>, auth: { tenantId: string; userId: string }, signal: AbortSignal): Promise<ToolContext> {
  // Tenant-level tools (no ad account) get a database handle; the tool itself must scope every query by ctx.tenantId.
  if (tool.accountScope === "none") return { tenantId: auth.tenantId, userId: auth.userId, account: null, services: { db: deps.db }, signal };
  const accountId = String(args.account_id ?? "");
  const account = await resolveAccount(deps.db, auth.tenantId, accountId, tool.platform, tool.kind === "write");
  const lim = await deps.accountLimiter.take(`${auth.tenantId}:${account.id}`);
  if (!lim.ok) throw new ToolError("quota_exceeded", "Too many requests for this ad account. Slow down and retry.", { retryAfterSeconds: lim.retryAfterSeconds });
  const services = await deps.createServices({ tenantId: auth.tenantId, account, signal });
  return { tenantId: auth.tenantId, userId: auth.userId, account, services, signal };
}

/**
 * Applies a queued request through a workspace rule when one covers its stored change set. Returns the finished row, or
 * null when no rule applies (or the daily cap is reached): the request then simply stays pending for a person.
 */
async function tryAutomation(deps: PipelineDeps, tenantId: string, row: { id: string; risk: string; changeSet: unknown }) {
  const rules = await loadRules(deps.db, tenantId);
  if (!rules.pause.enabled && !rules.budget.enabled) return null;
  const m = matchRules(rules, row.risk as WriteRisk, (row.changeSet as ChangeSet | null) ?? null);
  if (!m.rule) return null;
  return deps.approvals.autoApprove({ tenantId, approvalId: row.id, rule: m.rule, maxPerDay: rules.max_auto_per_day, execute: createExecutor(deps) });
}

/** Risk and stored change set of a planned write: direction-aware when the tool reports its changes. */
function assess(declared: WriteRisk, changes: Change[] | undefined, account: ResolvedAccount): { risk: WriteRisk; changeSet: ChangeSet | null } {
  const { risk, reason } = effectiveRisk(declared, changes);
  if (!changes?.length) return { risk, changeSet: null };
  return { risk, changeSet: { currency_code: account.currencyCode, time_zone: account.timeZone, operations: changes.length, changes, risk_reason: reason } };
}

/** The units block of the response envelope, for account-scoped tools. */
const unitsOf = (a: ResolvedAccount) => ({ id: a.id, currency_code: a.currencyCode, time_zone: a.timeZone });

/**
 * The single path every MCP tool call takes. Never throws: failures come back as structured error envelopes.
 * Every call gets a deadline, carries the request id into the response and logs, and leaves one execution record.
 */
export async function runTool(deps: PipelineDeps, tool: AnyTool, rawArgs: unknown, auth: AuthContext, signal: AbortSignal = new AbortController().signal, requestId?: string): Promise<Envelope> {
  const started = performance.now();
  let outcome: ExecutionOutcome = "error";
  let errorCode: string | null = null;
  let accountId: string | null = null;
  let resolved: ResolvedAccount | null = null;
  let env: Envelope;
  const dl = withDeadline(signal, tool.timeoutMs ?? deps.timeouts?.call ?? DEFAULT_TIMEOUT_MS.call);
  try {
    // 1. authorization: the token must carry the tool's scope
    if (!auth.scopes.includes(tool.permissions.scope)) throw new ToolError("permission_denied", `This token lacks the ${tool.permissions.scope} scope.`);
    // 2. our own per-tenant rate limit
    const t = await deps.tenantLimiter.take(auth.tenantId);
    if (!t.ok) throw new ToolError("quota_exceeded", "Rate limit reached for your workspace. Retry shortly.", { retryAfterSeconds: t.retryAfterSeconds });
    // 3. validate arguments (the transport validated already; this keeps the pipeline safe on its own)
    const parsed = tool.input.safeParse(rawArgs ?? {});
    if (!parsed.success) throw new ToolError("invalid_argument", parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; "));
    const args = parsed.data as Record<string, unknown>;

    // 4-5. resolve the authorized account, then run the read-only part under the deadline
    const ctx = await raceAbort(buildContext(deps, tool, args, auth, dl.signal), dl.signal, dl.timedOut);
    accountId = ctx.account?.id ?? null;
    resolved = ctx.account;

    if (tool.kind === "read") {
      const raw = await raceAbort(Promise.resolve(tool.handler(args, ctx)), dl.signal, dl.timedOut);
      const out = (tool.output as z.ZodType).safeParse(raw);
      if (!out.success) {
        logger.error("tool.output_invalid", { requestId, tool: tool.name, issues: out.error.issues.slice(0, 5).map((i) => i.path.join(".")) });
        throw new ToolError("internal", "The platform response could not be validated, so nothing is returned.");
      }
      outcome = "ok";
      env = okEnvelope(out.data, tool.platform);
    } else {
      // Write: plan against live state (read-only, under the deadline), then queue. Queueing is NOT raced: once started it
      // completes, so the caller is never told "timed out" for a request that was in fact queued.
      const plan = await raceAbort(tool.plan(args, ctx), dl.signal, dl.timedOut);
      const { risk, changeSet } = assess(tool.risk, plan.changes, ctx.account!);
      const { row, deduplicated } = await deps.approvals.request({
        tenantId: auth.tenantId,
        accountId: ctx.account!.id,
        tool: tool.name,
        risk,
        args,
        summary: plan.summary,
        snapshot: plan.snapshot,
        changeSet,
        requestedBy: auth.userId,
      });
      await audit(deps.db, { tenantId: auth.tenantId, userId: auth.userId, event: deduplicated ? "approval.deduplicated" : "approval.requested", tool: tool.name, accountId: ctx.account!.id, refId: row.id });
      // A duplicate of a change that is running or was just applied is not "pending": never tell the caller it is awaiting approval.
      if (row.status === "executing") throw new ToolError("conflict", "This exact change is being applied right now. Nothing new was queued.", { details: { approval_id: row.id } });
      if (row.status === "executed") {
        throw new ToolError("conflict", "This exact change was already approved and applied a few minutes ago, so nothing new was queued. If it has since been reverted, retry in a few minutes or change the arguments.", { details: { approval_id: row.id } });
      }
      // Workspace automation: an owner-configured rule may apply this exact, stored change set without a person.
      const auto = row.status === "pending" ? await tryAutomation(deps, auth.tenantId, row) : null;
      if (auto) {
        if (auto.status !== "executed") {
          const e = (auto.result as { error?: { code?: string; message?: string } } | null)?.error;
          const code = auto.status === "unknown_outcome" ? "unknown_outcome" : ((ERROR_CODES as readonly string[]).includes(e?.code ?? "") ? (e!.code as ToolError["code"]) : "internal");
          throw new ToolError(code, `The workspace rule "${auto.approvedByRule}" approved this change, but applying it ${auto.status === "unknown_outcome" ? "has an unconfirmed outcome: check the ad platform before retrying" : "failed"}. ${e?.message ?? ""}`.trim(), {
            details: { approval_id: auto.id, status: auto.status },
          });
        }
        outcome = "ok";
        env = okEnvelope(auto.result, tool.platform);
        env.meta.auto_approval = { approval_id: auto.id, rule: auto.approvedByRule!, change_set: (auto.changeSet as ChangeSet | null) ?? undefined };
      } else {
        outcome = "approval_pending";
        env = approvalEnvelope(
          {
            approval_id: row.id,
            status: "pending_approval",
            risk: row.risk,
            summary: row.summary,
            expires_at: row.expiresAt.toISOString(),
            ...(row.changeSet ? { change_set: row.changeSet as ChangeSet } : {}),
            message: "Nothing has been changed. An owner or admin must approve this request outside this conversation.",
          },
          tool.platform,
        );
      }
    }
  } catch (e) {
    const err = toToolError(e);
    errorCode = err.code;
    if (err.code === "internal" && !(e instanceof ToolError)) logger.error("tool.internal_error", { requestId, tool: tool.name, error: e });
    env = errorEnvelope(err, tool.platform);
  }
  if (requestId) env.meta.request_id = requestId;
  if (resolved) env.meta.account = unitsOf(resolved);
  const durationMs = performance.now() - started;
  // Counters and execution records: a failure to record must never fail the call.
  recordUsage(deps.db, auth.tenantId, tool.name, outcome === "error").catch(() => {});
  recordExecution(deps.db, { tenantId: auth.tenantId, userId: auth.userId, tool: tool.name, platform: tool.platform, accountId, requestId: requestId ?? null, operation: deps.registry.operationOf(tool.name), outcome, errorCode, durationMs }).catch(() => {});
  if (outcome === "error" && errorCode !== "invalid_argument") logger.warn("tool.failed", { requestId, tool: tool.name, code: errorCode, ms: Math.round(durationMs) });
  return env;
}

/**
 * Executes an approved change. Re-plans against live state first: if the plan's snapshot changed since the
 * request was made, nothing is applied and the requester must ask again (drift protection).
 * The deadline aborts upstream requests through the client's signal; the work itself is never abandoned mid-flight.
 */
export function createExecutor(deps: PipelineDeps): Executor {
  return async (row) => {
    const tool = deps.registry.get(row.tool);
    if (!tool || tool.kind !== "write") throw new ToolError("unsupported", `Tool no longer available: ${row.tool}`);
    let ctx: ToolContext | undefined;
    const executeMs = deps.timeouts?.execute ?? DEFAULT_TIMEOUT_MS.execute;
    const dl = withDeadline(new AbortController().signal, tool.timeoutMs ? Math.max(tool.timeoutMs, executeMs) : executeMs);
    // Platform clients count the changes they actually send. While that count is zero, any failure is a definite failure:
    // nothing reached the ad platform, so it must not be recorded as "unknown outcome" (which blocks re-requesting).
    const nothingSent = () => (ctx?.services as { mutationsSent?: () => number } | undefined)?.mutationsSent?.() === 0;
    try {
      const args = tool.input.parse(row.args) as Record<string, unknown>;
      ctx = await buildContext(deps, tool, args, { tenantId: row.tenantId, userId: row.requestedBy ?? row.decidedBy ?? "" }, dl.signal);
      if (ctx.account?.id !== row.accountId) throw new ToolError("conflict", "The account for this request changed.");
      const fresh = await tool.plan(args, ctx);
      if (canonicalJson(fresh.snapshot ?? null) !== canonicalJson(row.planSnapshot ?? null)) {
        throw new ToolError("conflict", "The ad account changed since this was requested. Nothing was applied; request the change again.");
      }
      // Belt and braces: the approval was granted for a risk level. If the same change now assesses higher (it should not
      // while the snapshot is unchanged), the approval does not cover it.
      if (riskRank(assess(tool.risk, fresh.changes, ctx.account!).risk) > riskRank(row.risk as WriteRisk)) {
        throw new ToolError("conflict", "This change is now riskier than when it was approved. Nothing was applied; request it again.");
      }
      const raw = await tool.execute(args, ctx, { idempotencyKey: row.idempotencyKey, snapshot: row.planSnapshot });
      const out = (tool.output as z.ZodType).safeParse(raw);
      if (!out.success) throw new ToolError("unknown_outcome", "The change was sent but the platform response could not be validated. Verify it in the ad platform.");
      return out.data;
    } catch (e) {
      if (!nothingSent()) throw e;
      if (!(e instanceof ToolError)) logger.error("executor.error_before_send", { tool: row.tool, approvalId: row.id, error: e });
      const err = dl.signal.aborted ? abortError(dl.timedOut(), false) : e instanceof ToolError ? e : new ToolError("internal", "Unexpected server error. No change was sent to the ad platform.");
      throw new ToolError(err.code, err.message, { ...err.opts, definite: true });
    }
  };
}

/** Builds the function the approval service uses to check platform state for an unknown-outcome request. Read-only. */
export function createVerifier(deps: PipelineDeps): (row: { tool: string; tenantId: string; accountId: string; args: unknown; planSnapshot: unknown; requestedBy: string | null; decidedBy: string | null }) => Promise<VerifyResult> {
  return async (row) => {
    const tool = deps.registry.get(row.tool);
    if (!tool || tool.kind !== "write") return { outcome: "indeterminate", detail: "tool no longer available" };
    const dl = withDeadline(new AbortController().signal, deps.timeouts?.verify ?? DEFAULT_TIMEOUT_MS.verify);
    const args = tool.input.parse(row.args) as Record<string, unknown>;
    const ctx = await raceAbort(buildContext(deps, tool, args, { tenantId: row.tenantId, userId: row.requestedBy ?? row.decidedBy ?? "" }, dl.signal), dl.signal, dl.timedOut);
    return raceAbort(tool.verify(args, ctx, { snapshot: row.planSnapshot }), dl.signal, dl.timedOut);
  };
}
