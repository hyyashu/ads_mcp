import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapTool } from "../../../inventory/mapping";
import { loadInventory } from "../../inventory";
import { crossTools } from "../../platforms/cross";
import { BING_BRAND_QUERY_CAP, weeksOf } from "../../platforms/cross/bing";
import { bingErr, wcfDay } from "../bing/fake-bing";
import { ga4Answer } from "./ga4-fixture";
import { type CrossHarness, addDays, crossHarness, gscAnalytics, link } from "./harness";

// search_engine google / bing / both on the combined search tools, and Bing index details in audit_ad_landing_pages.

const ENGINE_TOOLS = ["analyze_paid_organic_overlap", "find_organic_keyword_gaps", "find_converting_terms_without_content", "analyze_brand_search_trend", "audit_ad_landing_pages"];
const BING_SITE = "https://shop.example.com/";

const term = (searchTerm: string, cost: number, o: { clicks?: number; conversions?: number } = {}) => ({
  searchTermView: { searchTerm },
  metrics: { impressions: "100", clicks: String(o.clicks ?? 10), costMicros: String(Math.round(cost * 1e6)), conversions: o.conversions ?? 0, conversionsValue: (o.conversions ?? 0) * 20 },
});
/** One QueryStats row as Bing's JSON sample shapes it. */
const qs = (query: string, day: string, clicks: number, impressions: number, impPos: number, clickPos = impPos) => ({ __type: "QueryStats:#Microsoft.Bing.Webmaster.Api", AvgClickPosition: clickPos, AvgImpressionPosition: impPos, Clicks: clicks, Date: wcfDay(day), Impressions: impressions, Query: query });
const rt = (day: string, clicks: number, impressions: number) => ({ __type: "RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api", Clicks: clicks, Date: wcfDay(day), Impressions: impressions });
const ok = <T>(env: { error?: unknown; data: T }) => {
  expect(env.error).toBeUndefined();
  return env.data;
};

function bingAfterEach(get: () => CrossHarness) {
  afterEach(() => expect(get().bing.problems.splice(0), "Bing protocol problems").toEqual([]));
}

describe("combined tools: permissions name Bing's read scope, as the plan does", () => {
  it("each engine-aware tool declares webmaster.read and the same permissions and risk as inventory/mapping.ts", () => {
    const inv = loadInventory();
    for (const name of ENGINE_TOOLS) {
      const tool = crossTools.find((t) => t.name === name)!;
      const planned = mapTool(inv.find((t) => t.name === name)!);
      expect(tool.permissions.platformPermissions, name).toContain("webmaster.read");
      expect([...tool.permissions.platformPermissions].sort(), name).toEqual([...planned.platformPermissions].sort());
      expect(tool.kind, name).toBe("read");
      expect(planned.risk, name).toBe("read");
    }
  });

  it("weeksOf never presents an empty period as data", () => {
    const p = { start_date: "2026-10-01", end_date: "2026-10-28" };
    expect(weeksOf([], [], p)).toMatchObject({ has_data_in_period: false, bucket_dates_available: { first: null, last: null, count: 0 } });
    expect(weeksOf(["2026-09-01", "2026-09-08"], [], p).note).toContain("No Bing bucket is dated inside 2026-10-01 to 2026-10-28");
    expect(weeksOf(["2026-10-05", "2026-11-02"], ["2026-10-05"], p)).toMatchObject({ has_data_in_period: true, bucket_dates_used: ["2026-10-05"], bucket_dates_available: { first: "2026-10-05", last: "2026-11-02", count: 2 } });
  });
});

