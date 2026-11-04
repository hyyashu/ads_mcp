import { z } from "zod";

/**
 * What one field of one resource will become, as planned against live state. Produced by a write tool's plan(), stored
 * with the approval, shown to the approver and the agent, and used to derive the approval's risk.
 */
export const EFFECTS = ["increase_spend", "decrease_spend", "enable", "pause", "create", "remove", "neutral"] as const;
export type Effect = (typeof EFFECTS)[number];

const Value = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const ChangeSchema = z.object({
  resource: z.string().describe("Resource kind, e.g. campaign, ad_group, ad, keyword."),
  id: z.string(),
  name: z.string().nullable().optional(),
  field: z.string().describe("The setting that changes, e.g. status, daily_budget, cpc_bid, name."),
  before: Value.describe("Current value read live from the platform; null when unset."),
  after: Value.describe("Proposed value."),
  unit: z.enum(["currency", "status", "text"]).describe("currency values are in the account's currency (converted from micros)."),
  effect: z.enum(EFFECTS).describe("Direction of the change for spend and delivery. It decides the approval's risk."),
});
export type Change = z.infer<typeof ChangeSchema>;

export const ChangeSetSchema = z.object({
  currency_code: z.string().nullable(),
  time_zone: z.string().nullable(),
  operations: z.number().int().describe("Number of field changes."),
  changes: z.array(ChangeSchema),
  risk_reason: z.string().describe("Why the approval has its risk level."),
});
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

type Ref = { resource: string; id: string; name?: string | null };

/** A status change. ENABLED can start spend, PAUSED stops it, REMOVED cannot be undone. */
export function statusChange(ref: Ref, before: string, after: string): Change {
  const effect: Effect = after === "ENABLED" ? "enable" : after === "PAUSED" ? "pause" : after === "REMOVED" ? "remove" : "neutral";
  return { ...ref, field: "status", before, after, unit: "status", effect };
}

/**
 * A money setting (budget, bid, target). Compared in micros so float rounding cannot flip the direction. Setting a value
 * that was unset counts as an increase: the previous effective value is unknown, so the safer reading wins.
 */
export function moneyChange(ref: Ref, field: string, beforeMicros: number | null, afterMicros: number): Change {
  const effect: Effect = beforeMicros === null || afterMicros > beforeMicros ? "increase_spend" : afterMicros < beforeMicros ? "decrease_spend" : "neutral";
  return { ...ref, field, before: beforeMicros === null ? null : beforeMicros / 1e6, after: afterMicros / 1e6, unit: "currency", effect };
}

/** A setting that does not change spend or delivery, such as a name. */
export function textChange(ref: Ref, field: string, before: string | null, after: string): Change {
  return { ...ref, field, before, after, unit: "text", effect: "neutral" };
}
