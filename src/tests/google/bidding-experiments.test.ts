import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

/** Portfolio bid strategies, seasonality adjustments and data exclusions against a small stateful fake of the API. */
const C = "customers/1234567890";
const MGR = "customers/5550001111";
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

// --- a tiny GAQL WHERE evaluator: `f = v`, `f != v`, `f IN (...)` joined by AND (all these tools use) ---
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const get = (row: any, f: string) => f.split(".").reduce((o, k) => (o == null ? undefined : o[camel(k)]), row);
const unq = (s: string) => s.trim().replace(/^'(.*)'$/s, "$1").replace(/\\'/g, "'");
function matches(q: string, row: any): boolean {
  const where = /\bWHERE (.*?)(?: ORDER BY | LIMIT | PARAMETERS |$)/.exec(q)?.[1];
  if (!where) return true;
  return where.split(" AND ").every((c) => {
    const m = /^([a-z_.]+) (=|!=|IN) (.+)$/s.exec(c.trim());
    if (!m) throw new Error(`fake cannot evaluate: ${c}`);
    const vals = m[2] === "IN" ? m[3]!.slice(1, -1).split(", ").map(unq) : [unq(m[3]!)];
    const v = get(row, m[1]!);
    const s = v === undefined || v === null ? "" : String(v);
    return m[2] === "!=" ? s !== vals[0] : vals.includes(s);
  });
}

let camps: Record<string, any>;
let strategies: Record<string, any>;
let shared: any[];
let seasonality: any[];
let exclusions: any[];
let mutates: any[][];
let queries: string[];
let dropWrites = false;
let failMutate = false;
let nextId = 900;

const SCHEMES: Record<string, string> = { targetCpa: "TARGET_CPA", targetRoas: "TARGET_ROAS", maximizeConversions: "MAXIMIZE_CONVERSIONS", maximizeConversionValue: "MAXIMIZE_CONVERSION_VALUE", targetImpressionShare: "TARGET_IMPRESSION_SHARE", targetSpend: "TARGET_SPEND", manualCpc: "MANUAL_CPC" };
const tail = (r: string) => r.split("/").pop()!;

function applyOp(op: any) {
  if (op.biddingStrategyOperation?.create) {
    const b = op.biddingStrategyOperation.create;
    const key = Object.keys(b).find((k) => SCHEMES[k])!;
    const id = String(nextId++);
    strategies[id] = { resourceName: `${C}/biddingStrategies/${id}`, id, name: b.name, type: SCHEMES[key], status: "ENABLED", campaignCount: "0", nonRemovedCampaignCount: "0", effectiveCurrencyCode: "USD", [key]: b[key] };
  } else if (op.biddingStrategyOperation?.remove) strategies[tail(op.biddingStrategyOperation.remove)]!.status = "REMOVED";
  else if (op.campaignOperation?.update) {
    const u = op.campaignOperation.update;
    const c = camps[tail(u.resourceName)]!;
    for (const k of Object.keys(SCHEMES)) delete c[k];
    if (u.biddingStrategy) {
      c.biddingStrategy = u.biddingStrategy;
      c.biddingStrategyType = (strategies[tail(u.biddingStrategy)] ?? shared.find((s) => s.id === tail(u.biddingStrategy)))!.type;
    } else {
      const key = Object.keys(u).find((k) => SCHEMES[k])!;
      delete c.biddingStrategy;
      c[key] = u[key];
      c.biddingStrategyType = SCHEMES[key];
    }
  } else if (op.biddingSeasonalityAdjustmentOperation?.create) {
    const id = String(nextId++);
    seasonality.push({ resourceName: `${C}/biddingSeasonalityAdjustments/${id}`, seasonalityAdjustmentId: id, status: "ENABLED", ...op.biddingSeasonalityAdjustmentOperation.create });
  } else if (op.biddingDataExclusionOperation?.create) {
    const id = String(nextId++);
    exclusions.push({ resourceName: `${C}/biddingDataExclusions/${id}`, dataExclusionId: id, status: "ENABLED", ...op.biddingDataExclusionOperation.create });
  } else if (op.biddingSeasonalityAdjustmentOperation?.remove) seasonality.find((x) => x.resourceName === op.biddingSeasonalityAdjustmentOperation.remove)!.status = "REMOVED";
  else if (op.biddingDataExclusionOperation?.remove) exclusions.find((x) => x.resourceName === op.biddingDataExclusionOperation.remove)!.status = "REMOVED";
  else throw new Error(`fake cannot apply ${JSON.stringify(op)}`);
}

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    queries.push(q);
    const from = /\bFROM ([a-z_]+)/.exec(q)![1];
    const rows: any[] =
      from === "customer"
        ? [{ customer: { id: "1234567890", timeZone: "Europe/Berlin" } }]
        : from === "campaign"
          ? Object.values(camps).map((c) => ({ campaign: c }))
          : from === "bidding_strategy"
            ? Object.values(strategies).map((s) => ({ biddingStrategy: s }))
            : from === "accessible_bidding_strategy"
              ? [...Object.values(strategies).map((s) => ({ accessibleBiddingStrategy: { id: s.id, name: s.name, type: s.type, ownerCustomerId: "1234567890" } })), ...shared.map((s) => ({ accessibleBiddingStrategy: s }))]
              : from === "bidding_seasonality_adjustment"
                ? seasonality.map((x) => ({ biddingSeasonalityAdjustment: x }))
                : from === "bidding_data_exclusion"
                  ? exclusions.map((x) => ({ biddingDataExclusion: x }))
                  : [];
    return J({ results: rows.filter((r) => matches(q, r)) });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    if (failMutate) return J({ error: { code: 500, status: "INTERNAL", message: "backend error" } }, 500);
    if (!dropWrites) for (const op of body.mutateOperations) applyOp(op);
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("BID", fake);
});
beforeEach(() => {
  camps = {
    "11": { id: "11", name: "Brand", status: "ENABLED", advertisingChannelType: "SEARCH", biddingStrategy: `${C}/biddingStrategies/77`, biddingStrategyType: "TARGET_CPA", campaignBudget: `${C}/campaignBudgets/5` },
    "12": { id: "12", name: "Generic", status: "ENABLED", advertisingChannelType: "SEARCH", biddingStrategyType: "MANUAL_CPC", manualCpc: {}, campaignBudget: `${C}/campaignBudgets/6` },
    "13": { id: "13", name: "Banners", status: "PAUSED", advertisingChannelType: "DISPLAY", biddingStrategyType: "MANUAL_CPC", manualCpc: {}, campaignBudget: `${C}/campaignBudgets/7` },
    "14": { id: "14", name: "Old", status: "REMOVED", advertisingChannelType: "SEARCH", biddingStrategyType: "MANUAL_CPC", manualCpc: {} },
  };
  strategies = {
    "77": { resourceName: `${C}/biddingStrategies/77`, id: "77", name: "CPA 20", type: "TARGET_CPA", status: "ENABLED", campaignCount: "1", nonRemovedCampaignCount: "1", effectiveCurrencyCode: "USD", targetCpa: { targetCpaMicros: "20000000", cpcBidCeilingMicros: "5000000" } },
    "78": { resourceName: `${C}/biddingStrategies/78`, id: "78", name: "Max conv", type: "MAXIMIZE_CONVERSIONS", status: "ENABLED", campaignCount: "0", nonRemovedCampaignCount: "0", effectiveCurrencyCode: "USD", maximizeConversions: {} },
    "79": { resourceName: `${C}/biddingStrategies/79`, id: "79", name: "Gone", type: "TARGET_SPEND", status: "REMOVED", campaignCount: "0", nonRemovedCampaignCount: "0", targetSpend: {} },
    "80": { resourceName: `${C}/biddingStrategies/80`, id: "80", name: "Aligned", type: "TARGET_ROAS", status: "ENABLED", campaignCount: "0", nonRemovedCampaignCount: "0", alignedCampaignBudgetId: "5", targetRoas: { targetRoas: 4 } },
    "81": { resourceName: `${C}/biddingStrategies/81`, id: "81", name: "Top IS", type: "TARGET_IMPRESSION_SHARE", status: "ENABLED", campaignCount: "0", nonRemovedCampaignCount: "0", targetImpressionShare: { location: "TOP_OF_PAGE", locationFractionMicros: "650000", cpcBidCeilingMicros: "3000000" } },
  };
  shared = [{ id: "300", name: "MCC ROAS", type: "TARGET_ROAS", ownerCustomerId: "5550001111", ownerDescriptiveName: "Agency", targetRoas: { targetRoas: 3.5 } }];
  seasonality = [{ resourceName: `${C}/biddingSeasonalityAdjustments/41`, seasonalityAdjustmentId: "41", name: "Black Friday", scope: "CHANNEL", status: "ENABLED", advertisingChannelTypes: ["SEARCH"], startDateTime: "2099-11-27 00:00:00", endDateTime: "2099-11-30 00:00:00", conversionRateModifier: 1.5 }];
  exclusions = [
    { resourceName: `${C}/biddingDataExclusions/51`, dataExclusionId: "51", name: "Tag outage", scope: "CAMPAIGN", status: "ENABLED", campaigns: [`${C}/campaigns/11`], devices: ["MOBILE"], startDateTime: "2026-10-01 00:00:00", endDateTime: "2026-10-02 00:00:00" },
    { resourceName: `${C}/biddingDataExclusions/52`, dataExclusionId: "52", name: "Older", scope: "CHANNEL", status: "REMOVED", advertisingChannelTypes: ["DISPLAY"], startDateTime: "2026-09-01 00:00:00", endDateTime: "2026-09-02 00:00:00" },
  ];
  mutates = [];
  queries = [];
  dropWrites = false;
  failMutate = false;
  nextId = 900;
});
const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const approve = (id: string, by = kit.second) => kit.approveAs(id, by);
async function ok(name: string, args: Record<string, unknown>) {
  const r = await run(name, args);
  if (!r.approval) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  const done = await approve(r.approval.approval_id);
  expect(done.status, JSON.stringify(done.result)).toBe("executed");
  return { r, done };
}
const err = async (name: string, args: Record<string, unknown>) => (await run(name, args)).error;

