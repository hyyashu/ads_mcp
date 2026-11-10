import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import * as schema from "../../db/schema";
import type { WriteTool } from "../../mcp/tool";
import { type Change, moneyChange, statusChange, textChange } from "../../policy/change-set";
import { BULK_THRESHOLD, effectiveRisk } from "../../policy/risk";
import { googleHarness, type GoogleHarness } from "../support/harness";

const ref = { resource: "campaign", id: "1", name: "Brand" };

describe("change helpers", () => {
  it("money direction is decided in micros; setting an unset value counts as an increase", () => {
    expect(moneyChange(ref, "daily_budget", 50_000_000, 60_000_000)).toMatchObject({ before: 50, after: 60, unit: "currency", effect: "increase_spend" });
    expect(moneyChange(ref, "daily_budget", 50_000_000, 40_000_000).effect).toBe("decrease_spend");
    expect(moneyChange(ref, "cpc_bid", null, 1_000_000)).toMatchObject({ before: null, effect: "increase_spend" });
    expect(moneyChange(ref, "cpc_bid", 1_000_000, 1_000_000).effect).toBe("neutral");
  });

  it("status direction: enable, pause, remove", () => {
    expect(statusChange(ref, "PAUSED", "ENABLED").effect).toBe("enable");
    expect(statusChange(ref, "ENABLED", "PAUSED").effect).toBe("pause");
    expect(statusChange(ref, "ENABLED", "REMOVED").effect).toBe("remove");
    expect(textChange(ref, "name", "a", "b").effect).toBe("neutral");
  });
});

describe("direction-aware risk", () => {
  const c = (effect: Change["effect"], id = "1"): Change => ({ resource: "campaign", id, field: "x", before: null, after: null, unit: "text", effect });

  it("without a change set, the declared risk applies unchanged", () => {
    for (const r of ["write", "high_impact", "destructive"] as const) expect(effectiveRisk(r, undefined).risk).toBe(r);
    expect(effectiveRisk("high_impact", []).risk).toBe("high_impact");
  });

  it("raising spend or enabling is high impact; lowering, pausing and renaming are ordinary writes", () => {
    expect(effectiveRisk("write", [c("increase_spend")]).risk).toBe("high_impact"); // raises a declared write
    expect(effectiveRisk("write", [c("enable")]).risk).toBe("high_impact");
    expect(effectiveRisk("high_impact", [c("decrease_spend")]).risk).toBe("write"); // lowers a declared high_impact
    expect(effectiveRisk("high_impact", [c("pause"), c("neutral")]).risk).toBe("write");
    expect(effectiveRisk("write", [c("pause"), c("increase_spend")]).risk).toBe("high_impact"); // the riskiest change wins
    expect(effectiveRisk("write", [c("remove")]).risk).toBe("destructive");
  });

  it("never lowers a destructive tool, whatever its plan reports", () => {
    const r = effectiveRisk("destructive", [c("pause")]);
    expect(r.risk).toBe("destructive");
    expect(r.reason).toContain("destructive");
  });

  it(`more than ${BULK_THRESHOLD} resources needs a second approver even when pausing`, () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => c("pause", String(i)));
    expect(effectiveRisk("write", many(BULK_THRESHOLD)).risk).toBe("write");
    const r = effectiveRisk("write", many(BULK_THRESHOLD + 1));
    expect(r.risk).toBe("high_impact");
    expect(r.reason).toContain(`${BULK_THRESHOLD + 1} resources`);
    // several fields of one resource are one resource
    expect(effectiveRisk("write", Array.from({ length: 30 }, () => c("pause", "same"))).risk).toBe("write");
  });
});

// ------------------------------------------------------------------------------------- through the pipeline
let budget = "50000000";
let status = "ENABLED";
let mutations = 0;
const J = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const C = "customers/1234567890";
const fake: FetchLike = async (url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (url.endsWith("googleAds:search")) {
    return J({ results: [{ campaign: { id: "11", name: "Brand <b>", status, resourceName: `${C}/campaigns/11`, campaignBudget: `${C}/campaignBudgets/11` }, campaignBudget: { amountMicros: budget, explicitlyShared: false, resourceName: `${C}/campaignBudgets/11` } }] });
  }
  mutations++;
  for (const op of body.mutateOperations ?? []) if (op.campaignBudgetOperation) budget = op.campaignBudgetOperation.update.amountMicros;
  for (const op of body.operations ?? []) status = op.update.status;
  return J({ results: [{}], mutateOperationResponses: [{}] });
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("CS", fake);
});
beforeEach(() => {
  budget = "50000000";
  status = "ENABLED";
  mutations = 0;
});
const row = (id: string) => kit.db.select().from(schema.approvalRequest).where(eq(schema.approvalRequest.id, id)).then((r) => r[0]!);

