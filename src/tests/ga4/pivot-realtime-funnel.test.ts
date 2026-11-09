import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeGa4, type Ga4Harness, fakeGa4, ga4Harness, quotaError } from "./fake-ga4";

let f: FakeGa4;
let kit: Ga4Harness;
const NOW = new Date("2026-11-10T11:30:00Z");

beforeAll(async () => {
  f = fakeGa4();
  kit = await ga4Harness("G4P", f);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => f.reset());

const row = (d: string[], m: string[]) => ({ dimensionValues: d.map((value) => ({ value })), metricValues: m.map((value) => ({ value })) });

describe("run_ga4_pivot_report", () => {
  it("builds pivots from the request, reports per-pivot truncation from GA4's rowCount, asks for the quota", async () => {
    f.pivot = () => ({
      pivotHeaders: [
        { pivotDimensionHeaders: [{ dimensionValues: [{ value: "Organic Search" }] }, { dimensionValues: [{ value: "Direct" }] }], rowCount: 9 },
        { pivotDimensionHeaders: [{ dimensionValues: [{ value: "mobile" }] }], rowCount: 1 },
      ],
      dimensionHeaders: [{ name: "sessionDefaultChannelGroup" }, { name: "deviceCategory" }],
      metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }],
      rows: [row(["Organic Search", "mobile"], ["40"]), row(["Direct", "mobile"], ["12"])],
      metadata: { timeZone: "Europe/Berlin", currencyCode: "EUR" },
    });
    const r = await kit.run("run_ga4_pivot_report", { metrics: ["sessions"], pivots: [{ dimensions: ["sessionDefaultChannelGroup"], limit: 2, order_by_metric: "sessions" }, { dimensions: ["deviceCategory"], limit: 3, desc: false }] });
    expect(r.ok).toBe(true);
    const b = f.dataCalls(":runPivotReport")[0]!.body;
    expect(b).toMatchObject({
      dimensions: [{ name: "sessionDefaultChannelGroup" }, { name: "deviceCategory" }],
      pivots: [{ fieldNames: ["sessionDefaultChannelGroup"], limit: 2, orderBys: [{ desc: true, metric: { metricName: "sessions" } }] }, { fieldNames: ["deviceCategory"], limit: 3 }],
      dateRanges: [{ startDate: "2026-10-13", endDate: "2026-11-09" }],
      returnPropertyQuota: true,
    });
    expect(r.data).toMatchObject({
      pivots: [
        { dimensions: ["sessionDefaultChannelGroup"], row_count: 9, returned: 2, truncated: true },
        { dimensions: ["deviceCategory"], row_count: 1, returned: 1, truncated: false },
      ],
      rows: [{ dimensions: { sessionDefaultChannelGroup: "Organic Search", deviceCategory: "mobile" }, metrics: { sessions: 40 } }, { metrics: { sessions: 12 } }],
    });
  });

  it("refuses a product of limits above 10,000, a dimension in two pivots, and an order metric not requested", async () => {
    expect((await kit.run("run_ga4_pivot_report", { metrics: ["sessions"], pivots: [{ dimensions: ["country"], limit: 1000 }, { dimensions: ["deviceCategory"], limit: 11 }] })).error!.message).toContain("product of the pivot limits");
    expect((await kit.run("run_ga4_pivot_report", { metrics: ["sessions"], pivots: [{ dimensions: ["country"], limit: 5 }, { dimensions: ["country"], limit: 5 }] })).error!.message).toContain("one pivot only");
    expect((await kit.run("run_ga4_pivot_report", { metrics: ["sessions"], pivots: [{ dimensions: ["country"], limit: 5, order_by_metric: "totalUsers" }] })).error!.message).toContain("must be one of the requested metrics");
    expect(f.dataCalls(":runPivotReport")).toHaveLength(0);
  });
});

