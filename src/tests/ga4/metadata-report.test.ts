import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeGa4, type Ga4Harness, baseMetadata, dim, fakeGa4, ga4Harness, met, quotaError, reportOf } from "./fake-ga4";

let f: FakeGa4;
let kit: Ga4Harness;
// 11:30 UTC on 2026-11-10 is 00:30 on 2026-11-11 in Auckland.
const NOW = new Date("2026-11-10T11:30:00Z");

beforeAll(async () => {
  f = fakeGa4();
  kit = await ga4Harness("G4M", f, { units: { currencyCode: "NZD", timeZone: "Pacific/Auckland" } });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  f.reset();
  f.property = { ...f.property, timeZone: "Pacific/Auckland", currencyCode: "NZD" };
});

// ------------------------------------------------------------------------------------------------ list_ga4_properties
describe("list_ga4_properties", () => {
  it("returns property details, web and app streams, and the visible properties across pages", async () => {
    f.streams = [
      { name: "properties/123/dataStreams/1", type: "WEB_DATA_STREAM", displayName: "Web", webStreamData: { measurementId: "G-ABC123", defaultUri: "https://shop.example" } },
      { name: "properties/123/dataStreams/2", type: "ANDROID_APP_DATA_STREAM", displayName: "Android", androidAppStreamData: { packageName: "com.shop.app", firebaseAppId: "1:2:android:3" } },
    ];
    f.summaries = [
      { name: "accountSummaries/77", account: "accounts/77", displayName: "Shop Ltd", propertySummaries: [{ property: "properties/123", displayName: "Shop" }] },
      { name: "accountSummaries/78", account: "accounts/78", displayName: "Other", propertySummaries: [{ property: "properties/999", displayName: "Blog" }] },
    ];
    f.summaryPageSize = 1;
    const r = await kit.run("list_ga4_properties", {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      property: { property: "properties/123", display_name: "Shop", account: "accounts/77", service_level: "GOOGLE_ANALYTICS_STANDARD", time_zone: "Pacific/Auckland", currency_code: "NZD" },
      data_streams: [
        { stream: "properties/123/dataStreams/1", type: "WEB_DATA_STREAM", measurement_id: "G-ABC123", default_uri: "https://shop.example", package_name: null },
        { type: "ANDROID_APP_DATA_STREAM", measurement_id: null, package_name: "com.shop.app" },
      ],
      visible_properties: [
        { property: "properties/123", display_name: "Shop", account_display_name: "Shop Ltd" },
        { property: "properties/999", display_name: "Blog", account_display_name: "Other" },
      ],
      visible_truncated: false,
      note: null,
    });
    expect(f.calls.filter((c) => c.path === "/v1beta/accountSummaries")).toHaveLength(2);
  });

  it("notes zone or currency drift since connect, and flags more than 1,000 visible properties", async () => {
    f.property = { ...f.property, timeZone: "Europe/London", currencyCode: "GBP" };
    f.summaries = [0, 1, 2].map((a) => ({ displayName: `A${a}`, propertySummaries: Array.from({ length: 400 }, (_, i) => ({ property: `properties/${a * 1000 + i + 1}`, displayName: `P${i}` })) }));
    const r = await kit.run("list_ga4_properties", {});
    expect((r.data as any).note).toMatch(/time zone \(stored Pacific\/Auckland, now Europe\/London\) and currency \(stored NZD, now GBP\) changed since it was connected/);
    expect((r.data as any).visible_properties).toHaveLength(1000);
    expect((r.data as any).visible_truncated).toBe(true);
  });

  it("a property Google denies is platform_permission_denied", async () => {
    f.fail["GET /v1beta/properties/123"] = { status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "User does not have sufficient permissions for this property." } } };
    expect((await kit.run("list_ga4_properties", {})).error).toMatchObject({ code: "platform_permission_denied" });
  });
});

