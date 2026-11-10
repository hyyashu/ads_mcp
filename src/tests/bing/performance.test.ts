import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapTool } from "../../../inventory/mapping";
import { loadInventory } from "../../inventory";
import { riskOf } from "../../mcp/tool";
import { performanceTools } from "../../platforms/bing/tools/performance";
import { FakeBing, SITE, bingErr, bingHarness, guardProtocol, type BingHarness } from "./fake-bing";
import { WEEKS as W, days, dq, qs, rt } from "./performance-fixtures";

const fake = new FakeBing();
guardProtocol(fake);
let kit: BingHarness;
beforeAll(async () => {
  fake.reset();
  kit = await bingHarness("BPERF", fake, performanceTools);
});
beforeEach(() => fake.reset());

const data = (r: { ok: boolean; data?: unknown; error?: unknown }) => {
  expect(r.error, JSON.stringify(r.error)).toBeUndefined();
  return r.data as any;
};

describe("performance tools: registration", () => {
  it("registers all 8 tools as reads, matching the inventory's risk", () => {
    const inv = loadInventory();
    expect(performanceTools.map((t) => t.name).sort()).toEqual(
      ["compare_bing_search_periods", "get_bing_page_queries", "get_bing_query_page_detail", "get_bing_query_pages", "get_bing_query_trend", "get_bing_search_performance", "get_bing_top_pages", "get_bing_top_queries"].sort(),
    );
    for (const t of performanceTools) {
      const it = inv.find((i) => i.name === t.name);
      expect(it, t.name).toBeDefined();
      expect(riskOf(t), t.name).toBe(mapTool(it!).risk);
      expect(riskOf(t)).toBe("read");
    }
  });
});

// ------------------------------------------------------------------------------------------- get_bing_search_performance

describe("get_bing_search_performance", () => {
  const ten = days("2026-10-01", 10).filter((d) => d !== "2026-10-05"); // Bing skipped 2026-10-05
  beforeEach(() => {
    fake.handlers.GetRankAndTrafficStats = () => [...ten].reverse().map((d) => rt(d, 1, 10));
  });

  it("reports Bing's own window, totals, missing days and daily rows newest first", async () => {
    const d = data(await kit.run("get_bing_search_performance"));
    expect(d).toMatchObject({ site_url: SITE, bing_first_day: "2026-10-01", bing_last_day: "2026-10-10", bing_days: 9, first_day: "2026-10-01", last_day: "2026-10-10", days_with_data: 9, missing_days: 1 });
    expect(d.totals).toEqual({ clicks: 9, impressions: 90, ctr: 0.1 });
    expect(d.daily[0]).toEqual({ date: "2026-10-10", clicks: 1, impressions: 10, ctr: 0.1 });
    expect(d).toMatchObject({ returned: 9, total: 9, truncated: false });
    expect(d.notes.join(" ")).toContain("not counted as zero");
    const c = fake.of("GetRankAndTrafficStats")[0]!;
    expect(c.http).toBe("GET");
    expect([...c.params.keys()]).toEqual(["siteUrl"]);
    expect(c.params.get("siteUrl")).toBe(SITE);
  });

  it("cuts Bing's rows to exact days and says when Bing's data is narrower than the range", async () => {
    const d = data(await kit.run("get_bing_search_performance", { start_date: "2026-10-03", end_date: "2026-10-20", limit: 3 }));
    expect(d).toMatchObject({ start_date: "2026-10-03", end_date: "2026-10-20", first_day: "2026-10-03", last_day: "2026-10-10", days_with_data: 7, missing_days: 1, returned: 3, total: 7, truncated: true });
    expect(d.totals).toMatchObject({ clicks: 7, impressions: 70 });
    expect(d.notes.join(" ")).toContain("narrower than the requested range");
  });

  it("refuses a range with no Bing days and names Bing's window; refuses reversed or malformed dates", async () => {
    let r = await kit.run("get_bing_search_performance", { start_date: "2026-12-01", end_date: "2026-12-31" });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
    expect(r.error!.message).toContain("2026-10-01 to 2026-10-10");
    r = await kit.run("get_bing_search_performance", { start_date: "2026-10-05", end_date: "2026-10-01" });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
    for (const bad of ["2026-13-01", "2026-02-30", "20261001", "yesterday"]) {
      r = await kit.run("get_bing_search_performance", { start_date: bad });
      expect(r.error, bad).toMatchObject({ code: "invalid_argument" });
    }
    r = await kit.run("get_bing_search_performance", { limit: 1001 });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
  });

  it("returns an empty, explained result when Bing has no traffic ({\"d\": null})", async () => {
    fake.handlers.GetRankAndTrafficStats = () => undefined;
    const d = data(await kit.run("get_bing_search_performance"));
    expect(d).toMatchObject({ bing_first_day: null, days_with_data: 0, daily: [], totals: { clicks: 0, impressions: 0, ctr: null } });
    expect(d.notes[0]).toContain("no daily traffic");
  });

  it("works on a read-only connection and maps Bing errors", async () => {
    expect((await kit.run("get_bing_search_performance", { account_id: kit.readOnlyId })).ok).toBe(true);
    fake.handlers.GetRankAndTrafficStats = () => bingErr(14, "NotAuthorized");
    expect((await kit.run("get_bing_search_performance")).error).toMatchObject({ code: "platform_permission_denied" });
    fake.handlers.GetRankAndTrafficStats = () => bingErr(4, "ThrottleUser");
    expect((await kit.run("get_bing_search_performance")).error).toMatchObject({ code: "quota_exceeded" });
    fake.handlers.GetRankAndTrafficStats = () => ({ not: "a list" });
    expect((await kit.run("get_bing_search_performance")).error).toMatchObject({ code: "internal" });
  });
});

