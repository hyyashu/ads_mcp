import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeGoogle } from "../support/fake-google";
import { googleHarness, type GoogleHarness } from "../support/harness";

const g = fakeGoogle();
let kit: GoogleHarness;
const C = "customers/1234567890";
beforeAll(async () => {
  kit = await googleHarness("PL", g.fetch);
});
beforeEach(() => g.reset());
const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const data = async (name: string, args: Record<string, unknown>) => {
  const r = await run(name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.data as any;
};

describe("research_keywords (Keyword Planner)", () => {
  it("ideas: keyword+URL seed with location and language, metrics converted from micros", async () => {
    g.rpc[":generateKeywordIdeas"] = () => ({ results: [{ text: "trail running shoes", keywordIdeaMetrics: { avgMonthlySearches: "12100", competition: "HIGH", competitionIndex: "87", lowTopOfPageBidMicros: "650000", highTopOfPageBidMicros: "2400000" } }], nextPageToken: "x" });
    const d = await data("research_keywords", { mode: "ideas", keywords: ["trail shoes"], url: "https://shop.example", location_ids: ["2840"], limit: 1 });
    expect(d.keywords[0]).toEqual({ text: "trail running shoes", metrics: { avg_monthly_searches: 12100, competition: "HIGH", competition_index: 87, low_top_of_page_bid: 0.65, high_top_of_page_bid: 2.4, average_cpc: null } });
    expect(d.truncated).toBe(true);
    expect(g.calls[0]).toEqual({ path: "customers/1234567890:generateKeywordIdeas", body: { language: "languageConstants/1000", geoTargetConstants: ["geoTargetConstants/2840"], keywordPlanNetwork: "GOOGLE_SEARCH", includeAdultKeywords: false, pageSize: 1, keywordAndUrlSeed: { keywords: ["trail shoes"], url: "https://shop.example" } } });
  });

  it("historical and forecast modes use the documented requests", async () => {
    g.rpc[":generateKeywordHistoricalMetrics"] = () => ({ results: [{ text: "trail shoes", keywordMetrics: { avgMonthlySearches: "900", averageCpcMicros: "1100000" } }] });
    expect((await data("research_keywords", { mode: "historical", keywords: ["trail shoes"] })).keywords[0].metrics).toMatchObject({ avg_monthly_searches: 900, average_cpc: 1.1 });
    g.rpc[":generateKeywordForecastMetrics"] = () => ({ campaignForecastMetrics: { clicks: 120.5, costMicros: "180000000", conversions: 6.2, averageCpcMicros: "1490000" } });
    const f = await data("research_keywords", { mode: "forecast", keywords: ["trail shoes"], match_type: "PHRASE", max_cpc: 2, daily_budget: 20, forecast_start: "2026-12-01", forecast_end: "2026-12-31" });
    expect(f.forecast).toEqual({ clicks: 120.5, cost: 180, conversions: 6.2, average_cpc: 1.49, average_cpa: null, period: "2026-12-01..2026-12-31" });
    expect(g.calls.at(-1)!.body.campaign).toEqual({ languageConstants: ["languageConstants/1000"], geoTargetConstants: [], biddingStrategy: { manualCpcBiddingStrategy: { maxCpcBidMicros: "2000000", dailyBudgetMicros: "20000000" } }, adGroups: [{ keywords: [{ text: "trail shoes", matchType: "PHRASE" }] }] });
    expect((await run("research_keywords", { mode: "forecast", keywords: ["x"] })).error?.code).toBe("invalid_argument");
  });
});

describe("get_reach_frequency (Reach Planner)", () => {
  it("sends products, duration and targeting in the account currency and maps the reach curve", async () => {
    g.rpc[":generateReachForecast"] = () => ({ reachCurve: { reachForecasts: [{ costMicros: "1000000000", forecast: { totalReach: "250000", totalImpressions: "900000", onTargetReach: "180000", onTargetImpressions: "600000", trueviewViews: "120000" } }] } });
    const d = await data("get_reach_frequency", { plannable_location_id: "2840", duration_days: 28, products: [{ code: "TRUEVIEW_IN_STREAM", budget: 1000 }], age_range: "AGE_RANGE_18_34", genders: ["FEMALE"] });
    expect(d).toEqual({ currency_code: "USD", points: [{ cost: 1000, total_reach: 250000, total_impressions: 900000, on_target_reach: 180000, on_target_impressions: 600000, views: 120000 }] });
    expect(g.calls[0]!.body).toEqual({ currencyCode: "USD", campaignDuration: { durationInDays: 28 }, plannedProducts: [{ plannableProductCode: "TRUEVIEW_IN_STREAM", budgetMicros: "1000000000" }], targeting: { plannableLocationIds: ["2840"], ageRange: "AGE_RANGE_18_34", genders: [{ type: "FEMALE" }] } });
  });
});

describe("analysis", () => {
  const camp = (id: string, name: string, m: Record<string, unknown>) => ({ campaign: { id, name }, metrics: m });

  it("explain_performance_anomaly: change per metric, top contributors and change history", async () => {
    g.search.campaign = (q) => (q.includes("'2026-10-01'") ? [camp("11", "Brand", { impressions: "1000", clicks: "100", costMicros: "100000000", conversions: 10 }), camp("12", "Generic", { impressions: "1000", clicks: "50", costMicros: "50000000", conversions: 5 })] : [camp("11", "Brand", { impressions: "1000", clicks: "100", costMicros: "100000000", conversions: 10 }), camp("12", "Generic", { impressions: "2000", clicks: "150", costMicros: "150000000", conversions: 3 })]);
    g.search.change_event = [{ changeEvent: { changeDateTime: "2026-11-02 10:00:00", changeResourceType: "CAMPAIGN_BUDGET", resourceChangeOperation: "UPDATE", campaign: `${C}/campaigns/12`, changedFields: "amount_micros", clientType: "GOOGLE_ADS_WEB_CLIENT" } }];
    const d = await data("explain_performance_anomaly", { current: { start_date: "2026-10-25", end_date: "2026-11-03" }, previous: { start_date: "2026-10-01", end_date: "2026-10-10" } });
    expect(d.change.cost).toBe(round(250 / 150 - 1));
    expect(d.change.conversions).toBe(round(13 / 15 - 1));
    expect(d.campaigns[0]).toMatchObject({ campaign_id: "12", cost_delta: 100, conversions_delta: -2 });
    expect(d.changes_in_period[0]).toEqual({ at: "2026-11-02 10:00:00", resource_type: "CAMPAIGN_BUDGET", operation: "UPDATE", campaign_id: "12", changed_fields: "amount_micros", client: "GOOGLE_ADS_WEB_CLIENT" });
    expect(g.queries.find((q) => q.includes("FROM change_event"))).toContain("LIMIT 200");
  });

  it("optimize_budget_allocation: budget-limited efficient campaigns vs unconstrained inefficient ones, plus Google's recommendations", async () => {
    g.search.campaign = [
      { campaign: { id: "11", name: "Brand", advertisingChannelType: "SEARCH" }, campaignBudget: { amountMicros: "50000000" }, metrics: { costMicros: "100000000", conversions: 20, searchBudgetLostImpressionShare: 0.35 } },
      { campaign: { id: "12", name: "Generic", advertisingChannelType: "SEARCH" }, campaignBudget: { amountMicros: "80000000" }, metrics: { costMicros: "300000000", conversions: 5, searchBudgetLostImpressionShare: 0 } },
    ];
    g.search.recommendation = [{ recommendation: { campaign: `${C}/campaigns/11`, type: "CAMPAIGN_BUDGET", campaignBudgetRecommendation: { currentBudgetAmountMicros: "50000000", recommendedBudgetAmountMicros: "75000000" } } }];
    const d = await data("optimize_budget_allocation", {});
    expect(d.account).toEqual({ cpa: 16, roas: 0 });
    expect(d.candidates_to_increase).toEqual([{ campaign_id: "11", reason: expect.stringContaining("lost 35% of search impression share to budget") }]);
    expect(d.candidates_to_decrease).toEqual([{ campaign_id: "12", reason: expect.stringContaining("CPA 60") }]);
    expect(d.google_recommendations).toEqual([{ campaign_id: "11", current_budget: 50, recommended_budget: 75 }]);
  });

  it("get_benchmark_context: account history by month and channel and impression share, no invented benchmarks", async () => {
    g.search.campaign = (q) =>
      q.includes("search_impression_share")
        ? [{ campaign: { id: "11", name: "Brand" }, metrics: { searchImpressionShare: 0.82, searchTopImpressionShare: 0.6, searchAbsoluteTopImpressionShare: 0.4, searchRankLostImpressionShare: 0.1, searchBudgetLostImpressionShare: 0.08 } }]
        : [{ segments: { month: "2026-10-01" }, campaign: { advertisingChannelType: "SEARCH" }, metrics: { impressions: "1000", clicks: "50", costMicros: "75000000", conversions: 5, conversionsValue: 300 } }];
    const d = await data("get_benchmark_context", { months: 2 });
    expect(d.monthly[0]).toEqual({ month: "2026-10-01", channel: "SEARCH", impressions: 1000, clicks: 50, cost: 75, conversions: 5, ctr: 0.05, cpc: 1.5, cpa: 15, roas: 4 });
    expect(d.competitive[0]).toMatchObject({ impression_share: 0.82, lost_to_budget: 0.08 });
    expect(d.note).toContain("No external or industry benchmarks");
  });
});

function round(n: number) {
  return Math.round(n * 1e4) / 1e4;
}