// ------------------------------------------------------------------------------------------------ get_ga4_metadata
describe("get_ga4_metadata", () => {
  beforeEach(() => {
    f.metadata.dimensions!.push(dim("customEvent:plan_type", { uiName: "Plan type", category: "Custom", customDefinition: true }));
    f.keyEvents = [{ name: "properties/123/keyEvents/1", eventName: "purchase" }, { name: "properties/123/keyEvents/2", eventName: "generate_lead" }];
  });

  it("searches names, filters custom definitions, surfaces blocked metrics and key events", async () => {
    const r = await kit.run("get_ga4_metadata", { search: "COST" });
    expect((r.data as any).metrics).toEqual([expect.objectContaining({ api_name: "advertiserAdCost", type: "TYPE_CURRENCY", blocked_reasons: ["NO_COST_METRICS"] })]);
    expect((r.data as any).key_events).toEqual(["generate_lead", "purchase"]);
    const c = await kit.run("get_ga4_metadata", { custom_only: true, include_descriptions: true });
    expect((c.data as any).dimensions).toEqual([{ api_name: "customEvent:plan_type", ui_name: "Plan type", category: "Custom", custom: true, deprecated_api_names: [], description: "" }]);
    expect((c.data as any).metrics).toEqual([]);
    const k = await kit.run("get_ga4_metadata", { search: "key" });
    expect((k.data as any).metrics.find((m: any) => m.api_name === "keyEvents").deprecated_api_names).toEqual(["conversions"]);
  });

  it("flags truncation per list", async () => {
    const r = await kit.run("get_ga4_metadata", { kind: "dimensions", limit: 3 });
    expect(r.data).toMatchObject({ returned: 3, truncated: true, matched: { dimensions: 16, metrics: 0 }, metrics: [] });
  });
});