// ------------------------------------------------------------------------------------------------ portfolio strategies
describe("list_bid_strategies", () => {
  it("lists own and manager-shared strategies with settings and the campaigns using each", async () => {
    const r = await run("list_bid_strategies", {});
    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d).toMatchObject({ returned: 5, truncated: false, campaigns_truncated: false });
    expect(d.strategies.map((s: any) => s.bidding_strategy_id)).toEqual(["77", "78", "80", "81", "300"]);
    expect(d.strategies[0]).toEqual({
      bidding_strategy_id: "77", name: "CPA 20", type: "TARGET_CPA", status: "ENABLED", owner: "this_account", owner_customer_id: "1234567890", owner_name: null, currency_code: "USD", campaign_count: 1, non_removed_campaign_count: 1, aligned_campaign_budget_id: null,
      settings: { target_cpa: 20, target_roas: null, max_cpc: 5, min_cpc: null, impression_share_location: null, impression_share_percent: null },
      campaigns: [{ campaign_id: "11", name: "Brand", status: "ENABLED", channel: "SEARCH" }],
    });
    expect(d.strategies[3].settings).toMatchObject({ impression_share_location: "TOP_OF_PAGE", impression_share_percent: 65, max_cpc: 3 });
    expect(d.strategies[4]).toMatchObject({ owner: "manager", owner_customer_id: "5550001111", owner_name: "Agency", status: null, campaign_count: null, settings: { target_roas: 3.5 }, campaigns: [] });
    expect(queries[0]).toContain("FROM bidding_strategy WHERE bidding_strategy.status != 'REMOVED' ORDER BY bidding_strategy.id ASC LIMIT 201");
    expect(queries[1]).toContain("FROM accessible_bidding_strategy WHERE accessible_bidding_strategy.owner_customer_id != 1234567890");
    expect(queries[2]).toContain(`campaign.bidding_strategy IN ('${C}/biddingStrategies/77', '${C}/biddingStrategies/78', '${C}/biddingStrategies/80', '${C}/biddingStrategies/81', '${MGR}/biddingStrategies/300')`);
  });

  it("include_removed lists removed strategies; include_shared false skips the manager query; limit truncates", async () => {
    const d = (await run("list_bid_strategies", { include_removed: true, include_shared: false, limit: 3 })).data as any;
    expect(d.strategies.map((s: any) => s.bidding_strategy_id)).toEqual(["77", "78", "79"]);
    expect(d.truncated).toBe(true);
    expect(queries.some((q) => q.includes("accessible_bidding_strategy"))).toBe(false);
  });
});

