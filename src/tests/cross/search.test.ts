import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { brandPattern } from "../../platforms/cross/search";
import { type CrossHarness, addDays, crossHarness, gscAnalytics, link } from "./harness";

const term = (searchTerm: string, cost: number, o: { clicks?: number; conversions?: number; impressions?: number } = {}) => ({
  searchTermView: { searchTerm },
  metrics: { impressions: String(o.impressions ?? 100), clicks: String(o.clicks ?? 10), costMicros: String(Math.round(cost * 1e6)), conversions: o.conversions ?? 0, conversionsValue: (o.conversions ?? 0) * 20 },
});

describe("Search Console combined tools", () => {
  let h: CrossHarness;
  let latest: string;
  beforeAll(async () => {
    h = await crossHarness("XS");
  });
  beforeEach(() => {
    h.google.reset();
    h.gsc.reset();
    h.google.search.search_term_view = [term("Blue Shoes", 20, { conversions: 2 }), term("blue  shoes", 5), term("red boots", 30), term("green hat", 3, { conversions: 1 }), term("running socks", 1)];
    latest = gscAnalytics(h.gsc, { queries: [["blue shoes", 50, 500, 2], ["Red Boots", 3, 300, 8], ["running socks", 5, 1000, 4], ["cheap socks", 1, 400, 30], ["green", 0, 0, 50]] });
  });

  describe("analyze_paid_organic_overlap", () => {
    it("joins normalised terms with queries, applies top_n, lists what had no organic row, and states period and zones", async () => {
      const env = await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads });
      expect(env.error).toBeUndefined();
      const d = env.data;
      expect(d.overlap.items).toEqual([{ search_term: "Blue Shoes", paid: { impressions: 200, clicks: 20, cost: 25, conversions: 2, conversion_value: 40 }, organic: { query: "blue shoes", clicks: 50, impressions: 500, ctr: 0.1, position: 2 } }]);
      expect(d.summary).toMatchObject({ paid_terms: 4, paid_cost: 59, with_organic_row: 3, overlap_terms: 1, overlap_cost: 25, currency_code: "USD" });
      expect(d.unmatched.paid_terms_without_organic_row.items).toEqual([{ search_term: "green hat", cost: 3, clicks: 10 }]);
      expect(d.period.end_date <= latest).toBe(true);
      expect(d.period.days).toBe(28);
      expect(d.period.time_zones).toEqual([{ source: "google_ads", account: "1234567890", time_zone: "America/New_York" }, { source: "google_search_console", account: "sc-domain:example.com", time_zone: "America/Los_Angeles" }]);
      expect(d.period.notes.join(" ")).toContain("not hour-aligned");
      expect(d.rules.join(" ")).toContain("NFKC");
      expect(d.coverage.sources.every((s: { complete: boolean }) => s.complete)).toBe(true);
      expect(d.accounts.map((a: { role: string }) => a.role)).toEqual(["google_ads", "search_console_site"]);
      // the same dates went to both sources
      expect(h.google.queries[0]).toContain(`BETWEEN '${d.period.start_date}' AND '${d.period.end_date}'`);
      const saBody = h.gsc.calls.find((c) => c.body?.dimensions?.[0] === "query")!.body;
      expect([saBody.startDate, saBody.endDate]).toEqual([d.period.start_date, d.period.end_date]);
    });

    it("top_n and limit change what is listed, and lists say when they are cut", async () => {
      const d = (await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, top_n: 10, limit: 1 })).data;
      expect(d.overlap).toMatchObject({ total: 3, returned: 1, truncated: true });
      expect(d.overlap.items[0].search_term).toBe("red boots");
    });

    it("fails clearly when no site is linked, and when two are", async () => {
      const none = await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gadsUnlinked });
      expect(none.error).toMatchObject({ code: "invalid_argument" });
      expect(none.error!.message).toContain("No Search Console site is linked to this Google Ads account");
      expect(none.error!.message).toContain("site_account_id");
      await link(h.db, h.tenantId, h.ids.gadsUnlinked, h.ids.site);
      await link(h.db, h.tenantId, h.ids.gadsUnlinked, h.ids.site2);
      const two = await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gadsUnlinked });
      expect(two.error!.message).toContain("Pass site_account_id");
      // an explicit id settles it (by Search Console's own site URL)
      const ok = await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gadsUnlinked, site_account_id: "https://shop.example.com/" });
      expect(ok.data.accounts[1].external_id).toBe("https://shop.example.com/");
    });

    it("an explicit id of another workspace or another platform is not_found", async () => {
      for (const id of [h.ids.foreignSite, "https://ro.example.com/", h.ids.prop]) {
        expect((await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, site_account_id: id })).error, id).toMatchObject({ code: "not_found" });
      }
    });

    it("explicit dates are used as given and checked against every zone", async () => {
      const start = addDays(latest, -6);
      const d = (await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, start_date: start, end_date: latest })).data;
      expect(d.period).toMatchObject({ start_date: start, end_date: latest, days: 7, basis: "explicit" });
      const future = await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, start_date: start, end_date: addDays(latest, 30) });
      expect(future.error).toMatchObject({ code: "invalid_argument" });
      expect((await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, start_date: start })).error).toMatchObject({ code: "invalid_argument" });
    });

    it("min_impressions is applied to the organic side", async () => {
      // "blue shoes" ranks 2 with 500 organic impressions
      const d = (await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, min_impressions: 501 })).data;
      expect(d.overlap.total).toBe(0);
      expect(d.summary).toMatchObject({ with_organic_row: 3, overlap_terms: 0 });
    });

    it("refuses an explicit end_date after Search Console's latest final day, naming the day to use", async () => {
      const env = await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads, start_date: addDays(latest, -6), end_date: addDays(latest, 1) });
      expect(env.error).toMatchObject({ code: "invalid_argument" });
      expect(env.error!.message).toContain(`Search Console's latest day with final data`);
      expect(env.error!.message).toContain(`Use end_date ${latest} or earlier`);
      expect(h.google.queries).toHaveLength(0); // refused before any spend was read
    });

    it("says when the Google Ads search-term read hit its 10,000-row cap", async () => {
      h.google.search.search_term_view = Array.from({ length: 10_000 }, (_, i) => term(`t${i}`, 1));
      const d = (await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads })).data;
      const src = d.coverage.sources.find((s: { source: string }) => s.source === "google_ads search_term_view");
      expect(src).toMatchObject({ rows_read: 10_000, complete: false });
      expect(src.note).toContain("10,000");
    });

    it("says when Search Console has more query rows than were read", async () => {
      const many: [string, number, number, number][] = Array.from({ length: 25_001 }, (_, i) => [`q${i}`, 1, 10, 5]);
      gscAnalytics(h.gsc, { queries: many });
      const d = (await h.run("analyze_paid_organic_overlap", { account_id: h.ids.gads })).data;
      const src = d.coverage.sources.find((s: { source: string }) => s.source.includes("search_console"));
      expect(src).toMatchObject({ rows_read: 25_000, complete: false });
      expect(src.note).toContain("25,000");
    });
  });

  describe("find_organic_keyword_gaps", () => {
    it("lists high-impression, low-CTR or low-position queries that are not keywords, with negative and paid-term flags", async () => {
      h.google.search.ad_group_criterion = [{ adGroupCriterion: { keyword: { text: "Blue Shoes" }, negative: false } }, { adGroupCriterion: { keyword: { text: "cheap socks" }, negative: true } }];
      h.google.search.campaign_criterion = [];
      const d = (await h.run("find_organic_keyword_gaps", { account_id: h.ids.gads, min_impressions: 300 })).data;
      expect(d.gaps.items.map((g: { query: string }) => g.query)).toEqual(["running socks", "cheap socks", "Red Boots"]);
      expect(d.gaps.items[0]).toMatchObject({ excluded_by_negative: false, has_paid_search_term_traffic: true, reasons: ["CTR 0.005 ≤ 0.02"] });
      expect(d.gaps.items[1]).toMatchObject({ excluded_by_negative: true, has_paid_search_term_traffic: false });
      expect(d.summary).toMatchObject({ meeting_thresholds: 3, already_keywords: 0, gaps: 3, keywords_read: 2 });
      expect(d.coverage.notes.join(" ")).toContain("shared negative lists");
    });
  });

  describe("find_organic_keyword_gaps: existing keywords", () => {
    it("a query equal to a positive keyword after normalising is not a gap and is counted as already a keyword", async () => {
      h.google.search.ad_group_criterion = [{ adGroupCriterion: { keyword: { text: "  Running   SOCKS " }, negative: false } }];
      h.google.search.campaign_criterion = [];
      const d = (await h.run("find_organic_keyword_gaps", { account_id: h.ids.gads, min_impressions: 300 })).data;
      expect(d.gaps.items.map((g: { query: string }) => g.query)).toEqual(["cheap socks", "Red Boots"]);
      expect(d.summary).toMatchObject({ meeting_thresholds: 3, already_keywords: 1, gaps: 2 });
    });
  });

  describe("find_converting_terms_without_content", () => {
    it("refuses an end_date after Search Console's latest final day instead of reporting those days as no organic impressions", async () => {
      const env = await h.run("find_converting_terms_without_content", { account_id: h.ids.gads, start_date: addDays(latest, -6), end_date: addDays(latest, 2) });
      expect(env.error).toMatchObject({ code: "invalid_argument" });
      expect(env.error!.message).toContain(`Use end_date ${latest} or earlier`);
    });

    it("lists converting terms with no organic impressions and counts the ones that have them", async () => {
      const d = (await h.run("find_converting_terms_without_content", { account_id: h.ids.gads })).data;
      expect(d.terms.items).toEqual([{ search_term: "green hat", paid: { impressions: 100, clicks: 10, cost: 3, conversions: 1, conversion_value: 20 } }]);
      expect(d.summary).toEqual({ converting_terms: 2, with_organic_impressions: 1, without_organic_impressions: 1, currency_code: "USD" });
      expect(h.google.queries[0]).toContain("metrics.conversions > 0");
      expect(d.coverage.notes.join(" ")).toContain("anonymised");
    });
  });

  describe("analyze_brand_search_trend", () => {
    it("builds a flag-free case-insensitive pattern", () => {
      expect(brandPattern("Acme Co.")).toBe("[aA][cC][mM][eE]\\s+[cC][oO]\\.");
      expect(new RegExp(brandPattern("Acme Co.")).test("buy ACME  co. shoes")).toBe(true);
    });

    it("shows branded clicks per week next to each linked account's spend, with no causal claim", async () => {
      gscAnalytics(h.gsc, { daily: (_d, branded) => (branded ? [2, 20] : [10, 100]) });
      h.google.search.customer = [];
      h.meta.insights = (level, p) => {
        if (level !== "account") return [];
        const { since, until } = JSON.parse(p.get("time_range")!);
        const out = [];
        for (let d = since; d <= until; d = addDays(d, 1)) out.push({ date_start: d, date_stop: d, spend: "5.00" });
        return out;
      };
      const env = await h.run("analyze_brand_search_trend", { account_id: h.ids.site, brand_terms: ["Example"], days: 14, granularity: "day", google_ads_account_ids: [h.ids.gads] });
      expect(env.error).toBeUndefined();
      const d = env.data;
      expect(d.brand_pattern).toBe("([eE][xX][aA][mM][pP][lL][eE])");
      const sent = h.gsc.calls.find((c) => c.body?.dimensionFilterGroups)!.body;
      expect(sent.dimensionFilterGroups[0].filters[0]).toEqual({ dimension: "query", operator: "includingRegex", expression: d.brand_pattern });
      expect(d.series).toHaveLength(14);
      expect(d.series[0]).toMatchObject({ branded_clicks: 2, all_clicks: 10, branded_share_of_clicks: 0.2 });
      expect(d.spend.map((s: { account: { platform: string } }) => s.account.platform)).toEqual(["google_ads", "meta_ads"]);
      expect(d.spend[1]).toMatchObject({ total: 70 });
      expect(d.spend[1].by_bucket).toHaveLength(14);
      expect(d.summary.change).toBe(0);
      expect(d.note).toContain("No causal claim");
      expect(d.coverage.not_checked).toEqual([]);
      const weekly = (await h.run("analyze_brand_search_trend", { account_id: h.ids.site, brand_terms: ["Example"], days: 28 })).data;
      for (const b of weekly.series.slice(1, -1)) expect(new Date(`${b.bucket_start}T00:00:00Z`).getUTCDay()).toBe(1);
    });

    it("the change compares the second half with the first (a rise is positive)", async () => {
      h.gsc.reset();
      const mid = addDays(latest, -7); // first half: latest-13 … latest-7
      gscAnalytics(h.gsc, { daily: (d, branded) => (branded ? [d > mid ? 3 : 1, 10] : [10, 100]) });
      const d = (await h.run("analyze_brand_search_trend", { account_id: h.ids.site2, brand_terms: ["shop"], granularity: "day", start_date: addDays(latest, -13), end_date: latest })).data;
      expect(d.summary).toEqual({ first_half_avg_branded_clicks: 1, second_half_avg_branded_clicks: 3, change: 2 });
    });

    it("refuses an end_date after Search Console's latest final day (those days would read as a drop to zero)", async () => {
      h.gsc.reset();
      gscAnalytics(h.gsc, { daily: () => [10, 100] });
      const env = await h.run("analyze_brand_search_trend", { account_id: h.ids.site2, brand_terms: ["shop"], granularity: "day", start_date: addDays(latest, -11), end_date: addDays(latest, 2) });
      expect(env.error).toMatchObject({ code: "invalid_argument" });
      expect(env.error!.message).toContain(`Use end_date ${latest} or earlier`);
      const ok = (await h.run("analyze_brand_search_trend", { account_id: h.ids.site2, brand_terms: ["shop"], granularity: "day", start_date: addDays(latest, -11), end_date: latest })).data;
      expect(ok.summary.change).toBe(0);
    });

    it("without linked ad accounts it still shows the trend and says spend was not checked", async () => {
      h.gsc.reset();
      gscAnalytics(h.gsc);
      const d = (await h.run("analyze_brand_search_trend", { account_id: h.ids.site2, brand_terms: ["shop"] })).data;
      // site2 is linked only to a Google Ads account (an earlier test linked it): Meta spend is reported as not checked
      expect(d.spend.map((s: { account: { platform: string } }) => s.account.platform)).toEqual(["google_ads"]);
      expect(d.coverage.not_checked.map((x: { source: string }) => x.source)).toEqual(["meta_ads"]);
    });
  });
});