describe("search-term tools with search_engine", () => {
  let h: CrossHarness;
  let latest: string;
  let start: string;
  let weekA: string;
  let weekB: string;
  beforeAll(async () => {
    h = await crossHarness("XBS");
  });
  bingAfterEach(() => h);
  beforeEach(() => {
    h.google.reset();
    h.gsc.reset();
    h.bing.reset();
    h.google.search.search_term_view = [term("Blue Shoes", 20, { conversions: 2 }), term("red boots", 30), term("green hat", 3, { conversions: 1 }), term("running socks", 1)];
    h.google.search.ad_group_criterion = [{ adGroupCriterion: { keyword: { text: "Blue Shoes" }, negative: false } }];
    h.google.search.campaign_criterion = [];
    latest = gscAnalytics(h.gsc, { queries: [["blue shoes", 50, 500, 2], ["Red Boots", 3, 300, 8], ["running socks", 5, 1000, 4]] });
    start = addDays(latest, -27);
    weekA = addDays(latest, -20);
    weekB = addDays(latest, -13);
    h.bing.handlers.GetQueryStats = () => [
      qs("blue shoes", weekA, 8, 80, 2, 1.5),
      qs("Blue  Shoes", weekB, 2, 20, 4, 3),
      qs("red boots", addDays(latest, -40), 5, 50, 1), // before the period: never used
      qs("running socks", weekA, 1, 200, 12),
      qs("bing only query", weekB, 1, 150, 5),
    ];
  });
  const dates = () => ({ start_date: start, end_date: latest });

  it("google (the default) sends nothing to Bing and adds no Bing fields", async () => {
    for (const [name, args] of [
      ["analyze_paid_organic_overlap", { account_id: h.ids.gads }],
      ["find_organic_keyword_gaps", { account_id: h.ids.gads }],
      ["find_converting_terms_without_content", { account_id: h.ids.gads, search_engine: "google" }],
    ] as const) {
      const d = ok(await h.run(name, args));
      expect(d.bing, name).toBeUndefined();
      expect(d.search_engine, name).toBeUndefined();
      expect(d.accounts.map((a: { role: string }) => a.role), name).toEqual(["google_ads", "search_console_site"]);
    }
    expect(h.bing.calls).toEqual([]);
  });

  describe("analyze_paid_organic_overlap", () => {
    it("bing: joins paid terms with Bing's queries from the buckets dated inside the period, and names those buckets", async () => {
      const d = ok(await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, search_engine: "bing", ...dates() }));
      expect(h.gsc.calls).toEqual([]); // Google organic not read
      expect(d.search_engine).toBe("bing");
      expect(d.summary).toBeUndefined();
      expect(d.overlap).toBeUndefined();
      expect(d.accounts.map((a: { role: string; external_id: string }) => [a.role, a.external_id])).toEqual([["google_ads", "1234567890"], ["bing_webmaster_site", BING_SITE]]);
      expect(d.period.time_zones).toEqual([{ source: "google_ads", account: "1234567890", time_zone: "America/New_York" }]);
      const b = d.bing;
      expect(b.site.external_id).toBe(BING_SITE);
      expect(b.weeks).toMatchObject({ bucket_dates_used: [weekA, weekB], bucket_dates_available: { first: addDays(latest, -40), last: weekB, count: 3 }, has_data_in_period: true });
      expect(b.weeks.note).toContain(`dated ${weekA}, ${weekB}`);
      expect(b.weeks.note).toContain("bucket edges do not match the period's exact days");
      // "blue shoes" + "Blue  Shoes" merge: 10 clicks / 100 impressions, impression position (2×80 + 4×20) / 100
      expect(b.overlap.items).toEqual([{ search_term: "Blue Shoes", paid: { impressions: 100, clicks: 10, cost: 20, conversions: 2, conversion_value: 40 }, organic: { query: "blue shoes", clicks: 10, impressions: 100, ctr: 0.1, avg_impression_position: 2.4, avg_click_position: 1.8 } }]);
      expect(b.summary).toEqual({ paid_terms: 4, paid_cost: 54, with_organic_row: 2, overlap_terms: 1, overlap_cost: 20, overlap_share_of_cost: 0.3704, currency_code: "USD" });
      // red boots' only Bing row is before the period: it is unmatched, not zero
      expect(b.unmatched.paid_terms_without_organic_row.items.map((x: { search_term: string }) => x.search_term)).toEqual(["red boots", "green hat"]);
      expect(d.coverage.sources.map((s: { source: string }) => s.source)).toEqual(["google_ads search_term_view", "bing_webmaster query stats (weekly buckets)"]);
      expect(d.coverage.sources[1].note).toContain("4 of 5 rows are in buckets dated inside the period");
      expect(d.coverage.notes.join(" ")).toContain("never added together");
      expect(d.coverage.notes.join(" ")).not.toContain("Search Console");
      expect(d.rules.join(" ")).toContain("Bing's average impression position");
      const call = h.bing.of("GetQueryStats")[0]!;
      expect(call).toMatchObject({ http: "GET", token: "bing-tok" });
      expect(call.params.get("siteUrl")).toBe(BING_SITE);
    });

    it("both: Google at the top level exactly as with google, Bing beside it, never summed", async () => {
      const g = ok(await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, ...dates() }));
      const d = ok(await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, search_engine: "both", ...dates() }));
      expect(d.summary).toEqual(g.summary);
      expect(d.overlap).toEqual(g.overlap);
      expect(d.unmatched).toEqual(g.unmatched);
      expect(d.search_engine).toBe("both");
      expect(d.bing.summary.overlap_terms).toBe(1);
      expect(d.bing.overlap.items[0].organic.impressions).toBe(100); // Bing only; Google's 500 not added
      expect(d.accounts.map((a: { role: string }) => a.role)).toEqual(["google_ads", "search_console_site", "bing_webmaster_site"]);
      expect(d.coverage.sources.map((s: { source: string }) => s.source)).toEqual(["google_ads search_term_view", "google_search_console queries", "bing_webmaster query stats (weekly buckets)"]);
      expect(d.period.time_zones.map((z: { source: string }) => z.source)).toEqual(["google_ads", "google_search_console"]);
    });

    it("no Bing bucket inside the period: Bing figures are null with a note, never zeros", async () => {
      h.bing.handlers.GetQueryStats = () => [qs("blue shoes", addDays(latest, -60), 8, 80, 2), qs("red boots", addDays(latest, -53), 1, 10, 1)];
      const d = ok(await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, search_engine: "bing", ...dates() }));
      expect(d.bing).toMatchObject({ summary: null, overlap: null, unmatched: null, weeks: { has_data_in_period: false, bucket_dates_used: [] } });
      expect(d.bing.weeks.note).toContain("No Bing bucket is dated inside");
      expect(d.bing.weeks.note).toContain("nothing is shown as zero");
      h.bing.handlers.GetQueryStats = () => undefined; // {"d": null}
      const none = ok(await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, search_engine: "bing", ...dates() }));
      expect(none.bing.summary).toBeNull();
      expect(none.bing.weeks.note).toContain("Bing returned no query rows");
    });

    it("bing with the default period reads no Search Console data at all", async () => {
      const d = ok(await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, search_engine: "bing" }));
      expect(h.gsc.calls).toEqual([]);
      expect(d.period).toMatchObject({ days: 28, basis: "last_complete_days" });
    });

    it("Bing errors are mapped: a denied site is platform_permission_denied", async () => {
      h.bing.handlers.GetQueryStats = () => bingErr(14, "NotAuthorized");
      expect((await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, search_engine: "bing" })).error).toMatchObject({ code: "platform_permission_denied" });
    });

    it("refuses ids that do not fit the chosen engine", async () => {
      const e1 = await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, bing_site_account_id: h.ids.bing });
      expect(e1.error).toMatchObject({ code: "invalid_argument" });
      expect(e1.error!.message).toContain("only used with search_engine bing or both");
      const e2 = await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, search_engine: "bing", site_account_id: h.ids.site });
      expect(e2.error!.message).toContain("site_account_id is only used with search_engine google or both");
      expect((await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, search_engine: "sideways" })).error).toMatchObject({ code: "invalid_argument" });
      expect(h.bing.calls).toEqual([]);
    });

    it("an explicit Bing id of another workspace or another platform is not_found", async () => {
      for (const id of [h.ids.foreignBing, "https://ro.example.com/", h.ids.site, "sc-domain:example.com"]) {
        expect((await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, search_engine: "bing", bing_site_account_id: id })).error, id).toMatchObject({ code: "not_found" });
      }
      expect(h.bing.calls).toEqual([]);
    });
  });

  describe("find_organic_keyword_gaps", () => {
    it("bing: Bing queries with low CTR or poor impression position that are not keywords", async () => {
      const d = ok(await h.run("find_organic_keyword_gaps", { account_id: h.ids.gads, search_engine: "bing", ...dates() }));
      expect(d.gaps).toBeUndefined();
      expect(d.bing.gaps.items.map((x: { query: string; reasons: string[]; has_paid_search_term_traffic: boolean }) => [x.query, x.reasons, x.has_paid_search_term_traffic])).toEqual([
        ["running socks", ["CTR 0.005 ≤ 0.02", "average position 12 > 10"], true],
        ["bing only query", ["CTR 0.0067 ≤ 0.02"], false],
      ]);
      expect(d.bing.summary).toEqual({ queries_read: 3, meeting_thresholds: 2, already_keywords: 0, gaps: 2, keywords_read: 1 });
      expect(d.bing.weeks.bucket_dates_used).toEqual([weekA, weekB]);
    });

    it("both: Google's gaps unchanged at the top level, Bing's beside them", async () => {
      const g = ok(await h.run("find_organic_keyword_gaps", { account_id: h.ids.gads, min_impressions: 100, ...dates() }));
      const d = ok(await h.run("find_organic_keyword_gaps", { account_id: h.ids.gads, min_impressions: 100, search_engine: "both", ...dates() }));
      expect(d.gaps).toEqual(g.gaps);
      expect(d.summary).toEqual(g.summary);
      expect(d.bing.summary.gaps).toBe(2);
    });
  });

  describe("find_converting_terms_without_content", () => {
    it("bing: converting terms with no Bing impressions in the buckets used", async () => {
      const d = ok(await h.run("find_converting_terms_without_content", { account_id: h.ids.gads, search_engine: "bing", ...dates() }));
      expect(d.terms).toBeUndefined();
      expect(d.bing.terms.items).toEqual([{ search_term: "green hat", paid: { impressions: 100, clicks: 10, cost: 3, conversions: 1, conversion_value: 20 } }]);
      expect(d.bing.summary).toEqual({ converting_terms: 2, with_organic_impressions: 1, without_organic_impressions: 1, currency_code: "USD" });
      expect(d.rules.join(" ")).not.toContain("Search Console web query row");
      expect(d.rules.join(" ")).toContain("Bing lists only its top queries");
    });

    it("both: side by side", async () => {
      const d = ok(await h.run("find_converting_terms_without_content", { account_id: h.ids.gads, search_engine: "both", ...dates() }));
      expect(d.summary).toEqual({ converting_terms: 2, with_organic_impressions: 1, without_organic_impressions: 1, currency_code: "USD" });
      expect(d.bing.summary.converting_terms).toBe(2);
    });
  });

  describe("Bing site resolution", () => {
    it("fails clearly when no Bing site is linked, and when two are; an explicit id settles it", async () => {
      const none = await h.run("find_organic_keyword_gaps", { account_id: h.ids.gadsUnlinked, search_engine: "bing" });
      expect(none.error).toMatchObject({ code: "invalid_argument" });
      expect(none.error!.message).toContain("No Bing Webmaster site is linked to this Google Ads account");
      expect(none.error!.message).toContain("bing_site_account_id");
      await link(h.db, h.tenantId, h.ids.gadsUnlinked, h.ids.bing);
      await link(h.db, h.tenantId, h.ids.gadsUnlinked, h.ids.bing2);
      const two = await h.run("find_organic_keyword_gaps", { account_id: h.ids.gadsUnlinked, search_engine: "bing" });
      expect(two.error!.message).toContain("Pass bing_site_account_id");
      expect(h.bing.calls).toEqual([]);
      const named = ok(await h.run("find_organic_keyword_gaps", { account_id: h.ids.gadsUnlinked, search_engine: "bing", bing_site_account_id: "https://www.example.com/", ...dates() }));
      expect(named.bing.site.external_id).toBe("https://www.example.com/");
      expect(h.bing.of("GetQueryStats")[0]!.params.get("siteUrl")).toBe("https://www.example.com/");
    });
  });
});