// --------------------------------------------------------------------------------------------- top queries and pages

describe("get_bing_top_queries / get_bing_top_pages", () => {
  beforeEach(() => {
    fake.handlers.GetQueryStats = () => [
      qs("shoes", W[6], 10, 100, 3, 2),
      qs("shoes", W[7], 30, 300, 5, 4),
      qs("boots", W[7], 40, 200, 0, 0),
      qs("socks", W[5], 0, 50, 8, 0),
      qs("hats", W[7], 40, 100, 2, 2),
    ];
  });

  it("sums buckets per query with weighted positions and lists the bucket dates covered", async () => {
    const d = data(await kit.run("get_bing_top_queries"));
    expect(d.coverage).toEqual({ first_bucket: W[5], last_bucket: W[7], buckets: 3, bucket_dates: [W[5], W[6], W[7]] });
    expect(d.queries.map((q: any) => q.query)).toEqual(["shoes", "boots", "hats", "socks"]);
    expect(d.queries[0]).toEqual({ query: "shoes", clicks: 40, impressions: 400, ctr: 0.1, avg_impression_position: 4.5, avg_click_position: 3.5, buckets_present: 2 });
    expect(d.queries[1]).toMatchObject({ query: "boots", avg_impression_position: null, avg_click_position: null, ctr: 0.2 });
    expect(d.queries[3]).toMatchObject({ query: "socks", clicks: 0, ctr: 0, avg_impression_position: 8, avg_click_position: null });
    expect(d).toMatchObject({ returned: 4, total: 4, truncated: false, listed_totals: { clicks: 120, impressions: 750, ctr: 0.16 } });
    expect(d.notes.join(" ")).toContain("take no date range");
    expect(d.notes.join(" ")).toContain("not the site's total traffic");
    expect([...fake.of("GetQueryStats")[0]!.params.keys()]).toEqual(["siteUrl"]);
  });

  it("latest_buckets keeps whole recent buckets; sort, filters and limit report honest totals", async () => {
    let d = data(await kit.run("get_bing_top_queries", { latest_buckets: 1 }));
    expect(d.coverage.bucket_dates).toEqual([W[7]]);
    expect(d.queries.map((q: any) => [q.query, q.clicks])).toEqual([["boots", 40], ["hats", 40], ["shoes", 30]]);
    d = data(await kit.run("get_bing_top_queries", { latest_buckets: 10 }));
    expect(d.notes.join(" ")).toContain("Bing returned only 3");
    d = data(await kit.run("get_bing_top_queries", { sort_by: "impressions" }));
    expect(d.queries.map((q: any) => q.query)).toEqual(["shoes", "boots", "hats", "socks"]);
    d = data(await kit.run("get_bing_top_queries", { contains: "BOO" }));
    expect(d.queries.map((q: any) => q.query)).toEqual(["boots"]);
    d = data(await kit.run("get_bing_top_queries", { min_impressions: 100 }));
    expect(d.total).toBe(3);
    d = data(await kit.run("get_bing_top_queries", { limit: 2 }));
    expect(d).toMatchObject({ returned: 2, total: 4, truncated: true, listed_totals: { clicks: 120, impressions: 750 } });
    for (const bad of [{ limit: 0 }, { latest_buckets: 0 }, { contains: "x".repeat(201) }, { sort_by: "ctr" }]) expect((await kit.run("get_bing_top_queries", bad)).error, JSON.stringify(bad)).toMatchObject({ code: "invalid_argument" });
  });

  it("top pages reads GetPageStats and labels rows as pages", async () => {
    fake.handlers.GetPageStats = () => [qs(`${SITE}a`, W[7], 3, 30), qs(`${SITE}b`, W[7], 5, 10)];
    const d = data(await kit.run("get_bing_top_pages"));
    expect(d.pages.map((p: any) => p.page)).toEqual([`${SITE}b`, `${SITE}a`]);
    expect(d.coverage.bucket_dates).toEqual([W[7]]);
    expect(fake.of("GetPageStats")).toHaveLength(1);
  });

  it("an empty Bing list is an empty result, and errors are mapped", async () => {
    fake.handlers.GetQueryStats = () => undefined;
    const d = data(await kit.run("get_bing_top_queries"));
    expect(d).toMatchObject({ queries: [], returned: 0, total: 0, coverage: { buckets: 0, first_bucket: null } });
    fake.handlers.GetQueryStats = () => bingErr(3, "InvalidApiKey");
    expect((await kit.run("get_bing_top_queries")).error).toMatchObject({ code: "auth_expired" });
  });
});