// ------------------------------------------------------------------------------------------------ run_ga4_report
describe("run_ga4_report", () => {
  const ok = (dims: string[], mets: string[], rows: [string[], string[]][], o = {}) => () => reportOf(dims, mets, rows, o);

  it("checks names first: unknown names get suggestions, misplaced names are explained, nothing runs", async () => {
    let r = await kit.run("run_ga4_report", { dimensions: ["sessionSorce"], metrics: ["sessions"] });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
    expect(r.error!.message).toMatch(/Unknown dimension "sessionSorce".*Did you mean: sessionSource/);
    r = await kit.run("run_ga4_report", { metrics: ["country"] });
    expect(r.error!.message).toContain('"country" is a dimension');
    f.metadata = baseMetadata();
    f.metadata.metrics = f.metadata.metrics!.map((m) => ({ ...m, deprecatedApiNames: [] }));
    r = await kit.run("run_ga4_report", { metrics: ["conversions"] });
    expect(r.error!.message).toContain("GA4 renamed conversions to key events: use keyEvents");
    expect(f.dataCalls(":runReport")).toHaveLength(0);
  });

  it("renames a deprecated name and reports it", async () => {
    f.report = ok(["country"], ["keyEvents"], [[["DE"], ["4"]]]);
    const r = await kit.run("run_ga4_report", { dimensions: ["country"], metrics: ["conversions"] });
    expect(r.data).toMatchObject({ metrics: ["keyEvents"], renamed: [{ from: "conversions", to: "keyEvents" }], rows: [{ dimensions: { country: "DE" }, metrics: { keyEvents: 4 } }] });
    expect(f.dataCalls(":runReport")[0]!.body.metrics).toEqual([{ name: "keyEvents" }]);
  });

  it("an incompatible combination is refused before any report call", async () => {
    f.incompatible = ["landingPage"];
    const r = await kit.run("run_ga4_report", { dimensions: ["landingPage", "country"], metrics: ["sessions"] });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
    expect(r.error!.message).toContain("cannot be combined in one GA4 report: landingPage");
    expect(f.dataCalls(":checkCompatibility")).toHaveLength(1);
    expect(f.dataCalls(":runReport")).toHaveLength(0);
  });

  it("a blocked cost metric is platform_permission_denied", async () => {
    const r = await kit.run("run_ga4_report", { metrics: ["advertiserAdCost"] });
    expect(r.error).toMatchObject({ code: "platform_permission_denied" });
    expect(r.error!.message).toContain("cost metrics is blocked");
  });

  it("translates filters and ordering into the request, resolves dates in the property zone, asks for the quota", async () => {
    f.report = ok(["country"], ["sessions"], [[["DE"], ["10"]]]);
    const r = await kit.run("run_ga4_report", {
      dimensions: ["country"],
      metrics: ["sessions", "engagementRate"],
      date_range: "LAST_7_DAYS",
      dimension_filters: [
        { field: "country", match: "in_list", values: ["DE", "AT"] },
        { field: "pagePath", match: "begins_with", value: "/blog", negate: true },
      ],
      metric_filters: [{ field: "sessions", op: "between", value: 5, to_value: 100 }],
      order_by: [{ field: "country", desc: false }],
    });
    expect(r.ok).toBe(true);
    const body = f.dataCalls(":runReport")[0]!.body;
    expect(body).toMatchObject({
      dateRanges: [{ startDate: "2026-11-04", endDate: "2026-11-10" }],
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: "country", inListFilter: { values: ["DE", "AT"], caseSensitive: false } } },
            { notExpression: { filter: { fieldName: "pagePath", stringFilter: { matchType: "BEGINS_WITH", value: "/blog", caseSensitive: false } } } },
          ],
        },
      },
      metricFilter: { filter: { fieldName: "sessions", betweenFilter: { fromValue: { int64Value: "5" }, toValue: { int64Value: "100" } } } },
      orderBys: [{ desc: false, dimension: { dimensionName: "country" } }],
      limit: 1000,
      offset: 0,
      metricAggregations: ["TOTAL"],
      returnPropertyQuota: true,
    });
    expect(r.data).toMatchObject({ period: { start_date: "2026-11-04", end_date: "2026-11-10", label: "LAST_7_DAYS" }, quota: { tokens_per_hour_remaining: 39_990 } });
    // the compatibility check saw the same filters
    expect(f.dataCalls(":checkCompatibility")[0]!.body.metricFilter).toEqual(body.metricFilter);
  });

  it("an end date after today in the property zone is refused; a compare range adds a second dateRange", async () => {
    const r = await kit.run("run_ga4_report", { metrics: ["sessions"], start_date: "2026-11-01", end_date: "2026-11-12" });
    expect(r.error!.message).toContain("today is 2026-11-11 in the property's time zone, Pacific/Auckland");
    f.report = ok(["dateRange"], ["sessions"], [[["date_range_0"], ["10"]], [["date_range_1"], ["8"]]], {
      totals: [{ dimensionValues: [{ value: "date_range_0" }], metricValues: [{ value: "10" }] }, { dimensionValues: [{ value: "date_range_1" }], metricValues: [{ value: "8" }] }],
    });
    const c = await kit.run("run_ga4_report", { metrics: ["sessions"], start_date: "2026-11-01", end_date: "2026-11-07", compare_start_date: "2026-10-25", compare_end_date: "2026-10-31" });
    expect(f.dataCalls(":runReport")[0]!.body.dateRanges).toEqual([{ startDate: "2026-11-01", endDate: "2026-11-07" }, { startDate: "2026-10-25", endDate: "2026-10-31" }]);
    expect(c.data).toMatchObject({ periods: [{ name: "date_range_0", start_date: "2026-11-01" }, { name: "date_range_1", start_date: "2026-10-25" }], totals_by_range: { date_range_0: { sessions: 10 }, date_range_1: { sessions: 8 } } });
    expect((await kit.run("run_ga4_report", { metrics: ["sessions"], compare_start_date: "2026-10-25" })).error).toMatchObject({ code: "invalid_argument" });
  });

  it("pages with offset: truncated and next_offset come from GA4's rowCount; flags become notes; text is null, not 0", async () => {
    f.report = ok(["country"], ["sessions"], [[["DE"], ["10"]], [["(other)"], ["n/a"]]], {
      rowCount: 250,
      metadata: { currencyCode: "NZD", timeZone: "Pacific/Auckland", subjectToThresholding: true, dataLossFromOtherRow: true, samplingMetadatas: [{ samplesReadCount: "500", samplingSpaceSize: "1000" }] },
    });
    const r = await kit.run("run_ga4_report", { dimensions: ["country"], metrics: ["sessions"], limit: 2, offset: 100 });
    expect(r.data).toMatchObject({ row_count: 250, returned: 2, offset: 100, truncated: true, next_offset: 102, data_quality: { sampled: true, subject_to_thresholding: true, other_row: true } });
    expect((r.data as any).rows[1]).toEqual({ dimensions: { country: "(other)" }, metrics: { sessions: null } });
    expect((r.data as any).data_quality.notes.join(" ")).toMatch(/50% of events.*thresholding.*'\(other\)'/);
    expect(f.dataCalls(":runReport")[0]!.body).toMatchObject({ limit: 2, offset: 100 });
  });

  it("GA4 quota exhaustion is quota_exceeded with GA4's message and retry-after, and is not retried", async () => {
    f.fail[":runReport"] = { status: 429, body: quotaError };
    const r = await kit.run("run_ga4_report", { metrics: ["sessions"] });
    expect(r.error).toMatchObject({ code: "quota_exceeded", retry_after_seconds: 1200 });
    expect(r.error!.message).toContain("Google Analytics reporting quota for this property is used up");
    expect(f.dataCalls(":runReport")).toHaveLength(1);
  });

  it("with an unknown stored zone, reads it from the property once", async () => {
    const k2 = await ga4Harness("G4Z", f, { units: null });
    f.property.timeZone = "America/Los_Angeles";
    f.report = ok([], ["sessions"], [[[], ["1"]]]);
    const r = await k2.run("run_ga4_report", { metrics: ["sessions"], date_range: "YESTERDAY" });
    expect(r.data).toMatchObject({ period: { start_date: "2026-11-09", end_date: "2026-11-09" } });
    expect(f.calls.filter((c) => c.path === "/v1beta/properties/123")).toHaveLength(1);
  });
});
