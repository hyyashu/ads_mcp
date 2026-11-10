import type { Change, Effect } from "./change-set";

export type WriteRisk = "write" | "high_impact" | "destructive";

const RANK: Record<WriteRisk, number> = { write: 0, high_impact: 1, destructive: 2 };
export const riskRank = (r: WriteRisk): number => RANK[r];
const max = (a: WriteRisk, b: WriteRisk): WriteRisk => (RANK[a] >= RANK[b] ? a : b);

const EFFECT_RISK: Record<Effect, WriteRisk> = {
  remove: "destructive",
  increase_spend: "high_impact",
  enable: "high_impact",
  create: "high_impact",
  decrease_spend: "write",
  pause: "write",
  neutral: "write",
};

/** More distinct resources than this in one request is high impact, whatever the direction. */
export const BULK_THRESHOLD = 20;

/**
 * Direction-aware risk. Without a change set the tool's declared risk applies unchanged. With one, the risk follows what
 * the change actually does: raising spend or enabling delivery is high impact, lowering or pausing does not.
 * A change set can raise any declared risk, and can lower high_impact to write, but never lowers a destructive tool:
 * the inventory marks those irreversible regardless of what a plan reports.
 */
export function effectiveRisk(declared: WriteRisk, changes: Change[] | undefined): { risk: WriteRisk; reason: string } {
  if (!changes?.length) return { risk: declared, reason: `declared risk of the tool (${declared})` };
  let risk: WriteRisk = "write";
  const why: string[] = [];
  for (const c of changes) {
    const r = EFFECT_RISK[c.effect];
    if (RANK[r] > RANK[risk]) risk = r;
  }
  const effects = [...new Set(changes.map((c) => c.effect))].sort();
  why.push(`effects: ${effects.join(", ")}`);
  const resources = new Set(changes.map((c) => `${c.resource}:${c.id}`)).size;
  if (resources > BULK_THRESHOLD) {
    risk = max(risk, "high_impact");
    why.push(`${resources} resources (more than ${BULK_THRESHOLD})`);
  }
  if (declared === "destructive" && risk !== "destructive") {
    risk = "destructive";
    why.push("the tool is destructive");
  }
  return { risk, reason: why.join("; ") };
}