// ------------------------------------------------------------------------------------------------ one query or page

describe("get_bing_query_pages", () => {
  it("sends the query, lists pages and per-bucket totals", async () => {
    fake.handlers.GetQueryPageStats = () => [qs(`${SITE}a`, W[6], 5, 50), qs(`${SITE}a`, W[7], 5, 50), qs(`${SITE}b`, W[7], 1, 20)];
    const d = data(await kit.run("get_bing_query_pages", { query: "running shoes" }));
    const c = fake.of("GetQueryPageStats")[0]!;
    expect(c.http).toBe("GET");
    expect(c.params.get("query")).toBe("running shoes");
    expect(c.params.get("siteUrl")).toBe(SITE);
    expect(d).toMatchObject({ query: "running shoes", rows_keyed_by_query: false, returned: 2, total: 2 });
    expect(d.pages.map((p: any) => [p.page, p.clicks, p.impressions])).toEqual([[`${SITE}a`, 10, 100], [`${SITE}b`, 1, 20]]);
    expect(d.by_bucket).toEqual([{ date: W[6], clicks: 5, impressions: 50, ctr: 0.1 }, { date: W[7], clicks: 6, impressions: 70, ctr: 0.0857 }]);
    expect(d.coverage).toMatchObject({ buckets: 2, first_bucket: W[6], last_bucket: W[7] });
  });

  it("when Bing labels every row with the query itself (as Microsoft's sample does) it gives no page split", async () => {
    fake.handlers.GetQueryPageStats = () => [qs("Running Shoes", W[6], 5, 50), qs("running shoes", W[7], 6, 60)];
    const d = data(await kit.run("get_bing_query_pages", { query: "running shoes" }));
    expect(d).toMatchObject({ rows_keyed_by_query: true, pages: [], returned: 0 });
    expect(d.by_bucket).toHaveLength(2);
    expect(d.notes.join(" ")).toContain("no per-page split");
  });

  it("explains an empty answer and validates the query", async () => {
    fake.handlers.GetQueryPageStats = () => undefined;
    const d = data(await kit.run("get_bing_query_pages", { query: "zzz" }));
    expect(d.notes.join(" ")).toContain("outside Bing's top queries");
    for (const q of ["", "   ", "x".repeat(501)]) expect((await kit.run("get_bing_query_pages", { query: q })).error).toMatchObject({ code: "invalid_argument" });
  });
});

