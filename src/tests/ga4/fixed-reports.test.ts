import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeGa4, type Ga4Harness, fakeGa4, ga4Harness, reportOf } from "./fake-ga4";

let f: FakeGa4;
let kit: Ga4Harness;
const NOW = new Date("2026-11-10T11:30:00Z"); // Europe/Berlin: 2026-11-10

beforeAll(async () => {
  f = fakeGa4();
  kit = await ga4Harness("G4F", f);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => f.reset());

const runBody = (i = 0) => f.dataCalls(":runReport")[i]!.body;
const totals = (mets: string[], vals: string[]) => [{ dimensionValues: [{ value: "RESERVED_TOTAL" }], metricValues: vals.map((value) => ({ value })) }].map((r) => ({ ...r, metricValues: r.metricValues.slice(0, mets.length) }));

describe("get_traffic_by_channel", () => {
  const M = ["sessions", "engagedSessions", "engagementRate", "averageSessionDuration", "totalUsers", "newUsers", "keyEvents", "sessionKeyEventRate", "totalRevenue"];
  it("maps channels with GA4's rates and share of GA4's total sessions; fixed request shape", async () => {
    f.report = () =>
      reportOf(["sessionDefaultChannelGroup"], M, [
        [["Organic Search"], ["600", "400", "0.6667", "75.5", "500", "300", "30", "0.05", "1200.5"]],
        [["Direct"], ["200", "100", "0.5", "40", "180", "90", "4", "0.02", "100"]],
      ], { totals: totals(M, ["1000", "600", "0.6", "60", "900", "500", "40", "0.04", "1500"]), rowCount: 2 });
    const r = await kit.run("get_traffic_by_channel", {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      property: "properties/123",
      period: { start_date: "2026-10-13", end_date: "2026-11-09", label: "LAST_28_DAYS" },
      time_zone: "Europe/Berlin",
      currency_code: "EUR",
      channel_dimension: "sessionDefaultChannelGroup",
      row_count: 2,
      returned: 2,
      truncated: false,
      totals: { sessions: 1000 },
      channels: [
        { channel: "Organic Search", sessions: 600, engagement_rate: 0.6667, average_session_duration_seconds: 75.5, key_events: 30, session_key_event_rate: 0.05, total_revenue: 1200.5, share_of_sessions: 0.6, key_event_rate_for_event: null },
        { channel: "Direct", share_of_sessions: 0.2 },
      ],
    });
    expect(runBody()).toMatchObject({ dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: M.map((name) => ({ name })), orderBys: [{ desc: true, metric: { metricName: "sessions" } }], limit: 100, metricAggregations: ["TOTAL"], returnPropertyQuota: true });
  });

  it("key_event must be a key event; when it is, its rate is added; primary channel group", async () => {
    f.keyEvents = [{ name: "properties/123/keyEvents/1", eventName: "purchase" }];
    const bad = await kit.run("get_traffic_by_channel", { key_event: "sign_up" });
    expect(bad.error).toMatchObject({ code: "invalid_argument" });
    expect(bad.error!.message).toContain("Key events: purchase");
    expect(f.dataCalls(":runReport")).toHaveLength(0);
    f.report = () => reportOf(["sessionPrimaryChannelGroup"], [...M, "sessionKeyEventRate:purchase"], [[["Paid Search"], ["10", "5", "0.5", "1", "9", "8", "1", "0.1", "0", "0.08"]]]);
    const r = await kit.run("get_traffic_by_channel", { key_event: "purchase", channel_group: "primary" });
    expect((r.data as any).channels[0]).toMatchObject({ channel: "Paid Search", key_event_rate_for_event: 0.08 });
    expect(runBody().metrics.at(-1)).toEqual({ name: "sessionKeyEventRate:purchase" });
  });

  it("an empty property returns an empty list with GA4's empty reason; thresholding note passes through", async () => {
    f.report = () => reportOf(["sessionDefaultChannelGroup"], M, [], { rowCount: 0, metadata: { timeZone: "Europe/Berlin", currencyCode: "EUR", emptyReason: "No data for this date range", subjectToThresholding: true } });
    const r = await kit.run("get_traffic_by_channel", {});
    expect(r.data).toMatchObject({ channels: [], totals: null, data_quality: { empty_reason: "No data for this date range", subject_to_thresholding: true } });
    expect((r.data as any).data_quality.notes.join(" ")).toContain("thresholding");
  });
});

describe("get_campaign_traffic", () => {
  it("utm_only switches to the sessionManual* dimensions; filters are case-insensitive; (not set) is kept; truncated from rowCount", async () => {
    f.report = (b) => reportOf(b.dimensions.map((d: any) => d.name), b.metrics.map((m: any) => m.name), [[["facebook", "paid_social", "(not set)", "video_a", "(not set)"], ["50", "20", "0.4", "2", "0.04", "0", "45"]]], { rowCount: 7 });
    const r = await kit.run("get_campaign_traffic", { utm_only: true, include_content_and_term: true, source_contains: "Face", medium_equals: "paid_social", campaign_contains: "BF", limit: 1 });
    const b = runBody();
    expect(b.dimensions.map((d: any) => d.name)).toEqual(["sessionManualSource", "sessionManualMedium", "sessionManualCampaignName", "sessionManualAdContent", "sessionManualTerm"]);
    expect(b.dimensionFilter).toEqual({
      andGroup: {
        expressions: [
          { filter: { fieldName: "sessionManualSource", stringFilter: { matchType: "CONTAINS", value: "Face", caseSensitive: false } } },
          { filter: { fieldName: "sessionManualMedium", stringFilter: { matchType: "EXACT", value: "paid_social", caseSensitive: false } } },
          { filter: { fieldName: "sessionManualCampaignName", stringFilter: { matchType: "CONTAINS", value: "BF", caseSensitive: false } } },
        ],
      },
    });
    expect(r.data).toMatchObject({ utm_only: true, row_count: 7, returned: 1, truncated: true, rows: [{ source: "facebook", medium: "paid_social", campaign: "(not set)", ad_content: "video_a", term: "(not set)", sessions: 50, total_users: 45 }] });
  });

  it("default reads sessionSource/Medium/CampaignName and orders by the chosen metric", async () => {
    f.report = (b) => reportOf(b.dimensions.map((d: any) => d.name), b.metrics.map((m: any) => m.name), [[["google", "cpc", "Brand"], ["5", "4", "0.8", "1", "0.2", "10", "5"]]]);
    const r = await kit.run("get_campaign_traffic", { order_by: "revenue" });
    expect(runBody().dimensions.map((d: any) => d.name)).toEqual(["sessionSource", "sessionMedium", "sessionCampaignName"]);
    expect(runBody().orderBys).toEqual([{ desc: true, metric: { metricName: "totalRevenue" } }]);
    expect((r.data as any).rows[0]).toMatchObject({ campaign: "Brand", ad_content: null, term: null });
  });
});

describe("get_landing_page_performance", () => {
  it("min_sessions becomes a metric filter, channel an exact dimension filter; '(other)' is explained", async () => {
    f.report = (b) => reportOf([b.dimensions[0].name], b.metrics.map((m: any) => m.name), [[["/pricing"], ["120", "90", "0.75", "0.25", "64", "6", "0.05", "0"]], [["(other)"], ["30", "10", "0.33", "0.67", "20", "0", "0", "0"]]], { metadata: { timeZone: "Europe/Berlin", currencyCode: "EUR", dataLossFromOtherRow: true } });
    const r = await kit.run("get_landing_page_performance", { min_sessions: 25, channel: "Paid Search", include_query_string: true, order_by: "engagement_rate" });
    const b = runBody();
    expect(b.dimensions).toEqual([{ name: "landingPagePlusQueryString" }]);
    expect(b.metricFilter).toEqual({ filter: { fieldName: "sessions", numericFilter: { operation: "GREATER_THAN_OR_EQUAL", value: { int64Value: "25" } } } });
    expect(b.dimensionFilter).toEqual({ filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Paid Search", caseSensitive: false } } });
    expect(b.orderBys).toEqual([{ desc: true, metric: { metricName: "engagementRate" } }]);
    expect(r.data).toMatchObject({ dimension: "landingPagePlusQueryString", rows: [{ landing_page: "/pricing", bounce_rate: 0.25, average_session_duration_seconds: 64 }, { landing_page: "(other)" }], data_quality: { other_row: true } });
    expect((r.data as any).note).toContain("'(other)'");
    await kit.run("get_landing_page_performance", {});
    expect(runBody(1).metricFilter).toBeUndefined();
  });
});

describe("get_google_ads_traffic_in_ga4", () => {
  const echo = (b: any) => reportOf(b.dimensions.map((d: any) => d.name), b.metrics.map((m: any) => m.name), [[b.dimensions.map((d: any) => `v:${d.name}`), b.metrics.map(() => "3")]]);

  it("dimensions per level; cost metrics included when allowed; customer and campaign filters", async () => {
    f.metadata.metrics = f.metadata.metrics!.map((m) => (m.apiName === "advertiserAdCost" ? { ...m, blockedReasons: [] } : m));
    f.metadata.metrics!.push({ apiName: "advertiserAdClicks" }, { apiName: "returnOnAdSpend" });
    f.report = echo;
    const r = await kit.run("get_google_ads_traffic_in_ga4", { level: "keyword", google_ads_customer_id: "123-456-7890", campaign_id: "555" });
    const b = runBody();
    expect(b.dimensions.map((d: any) => d.name)).toEqual(["sessionGoogleAdsCampaignId", "sessionGoogleAdsCampaignName", "sessionGoogleAdsAdGroupId", "sessionGoogleAdsAdGroupName", "sessionGoogleAdsKeyword"]);
    expect(b.metrics.map((m: any) => m.name).slice(-3)).toEqual(["advertiserAdCost", "advertiserAdClicks", "returnOnAdSpend"]);
    expect(b.dimensionFilter.andGroup.expressions).toEqual([
      { filter: { fieldName: "sessionGoogleAdsCustomerId", stringFilter: { matchType: "EXACT", value: "1234567890", caseSensitive: true } } },
      { filter: { fieldName: "sessionGoogleAdsCampaignId", stringFilter: { matchType: "EXACT", value: "555", caseSensitive: true } } },
    ]);
    expect(r.data).toMatchObject({ level: "keyword", omitted_metrics: [], rows: [{ campaign_id: "v:sessionGoogleAdsCampaignId", keyword: "v:sessionGoogleAdsKeyword", query: null, ad_cost: 3, roas: 3 }] });
    expect((r.data as any).note).toContain("digits only");
    await kit.run("get_google_ads_traffic_in_ga4", { level: "query", include_cost: false });
    expect(runBody(1).dimensions.map((d: any) => d.name)).toEqual(["sessionGoogleAdsCampaignId", "sessionGoogleAdsCampaignName", "sessionGoogleAdsQuery"]);
  });

  it("drops blocked and incompatible cost metrics and lists them; empty result explains the Ads link", async () => {
    f.metadata.metrics!.push({ apiName: "advertiserAdClicks" }, { apiName: "returnOnAdSpend" });
    f.incompatible = ["returnOnAdSpend"];
    f.report = (b) => reportOf(b.dimensions.map((d: any) => d.name), b.metrics.map((m: any) => m.name), []);
    const r = await kit.run("get_google_ads_traffic_in_ga4", {});
    expect(runBody().metrics.map((m: any) => m.name)).toEqual(["sessions", "engagedSessions", "engagementRate", "keyEvents", "sessionKeyEventRate", "totalRevenue", "advertiserAdClicks"]);
    expect((r.data as any).omitted_metrics).toEqual([
      { metric: "advertiserAdCost", reason: "blocked for you on this property (NO_COST_METRICS)" },
      { metric: "returnOnAdSpend", reason: "GA4 cannot combine it with the campaign dimensions" },
    ]);
    expect((r.data as any).note).toContain("needs a Google Ads link on the property");
  });
});

describe("get_conversion_events", () => {
  it("statuses per key event: recorded, no events, created during the period; one inList report", async () => {
    f.keyEvents = [
      { name: "properties/123/keyEvents/1", eventName: "purchase", countingMethod: "ONCE_PER_EVENT", defaultValue: { numericValue: 10, currencyCode: "EUR" }, custom: true, deletable: true, createTime: "2025-01-01T00:00:00Z" },
      { name: "properties/123/keyEvents/2", eventName: "sign_up", countingMethod: "ONCE_PER_SESSION", createTime: "2025-01-01T00:00:00Z" },
      { name: "properties/123/keyEvents/3", eventName: "add_to_cart", countingMethod: "ONCE_PER_EVENT", createTime: "2026-11-01T09:00:00Z" },
    ];
    f.report = () => reportOf(["eventName"], ["eventCount", "keyEvents"], [[["purchase"], ["40", "40"]], [["add_to_cart"], ["15", "12"]]], { metadata: { timeZone: "Europe/Berlin", currencyCode: "EUR", subjectToThresholding: true } });
    const r = await kit.run("get_conversion_events", {});
    expect(r.data).toMatchObject({
      key_events: [
        { event_name: "add_to_cart", status: "created_during_period", event_count: 15, key_event_count: 12 },
        { event_name: "purchase", status: "recorded", key_event_id: "1", default_value: { value: 10, currency_code: "EUR" }, event_count: 40 },
        { event_name: "sign_up", status: "no_events_in_period", event_count: 0, counting_method: "ONCE_PER_SESSION" },
      ],
      summary: { total: 3, recorded: 2, not_recorded: 1 },
      data_quality: { subject_to_thresholding: true },
    });
    expect((r.data as any).data_quality.notes.join(" ")).toContain("tag is missing");
    expect(runBody()).toMatchObject({ dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: ["purchase", "sign_up", "add_to_cart"], caseSensitive: true } } }, limit: 1000, offset: 0 });
  });

  it("no key events: empty, no report call", async () => {
    const r = await kit.run("get_conversion_events", { date_range: "LAST_7_DAYS" });
    expect(r.data).toMatchObject({ key_events: [], summary: { total: 0 }, quota: null });
    expect(f.dataCalls()).toHaveLength(0);
  });

  it("more rows than the cap is refused (row_cap), never cut", async () => {
    f.keyEvents = [{ name: "properties/123/keyEvents/1", eventName: "purchase" }];
    f.report = () => reportOf(["eventName"], ["eventCount", "keyEvents"], [], { rowCount: 1001 });
    const r = await kit.run("get_conversion_events", {});
    expect(r.error).toMatchObject({ code: "unsupported", details: { reason: "row_cap" } });
  });
});
