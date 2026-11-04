import { and, count, eq, gte, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db";
import { approvalRequest, tenantPolicy } from "../db/schema";
import type { Change, ChangeSet } from "./change-set";
import { BULK_THRESHOLD, type WriteRisk } from "./risk";

/**
 * A workspace's automation rules: which changes may be applied without a person approving them. Everything is off by
 * default, only an owner can change the rules (in the browser, never through an MCP tool), and nothing an agent or a
 * chat message says can count as an approval. A rule only ever covers changes whose before/after values were read live
 * and stored in a change set, so there is no automation for tools that do not report their changes.
 */
export const AutomationRulesSchema = z.object({
  /** Pausing campaigns, ad groups, ads or keywords. Pausing stops spend. */
  pause: z.object({ enabled: z.boolean() }).default({ enabled: false }),
  /** Daily budget changes within bounds. Both bounds apply to an increase; a decrease needs allow_decrease. */
  budget: z
    .object({
      enabled: z.boolean(),
      max_increase_pct: z.number().min(0).max(100),
      /** In the account's own currency. */
      max_increase_amount: z.number().min(0).max(1_000_000),
      allow_decrease: z.boolean(),
    })
    .default({ enabled: false, max_increase_pct: 0, max_increase_amount: 0, allow_decrease: false }),
  /** Hard cap on changes applied by rules per workspace per UTC day. */
  max_auto_per_day: z.number().int().min(0).max(500).default(20),
});
export type AutomationRules = z.infer<typeof AutomationRulesSchema>;
export const DEFAULT_RULES: AutomationRules = AutomationRulesSchema.parse({});

export async function loadRules(db: Db, tenantId: string): Promise<AutomationRules> {
  const [row] = await db.select({ rules: tenantPolicy.rules }).from(tenantPolicy).where(eq(tenantPolicy.tenantId, tenantId));
  if (!row) return DEFAULT_RULES;
  const parsed = AutomationRulesSchema.safeParse(row.rules);
  return parsed.success ? parsed.data : DEFAULT_RULES; // a stored value that no longer validates fails closed: nothing automatic
}

export async function saveRules(db: Db, tenantId: string, rules: AutomationRules, userId: string): Promise<void> {
  const value = AutomationRulesSchema.parse(rules);
  await db
    .insert(tenantPolicy)
    .values({ tenantId, rules: value, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: tenantPolicy.tenantId, set: { rules: value, updatedBy: userId, updatedAt: new Date() } });
}

/** Which rule covers one change, or why none does. */
function cover(rules: AutomationRules, c: Change): { rule: "pause" | "budget" } | { why: string } {
  if (c.effect === "pause") return rules.pause.enabled ? { rule: "pause" } : { why: "pausing is not automated" };
  if (c.field === "daily_budget" && c.unit === "currency") {
    const b = rules.budget;
    if (!b.enabled) return { why: "budget changes are not automated" };
    if (typeof c.before !== "number" || typeof c.after !== "number" || c.before <= 0) return { why: "the current budget is unknown" };
    if (c.effect === "decrease_spend") return b.allow_decrease ? { rule: "budget" } : { why: "budget decreases are not automated" };
    if (c.effect !== "increase_spend") return { why: `effect ${c.effect} is not automated` };
    const delta = c.after - c.before;
    // A cent of tolerance for float conversion from micros; limits are inclusive.
    if (delta > b.max_increase_amount + 1e-6) return { why: `increase of ${round2(delta)} is over the limit of ${b.max_increase_amount}` };
    if ((delta / c.before) * 100 > b.max_increase_pct + 1e-6) return { why: `increase of ${round2((delta / c.before) * 100)}% is over the limit of ${b.max_increase_pct}%` };
    return { rule: "budget" };
  }
  return { why: `${c.field} changes (${c.effect.replace(/_/g, " ")}) are never automated` };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Decides whether a planned change may be applied without a person. Every change in the set must be covered by an enabled
 * rule; destructive changes, bulk changes, changes without a change set and changes in an unknown currency never are.
 */
export function matchRules(rules: AutomationRules, risk: WriteRisk, cs: ChangeSet | null): { rule: string } | { rule: null; why: string } {
  if (!cs?.changes.length) return { rule: null, why: "the tool does not report its changes" };
  if (risk === "destructive") return { rule: null, why: "destructive changes always need a person" };
  if (new Set(cs.changes.map((c) => `${c.resource}:${c.id}`)).size > BULK_THRESHOLD) return { rule: null, why: "bulk changes always need a person" };
  if (cs.changes.some((c) => c.unit === "currency") && !cs.currency_code) return { rule: null, why: "the account's currency is unknown" };
  const used = new Set<string>();
  for (const c of cs.changes) {
    const r = cover(rules, c);
    if ("why" in r) return { rule: null, why: r.why };
    used.add(r.rule);
  }
  return { rule: [...used].sort().join("+") };
}

/** Changes applied by rules in this workspace since the start of the current UTC day. */
export async function autoApprovedToday(db: Db, tenantId: string, now = new Date()): Promise<number> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [r] = await db
    .select({ n: count() })
    .from(approvalRequest)
    .where(and(eq(approvalRequest.tenantId, tenantId), isNotNull(approvalRequest.approvedByRule), gte(approvalRequest.decidedAt, day)));
  return Number(r?.n ?? 0);
}