describe("get_bing_page_queries", () => {
  it("sends the page in Bing's page parameter and lists its queries", async () => {
    fake.handlers.GetPageQueryStats = () => [qs("shoes", W[7], 2, 40, 6, 5), qs("boots", W[7], 4, 10)];
    const d = data(await kit.run("get_bing_page_queries", { page: `${SITE}shoes` }));
    const c = fake.of("GetPageQueryStats")[0]!;
    expect(c.params.get("page")).toBe(`${SITE}shoes`);
    expect(c.params.get("siteUrl")).toBe(SITE);
    expect(d.queries.map((q: any) => q.query)).toEqual(["boots", "shoes"]);
    expect(d.queries[1]).toMatchObject({ avg_impression_position: 6, avg_click_position: 5 });
  });

  it("refuses a page outside the site or a bad URL without calling Bing; explains an empty answer", async () => {
    let r = await kit.run("get_bing_page_queries", { page: "https://other.example.com/x" });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
    expect(r.error!.message).toContain("not inside the Bing site");
    r = await kit.run("get_bing_page_queries", { page: "not a url" });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
    r = await kit.run("get_bing_page_queries", { page: `${SITE}x#frag` });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
    expect(fake.of("GetPageQueryStats")).toHaveLength(0);
    fake.handlers.GetPageQueryStats = () => [];
    const d = data(await kit.run("get_bing_page_queries", { page: `${SITE}nothing` }));
    expect(d.notes.join(" ")).toContain("get_bing_top_pages");
  });
});

describe("get_bing_query_page_detail", () => {
  it("returns buckets oldest first with an impression-weighted position", async () => {
    fake.handlers.GetQueryPageDetailStats = () => [dq(W[7], 2, 20, 3), dq(W[6], 1, 30, 5), dq(W[5], 0, 0, 0)];
    const d = data(await kit.run("get_bing_query_page_detail", { query: "shoes", page: `${SITE}shoes` }));
    const c = fake.of("GetQueryPageDetailStats")[0]!;
    expect([c.params.get("siteUrl"), c.params.get("query"), c.params.get("page")]).toEqual([SITE, "shoes", `${SITE}shoes`]);
    expect(d.rows).toEqual([
      { date: W[5], clicks: 0, impressions: 0, ctr: null, position: null },
      { date: W[6], clicks: 1, impressions: 30, ctr: 0.0333, position: 5 },
      { date: W[7], clicks: 2, impressions: 20, ctr: 0.1, position: 3 },
    ]);
    expect(d.totals).toEqual({ clicks: 3, impressions: 50, ctr: 0.06, avg_position: 4.2 });
    expect(d.coverage).toMatchObject({ buckets: 3, first_bucket: W[5], last_bucket: W[7] });
  });

  it("refuses a page outside the site before calling Bing", async () => {
    const r = await kit.run("get_bing_query_page_detail", { query: "shoes", page: "https://shop.example.com/x" });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
    expect(fake.calls.filter((c) => c.method !== "GetUserSites")).toHaveLength(0);
  });
});