describe("change sets on real tools", () => {
  it("a budget increase is high impact, with the change set in the envelope and stored with the approval", async () => {
    const r = await kit.run("update_campaign", { campaign_id: "11", daily_budget: 75 });
    expect(r.approval?.risk).toBe("high_impact");
    expect(r.approval?.change_set).toEqual({
      currency_code: "USD",
      time_zone: "America/New_York",
      operations: 1,
      changes: [{ resource: "campaign", id: "11", name: "Brand <b>", field: "daily_budget", before: 50, after: 75, unit: "currency", effect: "increase_spend" }],
      risk_reason: "effects: increase_spend",
    });
    expect((await row(r.approval!.approval_id)).changeSet).toEqual(r.approval!.change_set);
    expect((await kit.approveAs(r.approval!.approval_id, kit.second)).status).toBe("executed");
    expect(budget).toBe("75000000");
  });

  it("a budget decrease or a rename is an ordinary write: the requester's own approval is enough", async () => {
    const down = await kit.run("update_campaign", { campaign_id: "11", daily_budget: 20 });
    expect(down.approval?.risk).toBe("write");
    expect(down.approval?.change_set?.changes[0]).toMatchObject({ before: 50, after: 20, effect: "decrease_spend" });
    expect((await kit.approveAs(down.approval!.approval_id, kit.owner)).status).toBe("executed");

    const rename = await kit.run("update_campaign", { campaign_id: "11", name: "Brand 2" });
    expect(rename.approval?.risk).toBe("write");
    expect(rename.approval?.change_set?.changes[0]).toMatchObject({ field: "name", unit: "text", effect: "neutral" });
  });

  it("resume is high impact through its enable effect; pause is a write", async () => {
    expect((await kit.run("pause_campaign", { campaign_id: "11" })).approval).toMatchObject({ risk: "write", change_set: { changes: [{ field: "status", before: "ENABLED", after: "PAUSED", effect: "pause" }] } });
    status = "PAUSED";
    expect((await kit.run("resume_campaign", { campaign_id: "11" })).approval).toMatchObject({ risk: "high_impact", change_set: { changes: [{ effect: "enable" }] } });
  });

  it("execution refuses when the same change now assesses riskier than what was approved", async () => {
    const r = await kit.run("pause_campaign", { campaign_id: "11" });
    expect(r.approval?.risk).toBe("write");
    const tool = kit.deps.registry.get("pause_campaign") as WriteTool;
    const original = tool.plan;
    // Same snapshot (so drift detection passes), but the plan now reports a spend increase.
    tool.plan = async (a, ctx) => ({ ...(await original(a, ctx)), changes: [statusChange({ resource: "campaign", id: "11" }, "ENABLED", "PAUSED"), moneyChange({ resource: "campaign", id: "11" }, "daily_budget", 1, 2)] });
    try {
      const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
      expect(done.status).toBe("failed");
      expect(done.result).toMatchObject({ error: { code: "conflict" } });
      expect(mutations).toBe(0);
    } finally {
      tool.plan = original;
    }
  });

  it("the approvals page shows the change set escaped, with units and the risk reason", async () => {
    const r = await kit.run("update_campaign", { campaign_id: "11", daily_budget: 90 });
    const { changeTableForTest } = await import("../../web/routes");
    const html = changeTableForTest((await row(r.approval!.approval_id)).changeSet as never);
    expect(html).toContain("50 USD");
    expect(html).toContain("90 USD");
    expect(html).toContain("increase spend");
    expect(html).toContain("Brand &lt;b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).toContain("Risk: effects: increase_spend");
    expect(changeTableForTest(null)).toBe("");
  });
});