describe("create_bid_strategy", () => {
  it("creates a TARGET_CPA portfolio with bid limits: one write approval, exact request, confirmed by re-reading", async () => {
    const r = await run("create_bid_strategy", { name: "CPA 25", type: "TARGET_CPA", target_cpa: 25, max_cpc: 4, min_cpc: 0.5 });
    expect(r.approval).toMatchObject({ risk: "write", change_set: { changes: [{ resource: "bidding_strategy", effect: "neutral", after: "TARGET_CPA (target CPA 25, max CPC 4, min CPC 0.5)" }] } });
    const done = await approve(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ biddingStrategyOperation: { create: { name: "CPA 25", targetCpa: { targetCpaMicros: "25000000", cpcBidCeilingMicros: "4000000", cpcBidFloorMicros: "500000" } } } }]);
    expect(done.result).toEqual({ bidding_strategy_id: "900", name: "CPA 25", type: "TARGET_CPA", settings: { target_cpa: 25, target_roas: null, max_cpc: 4, min_cpc: 0.5, impression_share_location: null, impression_share_percent: null } });
  });

  it("builds each type's scheme: impression share, ROAS, maximize clicks", async () => {
    await ok("create_bid_strategy", { name: "IS", type: "TARGET_IMPRESSION_SHARE", impression_share_location: "ABSOLUTE_TOP_OF_PAGE", impression_share_percent: 80, max_cpc: 2 });
    expect(mutates[0]![0].biddingStrategyOperation.create).toEqual({ name: "IS", targetImpressionShare: { location: "ABSOLUTE_TOP_OF_PAGE", locationFractionMicros: "800000", cpcBidCeilingMicros: "2000000" } });
    await ok("create_bid_strategy", { name: "ROAS", type: "TARGET_ROAS", target_roas: 4 });
    expect(mutates[1]![0].biddingStrategyOperation.create).toEqual({ name: "ROAS", targetRoas: { targetRoas: 4 } });
    await ok("create_bid_strategy", { name: "Clicks", type: "TARGET_SPEND" });
    expect(mutates[2]![0].biddingStrategyOperation.create).toEqual({ name: "Clicks", targetSpend: {} });
  });

  it("validates type-specific settings and refuses a duplicate name", async () => {
    expect((await err("create_bid_strategy", { name: "X", type: "TARGET_CPA" }))?.message).toContain("TARGET_CPA needs target_cpa");
    expect((await err("create_bid_strategy", { name: "X", type: "TARGET_SPEND", target_roas: 2 }))?.code).toBe("invalid_argument");
    expect((await err("create_bid_strategy", { name: "X", type: "TARGET_ROAS", target_roas: 1001 }))?.code).toBe("invalid_argument");
    expect((await err("create_bid_strategy", { name: "X", type: "TARGET_IMPRESSION_SHARE", impression_share_location: "TOP_OF_PAGE", impression_share_percent: 50 }))?.message).toContain("max_cpc");
    expect((await err("create_bid_strategy", { name: "X", type: "MAXIMIZE_CONVERSIONS", min_cpc: 3, max_cpc: 2 }))?.message).toContain("min_cpc must not exceed max_cpc");
    expect((await err("create_bid_strategy", { name: "X", type: "TARGET_SPEND", min_cpc: 1 }))?.message).toContain("min_cpc is not available");
    expect((await err("create_bid_strategy", { name: "X", type: "ENHANCED_CPC" }))?.code).toBe("invalid_argument");
    expect((await err("create_bid_strategy", { name: "CPA 20", type: "TARGET_CPA", target_cpa: 20 }))?.message).toMatch(/Nothing would change.*already exists \(id 77\)/);
    expect(mutates).toHaveLength(0);
  });

  it("an unconfirmed create is unknown_outcome", async () => {
    const r = await run("create_bid_strategy", { name: "Lost", type: "TARGET_SPEND" });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});

