import type { z } from "zod";
import { resolveAccount } from "../auth/accounts";
import type { AuthContext } from "../auth/context";
import type { Db } from "../db";
import { audit, recordUsage } from "../security/audit";
import type { ApprovalService, Executor } from "../security/approvals";
import { canonicalJson } from "../security/canonical";
import type { Limiter } from "../security/rate-limit";
import { type Envelope, approvalEnvelope, errorEnvelope, okEnvelope } from "./envelope";
import { ToolError, redact, toToolError } from "./errors";
import type { ToolRegistry } from "./registry";
import { type AnyTool, type ToolContext, type VerifyResult, riskOf } from "./tool";

export interface PipelineDeps {
  db: Db;
  registry: ToolRegistry;
  approvals: ApprovalService;
  tenantLimiter: Limiter;
  accountLimiter: Limiter;
  /** Builds the platform clients for one account (decrypts credentials server-side; handlers never see tokens). */
  createServices(o: { tenantId: string; account: { id: string; platform: string; externalId: string; loginCustomerId: string | null; connectionId: string } }): Promise<unknown>;
}

async function buildContext(deps: PipelineDeps, tool: AnyTool, args: Record<string, unknown>, auth: { tenantId: string; userId: string }, signal: AbortSignal): Promise<ToolContext> {
  // Tenant-level tools (no ad account) get a database handle; the tool itself must scope every query by ctx.tenantId.
  if (tool.accountScope === "none") return { tenantId: auth.tenantId, userId: auth.userId, account: null, services: { db: deps.db }, signal };
  const accountId = String(args.account_id ?? "");
  const account = await resolveAccount(deps.db, auth.tenantId, accountId, tool.platform, tool.kind === "write");
  const lim = await deps.accountLimiter.take(`${auth.tenantId}:${account.id}`);
  if (!lim.ok) throw new ToolError("quota_exceeded", "Too many requests for this ad account. Slow down and retry.", { retryAfterSeconds: lim.retryAfterSeconds });
  const services = await deps.createServices({ tenantId: auth.tenantId, account });
  return { tenantId: auth.tenantId, userId: auth.userId, account, services, signal };
}

/** The single path every MCP tool call takes. Never throws: failures come back as structured error envelopes. */
export async function runTool(deps: PipelineDeps, tool: AnyTool, rawArgs: unknown, auth: AuthContext, signal: AbortSignal = new AbortController().signal): Promise<Envelope> {
  let failed = false;
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
    // 4. resolve the authorized account and build platform clients
    const ctx = await buildContext(deps, tool, args, auth, signal);

    if (tool.kind === "read") {
      const raw = await tool.handler(args, ctx);
      const out = (tool.output as z.ZodType).safeParse(raw);
      if (!out.success) {
        console.error(`[${tool.name}] response failed validation: ${out.error.message.slice(0, 300)}`);
        throw new ToolError("internal", "The platform response could not be validated, so nothing is returned.");
      }
      return okEnvelope(out.data, tool.platform);
    }

    // Write: plan against live state (read-only), then queue. Nothing is changed here.
    const plan = await tool.plan(args, ctx);
    const { row, deduplicated } = await deps.approvals.request({
      tenantId: auth.tenantId,
      accountId: ctx.account!.id,
      tool: tool.name,
      risk: riskOf(tool) as Exclude<ReturnType<typeof riskOf>, "read">,
      args,
      summary: plan.summary,
      snapshot: plan.snapshot,
      requestedBy: auth.userId,
    });
    await audit(deps.db, { tenantId: auth.tenantId, userId: auth.userId, event: deduplicated ? "approval.deduplicated" : "approval.requested", tool: tool.name, accountId: ctx.account!.id, refId: row.id });
    // A duplicate of a change that is running or was just applied is not "pending": never tell the caller it is awaiting approval.
    if (row.status === "executing") throw new ToolError("conflict", "This exact change is being applied right now. Nothing new was queued.", { details: { approval_id: row.id } });
    if (row.status === "executed") {
      throw new ToolError("conflict", "This exact change was already approved and applied a few minutes ago, so nothing new was queued. If it has since been reverted, retry in a few minutes or change the arguments.", { details: { approval_id: row.id } });
    }
    return approvalEnvelope(
      {
        approval_id: row.id,
        status: "pending_approval",
        risk: row.risk,
        summary: row.summary,
        expires_at: row.expiresAt.toISOString(),
        message: "Nothing has been changed. An owner or admin must approve this request outside this conversation.",
      },
      tool.platform,
    );
  } catch (e) {
    failed = true;
    const err = toToolError(e);
    if (err.code === "internal") console.error(`[${tool.name}] internal error:`, e instanceof Error ? redact(e.stack ?? e.message) : e);
    return errorEnvelope(err, tool.platform);
  } finally {
    // Counters only; a failure to record usage must never fail the call.
    recordUsage(deps.db, auth.tenantId, tool.name, failed).catch(() => {});
  }
}