describe("analyze_brand_search_trend with search_engine", () => {
  let h: CrossHarness;
  let latest: string;
  beforeAll(async () => {
    h = await crossHarness("XBB");
  });
  bingAfterEach(() => h);
  beforeEach(() => {
    h.google.reset();
    h.gsc.reset();
    h.bing.reset();
    h.google.search.customer = [];
    latest = gscAnalytics(h.gsc, { daily: (_d, branded) => (branded ? [2, 20] : [10, 100]) });
    h.bing.handlers.GetQueryStats = () => [qs("blue shoes", addDays(latest, -30), 5, 100, 2), qs("buy blue hats", addDays(latest, -30), 1, 50, 6), qs("red boots", addDays(latest, -30), 9, 900, 1)];
    // site traffic for every day of the week except the last one
    h.bing.handlers.GetRankAndTrafficStats = () => Array.from({ length: 6 }, (_, i) => rt(addDays(latest, -6 + i), 10, 100));
    h.bing.handlers.GetQueryTrafficStats = (c) => {
      const q = c.params.get("query");
      const per = q === "blue shoes" ? [2, 20] : q === "buy blue hats" ? [1, 10] : [0, 0];
      return Array.from({ length: 6 }, (_, i) => rt(addDays(latest, -6 + i), per[0]!, per[1]!));
    };
  });
  const week = () => ({ granularity: "day", start_date: addDays(latest, -6), end_date: latest });

  it("google (default) sends nothing to Bing", async () => {
    const d = ok(await h.run("analyze_brand_search_trend", { account_id: h.ids.site, brand_terms: ["Blue"], ...week() }));
    expect(d.bing).toBeUndefined();
    expect(d.brand_pattern).toBeDefined();
    expect(h.bing.calls).toEqual([]);
  });

  it("bing: branded traffic from Bing's top queries containing a brand term, per bucket; days without Bing data are null", async () => {
    const b = ok(await h.run("analyze_brand_search_trend", { account_id: h.ids.site, brand_terms: ["Blue"], search_engine: "bing", ...week() }));
    expect(h.gsc.calls).toEqual([]); // Search Console not read at all
    expect(b.brand_pattern).toBeUndefined();
    expect(b.series).toBeUndefined();
    expect(b.summary).toBeUndefined();
    expect(b.spend.map((s: { account: { platform: string } }) => s.account.platform)).toEqual(["google_ads", "meta_ads"]);
    expect(b.accounts.map((a: { role: string }) => a.role)).toEqual(["spend_google_ads", "spend_meta", "bing_webmaster_site"]);
    expect(b.bing.site.external_id).toBe(BING_SITE);
    // queries by impressions; red boots has no brand term
    expect(h.bing.of("GetQueryTrafficStats").map((c) => c.params.get("query"))).toEqual(["blue shoes", "buy blue hats"]);
    expect(b.bing.branded_queries).toEqual([
      { query: "blue shoes", clicks_in_bing_window: 5, impressions_in_bing_window: 100, traffic_rows: 6 },
      { query: "buy blue hats", clicks_in_bing_window: 1, impressions_in_bing_window: 50, traffic_rows: 6 },
    ]);
    expect(b.bing.branded_queries_found).toBe(2);
    expect(b.bing.series).toHaveLength(7);
    expect(b.bing.series[0]).toEqual({ bucket_start: addDays(latest, -6), bucket_end: addDays(latest, -6), bing_days_with_data: 1, branded_clicks: 3, branded_impressions: 30, all_clicks: 10, all_impressions: 100, branded_share_of_clicks: 0.3 });
    expect(b.bing.series[6]).toMatchObject({ bing_days_with_data: 0, branded_clicks: null, all_clicks: null, branded_share_of_clicks: null });
    expect(b.bing.summary).toEqual({ first_half_avg_branded_clicks: 3, second_half_avg_branded_clicks: 3, change: 0 });
    expect(b.coverage.sources.map((s: { source: string }) => s.source)).toEqual([
      "google_ads daily spend",
      "meta_ads daily spend",
      "bing_webmaster top queries (to find branded queries)",
      "bing_webmaster query traffic (per branded query)",
      "bing_webmaster site traffic (daily)",
    ]);
    const notes = b.coverage.notes.join(" ");
    expect(notes).toContain("Only top-queries will be saved and returned by this method");
    expect(notes).toContain("undercounted");
    expect(notes).not.toContain("Search Console dates");
    expect(b.note).toContain("No causal claim");
    expect(b.note).toContain("never added");
  });

  it("both: Google's series unchanged at the top level, Bing's beside it", async () => {
    const g = ok(await h.run("analyze_brand_search_trend", { account_id: h.ids.site, brand_terms: ["Blue"], ...week() }));
    const d = ok(await h.run("analyze_brand_search_trend", { account_id: h.ids.site, brand_terms: ["Blue"], search_engine: "both", ...week() }));
    expect(d.series).toEqual(g.series);
    expect(d.summary).toEqual(g.summary);
    expect(d.brand_pattern).toBe(g.brand_pattern);
    expect(d.accounts.map((a: { role: string }) => a.role)).toEqual(["search_console_site", "spend_google_ads", "spend_meta", "bing_webmaster_site"]);
    expect(d.series[0].branded_clicks).toBe(2);
    expect(d.bing.series[0].branded_clicks).toBe(3);
  });

  it("no Bing top query contains a brand term: branded traffic is unknown (null), not zero, and no per-query call is made", async () => {
    const d = ok(await h.run("analyze_brand_search_trend", { account_id: h.ids.site, brand_terms: ["zzz"], search_engine: "bing", ...week() }));
    expect(d.bing.branded_queries).toEqual([]);
    expect(d.bing.series[0]).toMatchObject({ branded_clicks: null, all_clicks: 10 });
    expect(d.bing.summary.change).toBeNull();
    expect(d.coverage.notes.join(" ")).toContain("unknown (null), not zero");
    expect(h.bing.of("GetQueryTrafficStats")).toHaveLength(0);
  });

  it(`reads at most ${BING_BRAND_QUERY_CAP} branded queries and says the rest were not read`, async () => {
    h.bing.handlers.GetQueryStats = () => Array.from({ length: 25 }, (_, i) => qs(`blue ${i}`, addDays(latest, -30), 1, 100 - i, 3));
    const d = ok(await h.run("analyze_brand_search_trend", { account_id: h.ids.site, brand_terms: ["blue"], search_engine: "bing", ...week() }));
    expect(h.bing.of("GetQueryTrafficStats")).toHaveLength(BING_BRAND_QUERY_CAP);
    expect(d.bing).toMatchObject({ branded_queries_found: 25 });
    expect(d.bing.branded_queries).toHaveLength(BING_BRAND_QUERY_CAP);
    const src = d.coverage.sources.find((s: { source: string }) => s.source.includes("per branded query"));
    expect(src).toMatchObject({ complete: false });
    expect(src.note).toContain("5 more were not");
  });

  it("Bing site traffic outside the period: Bing figures are null with a note", async () => {
    h.bing.handlers.GetRankAndTrafficStats = () => [rt(addDays(latest, -100), 1, 1)];
    h.bing.handlers.GetQueryTrafficStats = () => [rt(addDays(latest, -100), 1, 1)];
    const d = ok(await h.run("analyze_brand_search_trend", { account_id: h.ids.site, brand_terms: ["Blue"], search_engine: "bing", ...week() }));
    expect(d.bing.series.every((s: { all_clicks: number | null; branded_clicks: number | null }) => s.all_clicks === null && s.branded_clicks === null)).toBe(true);
    expect(d.coverage.notes.join(" ")).toContain("no day falls inside the period");
  });

  it("the Bing site is the one linked to the Search Console site; none linked or a foreign id is refused", async () => {
    const none = await h.run("analyze_brand_search_trend", { account_id: h.ids.site2, brand_terms: ["shop"], search_engine: "bing" });
    expect(none.error).toMatchObject({ code: "invalid_argument" });
    expect(none.error!.message).toContain("No Bing Webmaster site is linked to this Search Console site");
    expect((await h.run("analyze_brand_search_trend", { account_id: h.ids.site, brand_terms: ["shop"], search_engine: "both", bing_site_account_id: h.ids.foreignBing })).error).toMatchObject({ code: "not_found" });
    expect(h.bing.calls).toEqual([]);
    const named = ok(await h.run("analyze_brand_search_trend", { account_id: h.ids.site2, brand_terms: ["shop"], search_engine: "bing", bing_site_account_id: h.ids.bing2, ...week() }));
    expect(named.bing.site.external_id).toBe("https://www.example.com/");
  });
});