describe("assign_bid_strategy", () => {
  it("attaches campaigns, skipping those already on it; the change set shows each campaign's before and after", async () => {
    camps["15"] = { id: "15", name: "Shop", status: "ENABLED", advertisingChannelType: "SHOPPING", biddingStrategyType: "MANUAL_CPC", manualCpc: {}, campaignBudget: `${C}/campaignBudgets/8` };
    const r = await run("assign_bid_strategy", { campaign_ids: ["12", "15"], bidding_strategy_id: "78" });
    expect(r.approval?.risk).toBe("high_impact");
    expect(r.approval?.change_set?.changes).toEqual([
      { resource: "campaign", id: "12", name: "Generic", field: "bidding_strategy", before: "MANUAL_CPC (standard)", after: "MAXIMIZE_CONVERSIONS (portfolio 78)", unit: "text", effect: "increase_spend" },
      { resource: "campaign", id: "15", name: "Shop", field: "bidding_strategy", before: "MANUAL_CPC (standard)", after: "MAXIMIZE_CONVERSIONS (portfolio 78)", unit: "text", effect: "increase_spend" },
    ]);
    const done = await approve(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      { campaignOperation: { update: { resourceName: `${C}/campaigns/12`, biddingStrategy: `${C}/biddingStrategies/78` }, updateMask: "bidding_strategy" } },
      { campaignOperation: { update: { resourceName: `${C}/campaigns/15`, biddingStrategy: `${C}/biddingStrategies/78` }, updateMask: "bidding_strategy" } },
    ]);
    expect(done.result).toEqual({ campaigns: [{ campaign_id: "12", name: "Generic", bidding_strategy_id: "78", strategy_type: "MAXIMIZE_CONVERSIONS" }, { campaign_id: "15", name: "Shop", bidding_strategy_id: "78", strategy_type: "MAXIMIZE_CONVERSIONS" }], skipped_already_assigned: [] });

    const again = await run("assign_bid_strategy", { campaign_ids: ["11", "12"], bidding_strategy_id: "77" });
    expect(again.approval?.change_set?.changes.map((c: any) => c.id)).toEqual(["12"]);
    expect(again.approval?.change_set?.changes[0]?.before).toBe("MAXIMIZE_CONVERSIONS (portfolio 78)");
  });

  it("attaches a strategy shared by a manager account by its owner's resource name", async () => {
    const { done } = await ok("assign_bid_strategy", { campaign_ids: ["12"], bidding_strategy_id: "300" });
    expect(mutates[0]![0].campaignOperation.update.biddingStrategy).toBe(`${MGR}/biddingStrategies/300`);
    expect(done.result).toMatchObject({ campaigns: [{ campaign_id: "12", bidding_strategy_id: "300", strategy_type: "TARGET_ROAS" }] });
  });

  it("detaches campaigns onto a standard strategy in the same update", async () => {
    const r = await run("assign_bid_strategy", { campaign_ids: ["11"], detach_to: "MAXIMIZE_CONVERSIONS", target_cpa: 30 });
    expect(r.approval?.change_set?.changes[0]).toMatchObject({ before: "TARGET_CPA (portfolio 77)", after: "MAXIMIZE_CONVERSIONS target CPA 30 (standard)" });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ campaignOperation: { update: { resourceName: `${C}/campaigns/11`, maximizeConversions: { targetCpaMicros: "30000000" } }, updateMask: "maximize_conversions.target_cpa_micros" } }]);
    expect(done.result).toEqual({ campaigns: [{ campaign_id: "11", name: "Brand", bidding_strategy_id: null, strategy_type: "MAXIMIZE_CONVERSIONS" }], skipped_already_assigned: [] });
  });

  it("refuses incompatible campaign types, unaligned budgets, unknown or removed targets, and no-ops", async () => {
    expect((await err("assign_bid_strategy", { campaign_ids: ["13"], bidding_strategy_id: "78" }))?.message).toContain("works only with SEARCH, SHOPPING, PERFORMANCE_MAX campaigns");
    expect((await err("assign_bid_strategy", { campaign_ids: ["13"], bidding_strategy_id: "81" }))?.message).toContain("TARGET_IMPRESSION_SHARE strategy works only with SEARCH");
    expect((await err("assign_bid_strategy", { campaign_ids: ["12"], bidding_strategy_id: "80" }))?.message).toContain("aligned with budget 5");
    expect((await err("assign_bid_strategy", { campaign_ids: ["12"], bidding_strategy_id: "79" }))?.message).toContain("is removed");
    const nf = await err("assign_bid_strategy", { campaign_ids: ["12"], bidding_strategy_id: "999" });
    expect(nf?.code).toBe("not_found");
    expect((await err("assign_bid_strategy", { campaign_ids: ["99"], bidding_strategy_id: "77" }))?.code).toBe("not_found");
    expect((await err("assign_bid_strategy", { campaign_ids: ["14"], bidding_strategy_id: "77" }))?.message).toContain("Removed campaigns");
    expect((await err("assign_bid_strategy", { campaign_ids: ["11"], bidding_strategy_id: "77" }))?.message).toContain("Nothing would change");
    expect((await err("assign_bid_strategy", { campaign_ids: ["12"], detach_to: "MANUAL_CPC" }))?.message).toContain("update_bid_strategy");
    expect((await err("assign_bid_strategy", { campaign_ids: ["12"], bidding_strategy_id: "77", detach_to: "MANUAL_CPC" }))?.code).toBe("invalid_argument");
    expect((await err("assign_bid_strategy", { campaign_ids: ["11"], detach_to: "MANUAL_CPC", target_cpa: 3 }))?.code).toBe("invalid_argument");
    expect(mutates).toHaveLength(0);
  });

  it("drift before approval applies nothing; an unconfirmed write is unknown_outcome", async () => {
    const r = await run("assign_bid_strategy", { campaign_ids: ["12"], bidding_strategy_id: "78" });
    camps["12"]!.name = "Generic (renamed)";
    expect((await approve(r.approval!.approval_id)).status).toBe("failed");
    expect(mutates).toHaveLength(0);
    const r2 = await run("assign_bid_strategy", { campaign_ids: ["12"], bidding_strategy_id: "78" });
    dropWrites = true;
    expect((await approve(r2.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});

describe("remove_bid_strategy", () => {
  it("removes an unused strategy (destructive) and refuses one still in use", async () => {
    const used = await err("remove_bid_strategy", { bidding_strategy_id: "77" });
    expect(used?.message).toContain('still used by 1 campaign(s): "Brand" (11)');
    const r = await run("remove_bid_strategy", { bidding_strategy_id: "78" });
    expect(r.approval).toMatchObject({ risk: "destructive", change_set: { changes: [{ field: "status", before: "ENABLED", after: "REMOVED", effect: "remove" }] } });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ biddingStrategyOperation: { remove: `${C}/biddingStrategies/78` } }]);
    expect(done.result).toEqual({ bidding_strategy_id: "78", name: "Max conv", status: "REMOVED" });
  });

  it("refuses removed, unknown and manager-owned strategies", async () => {
    expect((await err("remove_bid_strategy", { bidding_strategy_id: "79" }))?.message).toContain("Nothing would change");
    expect((await err("remove_bid_strategy", { bidding_strategy_id: "999" }))?.code).toBe("not_found");
    expect((await err("remove_bid_strategy", { bidding_strategy_id: "300" }))?.message).toContain("owned by manager account 5550001111");
    expect(mutates).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------ bidding adjustments
const season = { name: "Cyber Monday", scope: "CAMPAIGN", campaign_ids: ["12", "11"], start_date_time: "2099-12-01 00:00:00", end_date_time: "2099-12-03 00:00:00", conversion_rate_modifier: 1.4, devices: ["MOBILE", "DESKTOP"] };
const exclusion = { name: "Pixel broken", scope: "CHANNEL", channel_types: ["SEARCH"], start_date_time: "2026-10-05 08:00:00", end_date_time: "2026-10-06 08:00:00" };

describe("list_bidding_adjustments", () => {
  it("lists seasonality adjustments and data exclusions, removed ones only on request", async () => {
    const d = (await run("list_bidding_adjustments", {})).data as any;
    expect(d).toMatchObject({ returned: 2, truncated: false });
    expect(d.adjustments).toEqual([
      { type: "seasonality_adjustment", id: "41", name: "Black Friday", description: null, scope: "CHANNEL", status: "ENABLED", campaign_ids: [], channel_types: ["SEARCH"], devices: [], start_date_time: "2099-11-27 00:00:00", end_date_time: "2099-11-30 00:00:00", conversion_rate_modifier: 1.5 },
      { type: "data_exclusion", id: "51", name: "Tag outage", description: null, scope: "CAMPAIGN", status: "ENABLED", campaign_ids: ["11"], channel_types: [], devices: ["MOBILE"], start_date_time: "2026-10-01 00:00:00", end_date_time: "2026-10-02 00:00:00", conversion_rate_modifier: null },
    ]);
    const ex = (await run("list_bidding_adjustments", { type: "data_exclusion", include_removed: true })).data as any;
    expect(ex.adjustments.map((x: any) => x.id)).toEqual(["51", "52"]);
  });
});

describe("create_seasonality_adjustment", () => {
  it("creates a campaign-scoped adjustment: high impact, exact request, confirmed by re-reading", async () => {
    const r = await run("create_seasonality_adjustment", season);
    expect(r.approval).toMatchObject({ risk: "high_impact", change_set: { changes: [{ resource: "bidding_seasonality_adjustment", effect: "create" }] } });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      { biddingSeasonalityAdjustmentOperation: { create: { name: "Cyber Monday", scope: "CAMPAIGN", startDateTime: "2099-12-01 00:00:00", endDateTime: "2099-12-03 00:00:00", campaigns: [`${C}/campaigns/11`, `${C}/campaigns/12`], devices: ["DESKTOP", "MOBILE"], conversionRateModifier: 1.4 } } },
    ]);
    expect(done.result).toEqual({ type: "seasonality_adjustment", id: "900", name: "Cyber Monday", description: null, scope: "CAMPAIGN", status: "ENABLED", campaign_ids: ["11", "12"], channel_types: [], devices: ["DESKTOP", "MOBILE"], start_date_time: "2099-12-01 00:00:00", end_date_time: "2099-12-03 00:00:00", conversion_rate_modifier: 1.4 });
  });

  it("creates a channel-scoped adjustment", async () => {
    await ok("create_seasonality_adjustment", { name: "Sale", scope: "CHANNEL", channel_types: ["SHOPPING", "SEARCH"], start_date_time: "2099-06-01 00:00:00", end_date_time: "2099-06-15 00:00:00", conversion_rate_modifier: 0.5 });
    expect(mutates[0]![0].biddingSeasonalityAdjustmentOperation.create).toEqual({ name: "Sale", scope: "CHANNEL", startDateTime: "2099-06-01 00:00:00", endDateTime: "2099-06-15 00:00:00", advertisingChannelTypes: ["SEARCH", "SHOPPING"], conversionRateModifier: 0.5 });
  });

  it("validates scope, interval (at most 14 days), modifier range and timing", async () => {
    expect((await err("create_seasonality_adjustment", { ...season, channel_types: ["SEARCH"] }))?.message).toContain("scope CAMPAIGN needs campaign_ids");
    expect((await err("create_seasonality_adjustment", { ...season, scope: "CUSTOMER" }))?.code).toBe("invalid_argument");
    expect((await err("create_seasonality_adjustment", { ...season, end_date_time: "2099-12-15 00:00:01" }))?.message).toContain("at most 14 days");
    expect((await err("create_seasonality_adjustment", { ...season, end_date_time: "2099-12-01 00:00:00" }))?.message).toContain("must be after");
    expect((await err("create_seasonality_adjustment", { ...season, start_date_time: "2099-02-30 00:00:00" }))?.code).toBe("invalid_argument");
    expect((await err("create_seasonality_adjustment", { ...season, conversion_rate_modifier: 10.5 }))?.code).toBe("invalid_argument");
    expect((await err("create_seasonality_adjustment", { ...season, conversion_rate_modifier: 1 }))?.message).toContain("Nothing would change");
    expect((await err("create_seasonality_adjustment", { ...season, start_date_time: "2026-01-01 00:00:00", end_date_time: "2026-01-02 00:00:00" }))?.message).toContain("future event");
    expect((await err("create_seasonality_adjustment", { ...season, campaign_ids: ["99"] }))?.code).toBe("not_found");
    expect((await err("create_seasonality_adjustment", { ...season, campaign_ids: ["14"] }))?.message).toContain("Removed campaigns");
    expect((await err("create_seasonality_adjustment", { ...season, name: "Black Friday" }))?.message).toContain("already exists (id 41)");
    expect(mutates).toHaveLength(0);
  });
});

describe("create_data_exclusion", () => {
  it("creates a channel-scoped exclusion for a past period; high impact; exact request", async () => {
    const r = await run("create_data_exclusion", exclusion);
    expect(r.approval?.risk).toBe("high_impact");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ biddingDataExclusionOperation: { create: { name: "Pixel broken", scope: "CHANNEL", startDateTime: "2026-10-05 08:00:00", endDateTime: "2026-10-06 08:00:00", advertisingChannelTypes: ["SEARCH"] } } }]);
    expect(done.result).toMatchObject({ type: "data_exclusion", id: "900", scope: "CHANNEL", channel_types: ["SEARCH"], conversion_rate_modifier: null });
  });

  it("refuses a future start and a duplicate name; an unconfirmed create is unknown_outcome", async () => {
    expect((await err("create_data_exclusion", { ...exclusion, start_date_time: "2099-01-01 00:00:00", end_date_time: "2099-01-02 00:00:00" }))?.message).toContain("past period");
    expect((await err("create_data_exclusion", { ...exclusion, name: "Tag outage" }))?.message).toContain("already exists");
    const r = await run("create_data_exclusion", { ...exclusion, name: "Pixel broken again" });
    if (!r.approval) throw new Error(JSON.stringify(r.error));
    dropWrites = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});

describe("remove_bidding_adjustment", () => {
  it("removes by type and id (destructive)", async () => {
    const r = await run("remove_bidding_adjustment", { type: "seasonality_adjustment", ids: ["41"] });
    expect(r.approval).toMatchObject({ risk: "destructive", change_set: { changes: [{ resource: "bidding_seasonality_adjustment", id: "41", before: "ENABLED", after: "REMOVED", effect: "remove" }] } });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([{ biddingSeasonalityAdjustmentOperation: { remove: `${C}/biddingSeasonalityAdjustments/41` } }]);
    expect(done.result).toEqual({ type: "seasonality_adjustment", removed: ["41"] });
  });

  it("refuses the wrong type, unknown ids and already removed ones; a server error is unknown_outcome", async () => {
    expect((await err("remove_bidding_adjustment", { type: "seasonality_adjustment", ids: ["51"] }))?.message).toContain("use type data_exclusion");
    expect((await err("remove_bidding_adjustment", { type: "data_exclusion", ids: ["999"] }))?.code).toBe("not_found");
    expect((await err("remove_bidding_adjustment", { type: "data_exclusion", ids: ["52"] }))?.message).toContain("Nothing would change");
    expect((await err("remove_bidding_adjustment", { type: "data_exclusion", ids: ["51", "52"] }))?.message).toContain("Already removed: 52");
    expect(mutates).toHaveLength(0);
    const r = await run("remove_bidding_adjustment", { type: "data_exclusion", ids: ["51"] });
    failMutate = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});
