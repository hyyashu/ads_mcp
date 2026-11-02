import { sql } from "drizzle-orm";
import type { Db } from "../db";
import { auditLog, usageCounter } from "../db/schema";

/** Minimal by design: who/what/outcome. Never arguments, results, ad text or credentials. */
export async function audit(
  db: Db,
  e: { tenantId: string; userId?: string; event: string; tool?: string; accountId?: string; refId?: string; outcome?: string },
) {
  await db.insert(auditLog).values({
    tenantId: e.tenantId,
    userId: e.userId ?? null,
    event: e.event,
    tool: e.tool ?? null,
    accountId: e.accountId ?? null,
    refId: e.refId ?? null,
    outcome: e.outcome ?? null,
  });
}

export async function recordUsage(db: Db, tenantId: string, tool: string, isError: boolean, now = new Date()) {
  await db
    .insert(usageCounter)
    .values({ tenantId, day: now.toISOString().slice(0, 10), tool, calls: 1, errors: isError ? 1 : 0 })
    .onConflictDoUpdate({
      target: [usageCounter.tenantId, usageCounter.day, usageCounter.tool],
      set: { calls: sql`${usageCounter.calls} + 1`, errors: sql`${usageCounter.errors} + ${isError ? 1 : 0}` },
    });
}