describe("get_bing_query_trend", () => {
  it("returns the query's dated rows and totals", async () => {
    fake.handlers.GetQueryTrafficStats = () => [rt("2026-11-02", 3, 30), rt("2026-11-01", 1, 10)];
    const d = data(await kit.run("get_bing_query_trend", { query: "shoes" }));
    expect(fake.of("GetQueryTrafficStats")[0]!.params.get("query")).toBe("shoes");
    expect(d).toMatchObject({ first_date: "2026-11-01", last_date: "2026-11-02", dates: 2, totals: { clicks: 4, impressions: 40, ctr: 0.1 } });
    expect(d.rows.map((r: any) => r.date)).toEqual(["2026-11-01", "2026-11-02"]);
  });

  it("explains that Bing keeps only top queries when nothing comes back; maps NotFound", async () => {
    fake.handlers.GetQueryTrafficStats = () => undefined;
    const d = data(await kit.run("get_bing_query_trend", { query: "rare" }));
    expect(d).toMatchObject({ dates: 0, first_date: null, rows: [] });
    expect(d.notes.join(" ")).toContain("top queries");
    fake.handlers.GetQueryTrafficStats = () => bingErr(11, "NotFound");
    expect((await kit.run("get_bing_query_trend", { query: "rare" })).error).toMatchObject({ code: "not_found" });
  });
});

// --------------------------------------------------------------------------------------------- compare two periods

