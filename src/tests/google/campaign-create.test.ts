import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

const C = "customers/1234567890";
let camps: { id: string; name: string; status: string }[];
let mutates: any[][];
let dropWrites = false;
let nextId = 600;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    if (q.includes("FROM product_link")) return J({ results: [{ productLink: { merchantCenter: { merchantCenterId: "123456" } } }] });
    if (q.includes("FROM campaign")) return J({ results: camps.filter((c) => c.status !== "REMOVED").map((c) => ({ campaign: { id: c.id, name: c.name } })) });
    return J({ results: [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    if (!dropWrites) for (const op of body.mutateOperations) if (op.campaignOperation?.create) camps.push({ id: String(nextId++), name: op.campaignOperation.create.name, status: "PAUSED" });
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("CC", fake);
});
beforeEach(() => {
  camps = [{ id: "11", name: "Brand", status: "ENABLED" }];
  mutates = [];
  dropWrites = false;
});
const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const approve = (id: string, by = kit.second) => kit.approveAs(id, by);
const common = { daily_budget: 50, contains_eu_political_advertising: false };

describe("campaign creation", () => {
  it("Search: budget, PAUSED campaign and targeting in one atomic, schema-valid request", async () => {
    const r = await run("create_search_campaign", { ...common, name: "Generic", bidding_strategy: "MAXIMIZE_CONVERSIONS", target_cpa: 20, location_ids: ["2840"], language_ids: ["1000"], start_date: "2026-12-01" });
    expect(r.approval).toMatchObject({ risk: "high_impact", change_set: { changes: [{ effect: "create" }, { field: "daily_budget", before: null, after: 50, effect: "increase_spend" }] } });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(done.result).toMatchObject({ campaign_id: "600", name: "Generic", status: "PAUSED" });
    const ops = mutates[0]!;
    expect(ops[0]).toEqual({ campaignBudgetOperation: { create: { resourceName: `${C}/campaignBudgets/-1`, name: "Generic budget", amountMicros: "50000000", deliveryMethod: "STANDARD", explicitlyShared: false } } });
    expect(ops[1].campaignOperation.create).toMatchObject({ resourceName: `${C}/campaigns/-2`, status: "PAUSED", campaignBudget: `${C}/campaignBudgets/-1`, advertisingChannelType: "SEARCH", containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING", maximizeConversions: { targetCpaMicros: "20000000" }, startDateTime: "2026-12-01 00:00:00" });
    expect(ops.slice(2)).toEqual([{ campaignCriterionOperation: { create: { campaign: `${C}/campaigns/-2`, location: { geoTargetConstant: "geoTargetConstants/2840" } } } }, { campaignCriterionOperation: { create: { campaign: `${C}/campaigns/-2`, language: { languageConstant: "languageConstants/1000" } } } }]);
  });

  it("refuses duplicate names, mismatched targets and a missing EU political declaration", async () => {
    expect((await run("create_search_campaign", { ...common, name: "brand", bidding_strategy: "MANUAL_CPC" })).error?.message).toContain("already exists");
    expect((await run("create_search_campaign", { ...common, name: "X", bidding_strategy: "MANUAL_CPC", target_cpa: 5 })).error?.code).toBe("invalid_argument");
    expect((await run("create_search_campaign", { daily_budget: 50, name: "X", bidding_strategy: "MANUAL_CPC" })).error?.code).toBe("invalid_argument");
    expect((await run("create_pmax_campaign", { ...common, name: "X", bidding_strategy: "MANUAL_CPC" })).error?.code).toBe("invalid_argument");
    expect(mutates).toHaveLength(0);
  });

  it("Shopping needs a linked Merchant Center; PMax disables brand guidelines; Demand Gen and App shapes", async () => {
    expect((await run("create_shopping_campaign", { ...common, name: "Shop", bidding_strategy: "MANUAL_CPC", merchant_center_id: "999" })).error?.message).toContain("not linked");
    const shop = await run("create_shopping_campaign", { ...common, name: "Shop", bidding_strategy: "TARGET_SPEND", merchant_center_id: "123456", campaign_priority: 2 });
    await approve(shop.approval!.approval_id);
    expect(mutates[0]![1].campaignOperation.create).toMatchObject({ advertisingChannelType: "SHOPPING", shoppingSetting: { merchantId: "123456", campaignPriority: 2, enableLocal: false }, targetSpend: {} });

    const pmax = await run("create_pmax_campaign", { ...common, name: "PMax", bidding_strategy: "MAXIMIZE_CONVERSION_VALUE", target_roas: 4 });
    await approve(pmax.approval!.approval_id);
    expect(mutates[1]![1].campaignOperation.create).toMatchObject({ advertisingChannelType: "PERFORMANCE_MAX", brandGuidelinesEnabled: false, maximizeConversionValue: { targetRoas: 4 } });

    const dg = await run("create_demandgen_campaign", { ...common, name: "DG", bidding_strategy: "MAXIMIZE_CONVERSIONS" });
    await approve(dg.approval!.approval_id);
    expect(mutates[2]![1].campaignOperation.create.advertisingChannelType).toBe("DEMAND_GEN");
    expect((await run("create_demandgen_campaign", { ...common, name: "DG2", bidding_strategy: "MAXIMIZE_CONVERSIONS", location_ids: ["2840"] })).error?.code).toBe("invalid_argument");

    const app = await run("create_app_campaign", { ...common, name: "App", target_cost_per_install: 2.5, app_store: "GOOGLE_APP_STORE", app_id: "com.example.app", headlines: ["Get the app", "Run more"], descriptions: ["Track every run"] });
    const done = await approve(app.approval!.approval_id);
    expect(done.status).toBe("executed");
    const ops = mutates[3]!;
    expect(ops[1].campaignOperation.create).toMatchObject({ advertisingChannelType: "MULTI_CHANNEL", advertisingChannelSubType: "APP_CAMPAIGN", appCampaignSetting: { appId: "com.example.app", appStore: "GOOGLE_APP_STORE", biddingStrategyGoalType: "OPTIMIZE_INSTALLS_TARGET_INSTALL_COST" }, targetCpa: { targetCpaMicros: "2500000" } });
    expect(ops.at(-1).adGroupAdOperation.create.ad.appAd).toEqual({ headlines: [{ text: "Get the app" }, { text: "Run more" }], descriptions: [{ text: "Track every run" }] });
  });

  it("an unconfirmed create is unknown_outcome; create_youtube_campaign is a documented API limitation, not a tool", async () => {
    const r = await run("create_search_campaign", { ...common, name: "Ghost", bidding_strategy: "MANUAL_CPC" });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
    expect(kit.deps.registry.get("create_youtube_campaign")).toBeUndefined();
  });

  it("the approval snapshot holds only same-name campaigns: unrelated campaign changes do not block it, a new clash does", async () => {
    const r = await run("create_search_campaign", { ...common, name: "Generic", bidding_strategy: "MANUAL_CPC" });
    camps.push({ id: "12", name: "Unrelated", status: "ENABLED" });
    camps[0]!.name = "Brand renamed";
    expect((await approve(r.approval!.approval_id)).status).toBe("executed");

    const r2 = await run("create_search_campaign", { ...common, name: "Second", bidding_strategy: "MANUAL_CPC" });
    camps.push({ id: "13", name: "SECOND", status: "ENABLED" }); // a case-insensitive clash created after the request
    const done = await approve(r2.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect(mutates).toHaveLength(1);
  });
});
