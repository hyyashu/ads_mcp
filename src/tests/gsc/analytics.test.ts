import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeGsc, gErr, guardBodies, gscHarness, type GscHarness } from "./fake-gsc";

const fake = new FakeGsc();
guardBodies(fake);
let kit: GscHarness;
beforeAll(async () => {
  fake.reset();
  kit = await gscHarness("GSCA", fake);
});
beforeEach(() => {
  fake.reset();
  // A fixed "now" (2026-11-10 in Pacific Time) so the explicit dates below never age out of the 16-month window.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T20:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const dates = { start_date: "2026-10-01", end_date: "2026-10-28" };
const r = (keys: string[], clicks: number, impressions: number, position = 4.123) => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
const isTotals = (b: any) => (b.dimensions ?? []).length === 0;
const isProbe = (b: any) => b.dimensions?.[0] === "date" && b.rowLimit === 12;
const queries = () => fake.calls.filter((c) => c.parts[2] === "searchAnalytics").map((c) => c.body);

describe("get_search_performance", () => {
  it("sends the documented body, flattens keys, and adds Google's totals from a second query", async () => {
    fake.sa = (_s, b) => (isTotals(b) ? { rows: [r([], 100, 2000, 7.5)] } : b.startRow === 0 ? { rows: [r(["shoes", "MOBILE"], 30, 300), r(["boots", "DESKTOP"], 10, 50)], responseAggregationType: "byProperty" } : {});
    const res = await kit.run("get_search_performance", { ...dates, dimensions: ["query", "device"], filters: [{ dimension: "device", expression: "mobile" }, { dimension: "country", operator: "equals", expression: "usa" }], aggregation_type: "byProperty" });
    expect(res.ok).toBe(true);
    const [main, , totals] = queries();
    expect(main).toEqual({ startDate: "2026-10-01", endDate: "2026-10-28", type: "web", dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "device", operator: "equals", expression: "MOBILE" }, { dimension: "country", operator: "equals", expression: "usa" }] }], aggregationType: "byProperty", dataState: "final", dimensions: ["query", "device"], rowLimit: 101, startRow: 0 });
    expect(totals).toMatchObject({ dimensions: [], dimensionFilterGroups: main.dimensionFilterGroups, type: "web", aggregationType: "byProperty", rowLimit: 2 });
    const d = res.data as any;
    expect(d.rows[0]).toEqual({ query: "shoes", device: "MOBILE", clicks: 30, impressions: 300, ctr: 0.1, position: 4.12 });
    expect(d.totals).toEqual({ clicks: 100, impressions: 2000, ctr: 0.05, position: 7.5 }); // not the sum of rows
    expect(d).toMatchObject({ period: { ...dates, time_zone: "America/Los_Angeles", end_basis: "explicit" }, returned: 2, truncated: false, next_start_row: null, response_aggregation_type: "byProperty" });
    expect(d.notes.join(" ")).toMatch(/Pacific Time.*Anonymized.*50,000/s);
  });

  it("with no dimensions the single row is the total (no second query)", async () => {
    fake.sa = (_s, b) => (b.startRow === 0 ? { rows: [r([], 5, 50)] } : {});
    const d = (await kit.run("get_search_performance", dates)).data as any;
    expect(queries()).toHaveLength(2); // the row query and its empty continuation page
    expect(d.totals).toMatchObject({ clicks: 5, impressions: 50 });
  });

  it("reports truncated with next_start_row and continues from start_row", async () => {
    fake.sa = (_s, b) => (isTotals(b) ? { rows: [r([], 1, 1)] } : { rows: Array.from({ length: b.rowLimit }, (_, i) => r([`q${b.startRow + i}`], 1, 1)) });
    const d = (await kit.run("get_search_performance", { ...dates, dimensions: ["query"], limit: 3, start_row: 6 })).data as any;
    expect(d.rows.map((x: any) => x.query)).toEqual(["q6", "q7", "q8"]);
    expect(d).toMatchObject({ truncated: true, next_start_row: 9, start_row: 6 });
  });

  it("passes first_incomplete_date through and adds the fresh-data note", async () => {
    fake.sa = (_s, b) => (b.startRow === 0 && !isTotals(b) ? { rows: [r(["2026-10-27"], 1, 2)], metadata: { first_incomplete_date: "2026-10-27" } } : { rows: [] });
    const d = (await kit.run("get_search_performance", { ...dates, dimensions: ["date"], data_state: "all" })).data as any;
    expect(d.first_incomplete_date).toBe("2026-10-27");
    expect(d.notes.join(" ")).toContain("fresh data");
  });

  it("refuses invalid combinations and dates before calling Google", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T07:30:00Z")); // still 2026-11-09 in Pacific Time
    const cases: Record<string, unknown>[] = [
      { dimensions: ["searchAppearance", "query"] },
      { dimensions: ["hour"] },
      { type: "discover", dimensions: ["query"] },
      { aggregation_type: "byProperty", filters: [{ dimension: "page", operator: "contains", expression: "/a" }] },
      { aggregation_type: "byProperty", type: "discover" },
      { aggregation_type: "byNewsShowcasePanel", type: "web" },
      { start_date: "2025-07-08", end_date: "2025-08-01" },
      { start_date: "2026-11-01", end_date: "2026-11-10" },
      { start_date: "2026-11-05", end_date: "2026-11-01" },
      { start_date: "2026-11-01" },
      { filters: [{ dimension: "country", expression: "US" }] },
      { filters: [{ dimension: "device", expression: "phone" }] },
    ];
    for (const c of cases) {
      const res = await kit.run("get_search_performance", { ...dates, ...c, ...(c.start_date || c.end_date ? { start_date: c.start_date, end_date: c.end_date } : {}) });
      expect(res.error?.code, JSON.stringify(c)).toBe("invalid_argument");
    }
    expect(fake.calls).toHaveLength(0);
    // the PT boundary: 2026-11-09 is "today", so it is accepted
    expect((await kit.run("get_search_performance", { start_date: "2026-11-01", end_date: "2026-11-09" })).ok).toBe(true);
  });

  it("a named period ends on the latest day with final data (date probe)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T07:30:00Z"));
    fake.sa = (_s, b) => (isProbe(b) ? { rows: [r(["2026-11-05"], 1, 1), r(["2026-11-06"], 1, 1)] } : { rows: [] });
    const d = (await kit.run("get_search_performance", { period: "last_7_days" })).data as any;
    expect(queries()[0]).toMatchObject({ startDate: "2026-10-30", endDate: "2026-11-09", dimensions: ["date"], dataState: "final" });
    expect(d.period).toEqual({ start_date: "2026-10-31", end_date: "2026-11-06", time_zone: "America/Los_Angeles", end_basis: "latest_final_data" });
  });

  it("falls back to three days ago with a note when the probe finds nothing; last_16_months starts at the retention limit", async () => {
    let d = (await kit.run("get_search_performance", { period: "last_28_days" })).data as any;
    expect(d.period).toMatchObject({ end_date: "2026-11-07", start_date: "2026-10-11", end_basis: "fallback_today_minus_3" });
    expect(d.notes.join(" ")).toContain("no final data");
    d = (await kit.run("get_search_performance", { period: "last_16_months" })).data as any;
    expect(d.period.start_date).toBe("2025-07-10");
  });

  it("maps Google's errors", async () => {
    fake.fail = () => gErr(403, "Quota exceeded", "quotaExceeded");
    let res = await kit.run("get_search_performance", dates);
    expect(res.error).toMatchObject({ code: "quota_exceeded", retryable: true });
    fake.fail = () => gErr(403, "User does not have sufficient permission", "forbidden");
    res = await kit.run("get_search_performance", dates);
    expect(res.error).toMatchObject({ code: "platform_permission_denied" });
    fake.fail = () => gErr(400, "Invalid dimension", "invalidParameter");
    res = await kit.run("get_search_performance", dates);
    expect(res.error).toMatchObject({ code: "invalid_argument", message: "Invalid dimension" });
  });
});