describe("compare_bing_search_periods", () => {
  const queryRows = () => [
    qs("a", W[0], 1, 1),
    qs("a", W[4], 10, 100),
    qs("a", W[5], 10, 100),
    qs("a", W[6], 20, 200),
    qs("a", W[7], 20, 200),
    qs("b", W[4], 30, 300),
    qs("b", W[7], 10, 100),
    qs("c", W[6], 5, 50),
    qs("d", W[5], 7, 70),
    qs("e", W[4], 1, 5),
    qs("e", W[7], 1, 10),
  ];
  beforeEach(() => {
    fake.handlers.GetQueryStats = queryRows;
  });

  it("named comparison: latest N buckets vs the N before, with risers, fallers, new and lost", async () => {
    const d = data(await kit.run("compare_bing_search_periods", { weeks: 2 }));
    expect(d.current).toMatchObject({ basis: "buckets", requested_start: null, bucket_dates: [W[6], W[7]], first_date: W[6], last_date: W[7], count: 2, missing_days: null });
    expect(d.previous).toMatchObject({ bucket_dates: [W[4], W[5]], count: 2 });
    expect(d.current.totals).toMatchObject({ clicks: 56, impressions: 560 });
    expect(d.previous.totals).toMatchObject({ clicks: 58, impressions: 575 });
    expect(d.totals_change).toMatchObject({ clicks: -2, impressions: -15 });
    expect(d.risers.map((m: any) => m.key)).toEqual(["a", "e"]);
    expect(d.risers[0]).toMatchObject({ status: "both", clicks_current: 40, clicks_previous: 20, clicks_change: 20, position_change: 0 });
    expect(d.fallers.map((m: any) => m.key)).toEqual(["b"]);
    expect(d.new.map((m: any) => m.key)).toEqual(["c"]);
    expect(d.new[0]).toMatchObject({ position_previous: null, position_change: null, clicks_previous: 0 });
    expect(d.lost.map((m: any) => m.key)).toEqual(["d"]);
    expect(d.counts).toEqual({ risers: 2, fallers: 1, new: 1, lost: 1 });
    expect(d.equal_length).toBe(true);
    expect(d.notes.join(" ")).toContain(`2 bucket(s) dated ${W[6]} to ${W[7]}`);
  });

  it("min_impressions and limit trim the lists; counts stay honest", async () => {
    const d = data(await kit.run("compare_bing_search_periods", { weeks: 2, min_impressions: 60, limit: 1 }));
    expect(d.counts).toEqual({ risers: 1, fallers: 1, new: 0, lost: 1 });
    expect(d.risers.map((m: any) => m.key)).toEqual(["a"]);
  });

  it("explicit ranges use the whole buckets dated inside each range and say so", async () => {
    let d = data(await kit.run("compare_bing_search_periods", { current_start_date: "2026-10-20", current_end_date: "2026-11-05", previous_start_date: "2026-10-05", previous_end_date: "2026-10-19" }));
    expect(d.current).toMatchObject({ requested_start: "2026-10-20", requested_end: "2026-11-05", bucket_dates: [W[6], W[7]] });
    expect(d.previous).toMatchObject({ requested_start: "2026-10-05", bucket_dates: [W[4], W[5]] });
    expect(d.notes.join(" ")).toContain("whole buckets");
    d = data(await kit.run("compare_bing_search_periods", { current_start_date: "2026-10-20", current_end_date: "2026-11-05", previous_start_date: "2026-09-01", previous_end_date: "2026-10-19" }));
    expect(d.previous.bucket_dates).toEqual([W[0], W[4], W[5]]);
    expect(d.equal_length).toBe(false);
    expect(d.notes.join(" ")).toContain("different numbers of buckets (2 vs 3)");
  });

  it("refuses a period without buckets, too few buckets, partial dates and overlapping periods", async () => {
    let r = await kit.run("compare_bing_search_periods", { current_start_date: "2026-12-01", current_end_date: "2026-12-31", previous_start_date: "2026-10-01", previous_end_date: "2026-10-31" });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
    expect(r.error!.message).toContain(`dated ${W[0]} to ${W[7]}`);
    r = await kit.run("compare_bing_search_periods", { weeks: 3 });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
    expect(r.error!.message).toContain("at most 2");
    r = await kit.run("compare_bing_search_periods", { current_start_date: "2026-10-20" });
    expect(r.error!.message).toContain("all four dates");
    r = await kit.run("compare_bing_search_periods", { current_start_date: "2026-10-20", current_end_date: "2026-11-05", previous_start_date: "2026-10-01", previous_end_date: "2026-10-20" });
    expect(r.error!.message).toContain("must end before");
    r = await kit.run("compare_bing_search_periods", { weeks: 27 });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
  });

  it("dimension page reads GetPageStats", async () => {
    fake.handlers.GetPageStats = () => [qs(`${SITE}a`, W[6], 1, 10), qs(`${SITE}a`, W[7], 3, 10)];
    const d = data(await kit.run("compare_bing_search_periods", { dimension: "page", weeks: 1 }));
    expect(d.risers.map((m: any) => m.key)).toEqual([`${SITE}a`]);
    expect(fake.of("GetQueryStats")).toHaveLength(0);
  });

  describe("site_totals", () => {
    beforeEach(() => {
      fake.handlers.GetRankAndTrafficStats = () => days("2026-10-01", 20).filter((d) => d !== "2026-10-18").map((d) => rt(d, 1, 10));
    });

    it("named: the latest weeks×7 days Bing returned vs the same length before, missing days reported", async () => {
      const d = data(await kit.run("compare_bing_search_periods", { dimension: "site_totals", weeks: 1 }));
      expect(d.current).toMatchObject({ basis: "days", first_date: "2026-10-14", last_date: "2026-10-20", count: 6, missing_days: 1, bucket_dates: [] });
      expect(d.previous).toMatchObject({ first_date: "2026-10-07", last_date: "2026-10-13", count: 7, missing_days: 0 });
      expect(d.totals_change).toEqual({ clicks: -1, impressions: -10, ctr: 0, avg_impression_position: null });
      expect(d.risers).toEqual([]);
      expect(d.equal_length).toBe(true);
      expect(d.notes.join(" ")).toContain("2026-10-14 to 2026-10-20 vs 2026-10-07 to 2026-10-13");
    });

    it("explicit: exact days, unequal lengths flagged, empty period refused", async () => {
      const d = data(await kit.run("compare_bing_search_periods", { dimension: "site_totals", current_start_date: "2026-10-15", current_end_date: "2026-10-20", previous_start_date: "2026-10-01", previous_end_date: "2026-10-05" }));
      expect(d.current).toMatchObject({ requested_start: "2026-10-15", count: 5, missing_days: 1 });
      expect(d.previous).toMatchObject({ count: 5, missing_days: 0 });
      expect(d.equal_length).toBe(false);
      const r = await kit.run("compare_bing_search_periods", { dimension: "site_totals", current_start_date: "2026-10-15", current_end_date: "2026-10-20", previous_start_date: "2026-09-01", previous_end_date: "2026-09-05" });
      expect(r.error).toMatchObject({ code: "invalid_argument" });
      expect(r.error!.message).toContain("2026-10-01 to 2026-10-20");
    });
  });
});