/**
 * Executes an approved change. Re-plans against live state first: if the plan's snapshot changed since the
 * request was made, nothing is applied and the requester must ask again (drift protection).
 */
export function createExecutor(deps: PipelineDeps): Executor {
  return async (row) => {
    const tool = deps.registry.get(row.tool);
    if (!tool || tool.kind !== "write") throw new ToolError("unsupported", `Tool no longer available: ${row.tool}`);
    let ctx: ToolContext | undefined;
    // Platform clients count the changes they actually send. While that count is zero, any failure is a definite failure:
    // nothing reached the ad platform, so it must not be recorded as "unknown outcome" (which blocks re-requesting).
    const nothingSent = () => (ctx?.services as { mutationsSent?: () => number } | undefined)?.mutationsSent?.() === 0;
    try {
      const args = tool.input.parse(row.args) as Record<string, unknown>;
      ctx = await buildContext(deps, tool, args, { tenantId: row.tenantId, userId: row.requestedBy ?? row.decidedBy ?? "" }, new AbortController().signal);
      if (ctx.account?.id !== row.accountId) throw new ToolError("conflict", "The account for this request changed.");
      const fresh = await tool.plan(args, ctx);
      if (canonicalJson(fresh.snapshot ?? null) !== canonicalJson(row.planSnapshot ?? null)) {
        throw new ToolError("conflict", "The ad account changed since this was requested. Nothing was applied; request the change again.");
      }
      const raw = await tool.execute(args, ctx, { idempotencyKey: row.idempotencyKey, snapshot: row.planSnapshot });
      const out = (tool.output as z.ZodType).safeParse(raw);
      if (!out.success) throw new ToolError("unknown_outcome", "The change was sent but the platform response could not be validated. Verify it in the ad platform.");
      return out.data;
    } catch (e) {
      if (!nothingSent()) throw e;
      if (!(e instanceof ToolError)) console.error(`[${row.tool}] executor error before any change was sent:`, e instanceof Error ? redact(e.stack ?? e.message) : e);
      const err = e instanceof ToolError ? e : new ToolError("internal", "Unexpected server error. No change was sent to the ad platform.");
      throw new ToolError(err.code, err.message, { ...err.opts, definite: true });
    }
  };
}

/** Builds the function the approval service uses to check platform state for an unknown-outcome request. Read-only. */
export function createVerifier(deps: PipelineDeps): (row: { tool: string; tenantId: string; accountId: string; args: unknown; planSnapshot: unknown; requestedBy: string | null; decidedBy: string | null }) => Promise<VerifyResult> {
  return async (row) => {
    const tool = deps.registry.get(row.tool);
    if (!tool || tool.kind !== "write") return { outcome: "indeterminate", detail: "tool no longer available" };
    const args = tool.input.parse(row.args) as Record<string, unknown>;
    const ctx = await buildContext(deps, tool, args, { tenantId: row.tenantId, userId: row.requestedBy ?? row.decidedBy ?? "" }, new AbortController().signal);
    return tool.verify(args, ctx, { snapshot: row.planSnapshot });
  };
}