describe("get_top_queries and get_top_pages", () => {
  it("top queries: query dimension, filters mapped, Google's order kept, totals note with a query filter", async () => {
    fake.sa = (_s, b) => (isTotals(b) ? { rows: [r([], 50, 500)] } : b.startRow === 0 ? { rows: [r(["b"], 9, 90), r(["a"], 3, 10)] } : {});
    const res = await kit.run("get_top_queries", { ...dates, page_filter: "/blog", country: "DEU", device: "TABLET", query_contains: "shoe", exclude_query_regex: "acme|acmeco", limit: 10 });
    const d = res.data as any;
    expect(d.queries.map((q: any) => q.query)).toEqual(["b", "a"]);
    expect(queries()[0].dimensions).toEqual(["query"]);
    expect(queries()[0].dimensionFilterGroups[0].filters).toEqual([
      { dimension: "page", operator: "contains", expression: "/blog" },
      { dimension: "country", operator: "equals", expression: "DEU" },
      { dimension: "device", operator: "equals", expression: "TABLET" },
      { dimension: "query", operator: "contains", expression: "shoe" },
      { dimension: "query", operator: "excludingRegex", expression: "acme|acmeco" },
    ]);
    expect(d.notes.join(" ")).toContain("leave out anonymized queries too");
    expect((await kit.run("get_top_queries", { ...dates, type: "discover" })).error?.code).toBe("invalid_argument");
  });

  it("top pages: page dimension with auto aggregation; Discover allowed, Discover with a query filter refused", async () => {
    fake.sa = (_s, b) => (b.startRow === 0 ? { rows: [r(["https://example.com/a"], 4, 40)] } : {});
    const d = (await kit.run("get_top_pages", { ...dates, type: "discover" })).data as any;
    expect(d.pages[0]).toMatchObject({ page: "https://example.com/a", clicks: 4 });
    expect(queries()[0]).toMatchObject({ dimensions: ["page"], aggregationType: "auto", type: "discover" });
    expect(d.notes.join(" ")).toContain("Discover reports no queries");
    fake.calls = [];
    expect((await kit.run("get_top_pages", { ...dates, type: "discover", query_contains: "x" })).error?.code).toBe("invalid_argument");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("get_search_appearance", () => {
  it("groups by searchAppearance alone, labels known values and passes unknown ones through", async () => {
    fake.sa = (_s, b) => (isTotals(b) ? { rows: [r([], 9, 9)] } : b.startRow === 0 ? { rows: [r(["PRODUCT_SNIPPETS"], 5, 50), r(["SHINY_NEW_THING"], 1, 5)] } : {});
    const d = (await kit.run("get_search_appearance", dates)).data as any;
    expect(queries()[0].dimensions).toEqual(["searchAppearance"]);
    expect(d.appearances).toEqual([
      { appearance: "PRODUCT_SNIPPETS", label: "Product snippets", clicks: 5, impressions: 50, ctr: 0.1, position: 4.12 },
      { appearance: "SHINY_NEW_THING", label: null, clicks: 1, impressions: 5, ctr: 0.2, position: 4.12 },
    ]);
    expect(d.breakdown).toBeNull();
  });

  it("breaks one appearance down with a second query filtered on it", async () => {
    fake.sa = (_s, b) => (b.startRow > 0 ? {} : b.dimensions?.[0] === "page" ? { rows: [r(["https://example.com/p"], 2, 20)] } : { rows: [r(["VIDEO"], 2, 20)] });
    const d = (await kit.run("get_search_appearance", { ...dates, appearance: "VIDEO", breakdown: "page", limit: 5 })).data as any;
    const sub = queries().find((b) => b.dimensions?.[0] === "page");
    expect(sub).toMatchObject({ dimensions: ["page"], dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "searchAppearance", operator: "equals", expression: "VIDEO" }] }], rowLimit: 6 });
    expect(d.breakdown).toEqual({ appearance: "VIDEO", dimension: "page", rows: [{ key: "https://example.com/p", clicks: 2, impressions: 20, ctr: 0.1, position: 4.12 }], truncated: false });
  });

  it("refuses a query breakdown for Discover and a breakdown without an appearance", async () => {
    expect((await kit.run("get_search_appearance", { ...dates, type: "discover", appearance: "VIDEO", breakdown: "query" })).error?.code).toBe("invalid_argument");
    expect((await kit.run("get_search_appearance", { ...dates, breakdown: "query" })).error?.code).toBe("invalid_argument");
    expect(fake.calls).toHaveLength(0);
  });
});