describe("audit_ad_landing_pages with search_engine", () => {
  let h: CrossHarness;
  beforeAll(async () => {
    h = await crossHarness("XBL");
  });
  bingAfterEach(() => h);
  const ad = (id: string, url: string, clicks: number) => ({ adGroupAd: { ad: { id, finalUrls: [url] } }, metrics: { impressions: String(clicks * 10), clicks: String(clicks), costMicros: "1000000" } });
  beforeEach(() => {
    h.google.reset();
    h.gsc.reset();
    h.ga4.reset();
    h.bing.reset();
    h.google.search.ad_group_ad = [ad("1", "https://shop.example.com/shoes/?utm_source=x", 50), ad("2", "https://shop.example.com/boots", 20), ad("3", "https://other.net/x", 10), ad("4", "https://shop.example.com/hats", 5)];
    h.ga4.report = ga4Answer({ landingPage: { rows: [{ dims: ["/shoes"], m: { sessions: 10 } }] } });
    h.gsc.inspect = () => ({ inspectionResult: { indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" } } });
    h.bing.handlers.GetUrlInfo = (c) => {
      const url = c.params.get("url") ?? "";
      if (url.includes("boots")) return bingErr(11, "NotFound");
      if (url.includes("hats")) return { __type: "UrlInfo:#Microsoft.Bing.Webmaster.Api", AnchorCount: 0, DiscoveryDate: "/Date(-62135596800000)/", DocumentSize: 0, HttpStatus: 0, IsPage: false, LastCrawledDate: "/Date(-62135596800000)/", TotalChildUrlCount: 0, Url: url };
      return { __type: "UrlInfo:#Microsoft.Bing.Webmaster.Api", AnchorCount: 50, DiscoveryDate: "/Date(1315349995266-0700)/", DocumentSize: 1200, HttpStatus: 200, IsPage: true, LastCrawledDate: "/Date(1316213995266-0700)/", TotalChildUrlCount: 0, Url: url };
    };
  });

  it("google (default): no Bing call and no bing_index field", async () => {
    const d = ok(await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, inspect_max: 5 }));
    expect(d.pages.items.every((p: object) => !("bing_index" in p))).toBe(true);
    expect("bing_checked" in d.summary).toBe(false);
    expect(h.bing.calls).toEqual([]);
  });

  it("bing: samples Bing's index details for pages inside the Bing site and skips Google's inspection", async () => {
    const d = ok(await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, search_engine: "bing", inspect_max: 3 }));
    expect(h.gsc.calls.filter((c) => c.url.hostname === "searchconsole.googleapis.com")).toHaveLength(0);
    const byPath = Object.fromEntries(d.pages.items.map((p: { path: string }) => [p.path, p]));
    expect(byPath["/shoes"].index.status).toBe("not_requested");
    expect(byPath["/shoes"].bing_index).toEqual({ status: "has_index_details", discovery_date: new Date(1315349995266).toISOString(), last_crawled_date: new Date(1316213995266).toISOString(), http_status: 200, is_page: true, anchor_count: 50, detail: null });
    expect(byPath["/boots"].bing_index).toMatchObject({ status: "no_index_details", detail: expect.stringContaining("NotFound") });
    expect(byPath["/x"].bing_index.status).toBe("outside_site");
    expect(byPath["/hats"].bing_index).toMatchObject({ status: "no_index_details", discovery_date: null, detail: expect.stringContaining("no discovery or crawl date") });
    expect(d.summary).toMatchObject({ inspected: 0, bing_checked: 3, bing_without_index_details: 2 });
    const calls = h.bing.of("GetUrlInfo");
    expect(calls.map((c) => c.params.get("url"))).toEqual(["https://shop.example.com/shoes/", "https://shop.example.com/boots", "https://shop.example.com/hats"]);
    expect(calls.every((c) => c.http === "GET" && c.params.get("siteUrl") === BING_SITE)).toBe(true);
    expect(d.coverage.not_checked).toContainEqual({ source: "google_search_console URL inspection", reason: "Not requested: search_engine is bing." });
    expect(d.coverage.sources.find((s: { source: string }) => s.source.startsWith("bing_webmaster")).note).toContain("Sampled");
    expect(d.rules.join(" ")).toContain("defines no 'indexed' verdict");
    expect(d.rules.join(" ")).not.toContain("verdict PASS means indexed");
    expect(d.accounts.map((a: { role: string }) => a.role)).toEqual(["google_ads", "ga4_property", "bing_webmaster_site"]);
  });

  it("both: Search Console inspection and Bing details side by side; the sample size applies to each", async () => {
    const d = ok(await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, search_engine: "both", inspect_max: 1 }));
    const [shoes, boots] = d.pages.items;
    expect(shoes.index).toMatchObject({ status: "inspected", verdict: "PASS" });
    expect(shoes.bing_index.status).toBe("has_index_details");
    expect(boots.index.status).toBe("not_sampled");
    expect(boots.bing_index.status).toBe("not_sampled");
    expect(h.bing.of("GetUrlInfo")).toHaveLength(1);
    expect(d.summary).toMatchObject({ inspected: 1, bing_checked: 1 });
    expect(d.accounts.map((a: { role: string }) => a.role)).toEqual(["google_ads", "ga4_property", "search_console_site", "bing_webmaster_site"]);
  });

  it("stops checking when Bing throttles and marks the rest", async () => {
    h.bing.handlers.GetUrlInfo = () => bingErr(4, "ThrottleUser");
    const d = ok(await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, search_engine: "bing", inspect_max: 5 }));
    expect(d.pages.items.filter((p: { bing_index: { status: string } }) => p.bing_index.status === "quota_reached")).toHaveLength(3);
    expect(h.bing.of("GetUrlInfo")).toHaveLength(1);
    expect(d.summary.bing_checked).toBe(0);
  });

  it("a Bing permission error stops the check; other errors are per page", async () => {
    let n = 0;
    h.bing.handlers.GetUrlInfo = () => (n++ === 0 ? bingErr(7, "InvalidUrl") : bingErr(14, "NotAuthorized"));
    const d = ok(await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, search_engine: "bing", inspect_max: 5 }));
    const st = d.pages.items.filter((p: { path: string }) => p.path !== "/x").map((p: { bing_index: { status: string; detail: string } }) => p.bing_index);
    expect(st[0]).toMatchObject({ status: "error" });
    expect(st[1]).toMatchObject({ status: "error", detail: expect.stringContaining("Bing check stopped") });
    expect(st[2]).toMatchObject({ status: "error", detail: expect.stringContaining("Bing check stopped") });
    expect(h.bing.of("GetUrlInfo")).toHaveLength(2);
  });

  it("needs a Bing site when Bing is requested; foreign ids are not_found", async () => {
    const none = await h.run("audit_ad_landing_pages", { account_id: h.ids.gadsUnlinked, property_account_id: h.ids.prop, search_engine: "bing" });
    expect(none.error).toMatchObject({ code: "invalid_argument" });
    expect(none.error!.message).toContain("No Bing Webmaster site is linked to this Google Ads account");
    expect((await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, search_engine: "both", bing_site_account_id: h.ids.foreignBing })).error).toMatchObject({ code: "not_found" });
    expect((await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, bing_site_account_id: h.ids.bing })).error).toMatchObject({ code: "invalid_argument" });
    expect(h.bing.calls).toEqual([]);
  });
});
