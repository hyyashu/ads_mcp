import { lt } from "drizzle-orm";
import type { Db } from "../db";
import { toolExecution } from "../db/schema";

export type ExecutionOutcome = "ok" | "approval_pending" | "error";

/**
 * One row per tool call: who, what, how long, how it ended. Never arguments, results or ad text. Short retention (see
 * pruneExecutions). A failure to record must never fail the call itself, so callers fire and forget.
 */
export async function recordExecution(
  db: Db,
  e: { tenantId: string; userId: string; tool: string; platform: string; accountId: string | null; requestId: string | null; operation: string; outcome: ExecutionOutcome; errorCode: string | null; durationMs: number },
) {
  await db.insert(toolExecution).values({ ...e, durationMs: Math.max(0, Math.round(e.durationMs)) });
}

/** Deletes execution records older than `days`. Run daily. */
export async function pruneExecutions(db: Db, days = 30, now = new Date()) {
  const rows = await db.delete(toolExecution).where(lt(toolExecution.createdAt, new Date(now.getTime() - days * 86_400_000))).returning({ id: toolExecution.id });
  return rows.length;
}