describe("get_ga4_realtime", () => {
  it("minuteRanges from minutes, no offset, totals and truncation; the source limitation is stated", async () => {
    f.realtime = () => ({
      dimensionHeaders: [{ name: "unifiedScreenName" }, { name: "country" }],
      metricHeaders: ["activeUsers", "screenPageViews", "eventCount", "keyEvents"].map((name) => ({ name })),
      rows: [row(["Home", "Germany"], ["5", "9", "30", "1"])],
      totals: [row(["RESERVED_TOTAL", "RESERVED_TOTAL"], ["8", "12", "40", "1"])],
      rowCount: 3,
      propertyQuota: { tokensPerHour: { consumed: 1, remaining: 39_999 } },
    });
    const r = await kit.run("get_ga4_realtime", { breakdown: ["unifiedScreenName", "country"], minutes: 10, limit: 1 });
    const b = f.dataCalls(":runRealtimeReport")[0]!.body;
    expect(b).toEqual({
      dimensions: [{ name: "unifiedScreenName" }, { name: "country" }],
      metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }, { name: "eventCount" }, { name: "keyEvents" }],
      limit: 1,
      metricAggregations: ["TOTAL"],
      orderBys: [{ desc: true, metric: { metricName: "activeUsers" } }],
      minuteRanges: [{ startMinutesAgo: 9, endMinutesAgo: 0 }],
      returnPropertyQuota: true,
    });
    expect(b).not.toHaveProperty("offset");
    expect(r.data).toMatchObject({ minutes: 10, rows: [{ dimensions: { unifiedScreenName: "Home" }, metrics: { activeUsers: 5 } }], totals: { activeUsers: 8 }, row_count: 3, returned: 1, truncated: true, quota: { tokens_per_hour_remaining: 39_999 } });
    expect((r.data as any).note).toContain("no traffic-source dimension");
    expect((await kit.run("get_ga4_realtime", { breakdown: ["sessionSource"] })).error).toMatchObject({ code: "invalid_argument" });
  });

  it("quota exhaustion is quota_exceeded, sent once", async () => {
    f.fail[":runRealtimeReport"] = { status: 429, body: quotaError };
    expect((await kit.run("get_ga4_realtime", {})).error).toMatchObject({ code: "quota_exceeded", retry_after_seconds: 1200 });
    expect(f.dataCalls(":runRealtimeReport")).toHaveLength(1);
  });
});

describe("run_ga4_funnel_report (v1alpha)", () => {
  const steps = [
    { name: "View", event_name: "view_item" },
    { name: "Cart", event_name: "add_to_cart", within_seconds: 3600 },
    { name: "Buy", event_name: "purchase", directly_followed: true },
  ];

  it("sends the documented body to the v1alpha URL and maps columns by header name", async () => {
    f.funnel = () => ({
      funnelTable: {
        dimensionHeaders: [{ name: "funnelStepName" }, { name: "deviceCategory" }],
        // deliberately not in the order the tool asks for
        metricHeaders: [{ name: "funnelStepAbandonmentRate" }, { name: "activeUsers" }, { name: "funnelStepAbandonments" }, { name: "funnelStepCompletionRate" }],
        rows: [row(["1. View", "mobile"], ["0.6", "100", "60", "0.4"]), row(["2. Cart", "mobile"], ["0.5", "40", "20", "0.5"])],
        metadata: { samplingMetadatas: [{ samplesReadCount: "100", samplingSpaceSize: "400" }] },
      },
      funnelVisualization: { rows: [] },
      propertyQuota: { tokensPerDay: { consumed: 5, remaining: 100 } },
    });
    const r = await kit.run("run_ga4_funnel_report", { steps, breakdown_dimension: "deviceCategory", breakdown_limit: 3 });
    expect(r.ok).toBe(true);
    const c = f.calls.find((x) => x.path.endsWith(":runFunnelReport"))!;
    expect(c.path).toBe("/v1alpha/properties/123:runFunnelReport");
    expect(c.body).toEqual({
      dateRanges: [{ startDate: "2026-10-13", endDate: "2026-11-09" }],
      funnel: {
        isOpenFunnel: false,
        steps: [
          { name: "View", filterExpression: { funnelEventFilter: { eventName: "view_item" } } },
          { name: "Cart", withinDurationFromPriorStep: "3600s", filterExpression: { funnelEventFilter: { eventName: "add_to_cart" } } },
          { name: "Buy", isDirectlyFollowedBy: true, filterExpression: { funnelEventFilter: { eventName: "purchase" } } },
        ],
      },
      funnelBreakdown: { breakdownDimension: { name: "deviceCategory" }, limit: "3" },
      funnelVisualizationType: "STANDARD_FUNNEL",
      returnPropertyQuota: true,
    });
    expect(r.data).toMatchObject({
      api_version: "v1alpha",
      breakdown_dimension: "deviceCategory",
      steps: [
        { step: "1. View", breakdown: "mobile", active_users: 100, completion_rate: 0.4, abandonments: 60, abandonment_rate: 0.6 },
        { step: "2. Cart", active_users: 40, completion_rate: 0.5 },
      ],
      data_quality: { sampled: true, sampling: [{ percent_of_events: 25 }] },
      quota: { tokens_per_day_remaining: 100 },
    });
  });

  it("refuses a duration on step 1 and an unknown breakdown dimension", async () => {
    expect((await kit.run("run_ga4_funnel_report", { steps: [{ name: "A", event_name: "a", within_seconds: 5 }, { name: "B", event_name: "b" }] })).error!.message).toContain("first step");
    expect((await kit.run("run_ga4_funnel_report", { steps, breakdown_dimension: "browserz" })).error!.message).toContain('Unknown dimension "browserz"');
    expect(f.calls.some((x) => x.path.endsWith(":runFunnelReport"))).toBe(false);
  });
});
