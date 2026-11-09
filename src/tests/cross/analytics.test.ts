import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { utmsByCampaign } from "../../platforms/cross/analytics";
import { ga4Answer } from "./ga4-fixture";
import { type CrossHarness, crossHarness } from "./harness";

const purchase = (n: number) => [{ action_type: "offsite_conversion.fb_pixel_purchase", value: String(n) }];
const metaAd = (id: string, campaign_id: string, link: string | null, url_tags?: string) => ({ id, campaign_id, effective_status: "ACTIVE", creative: { ...(url_tags ? { url_tags } : {}), ...(link ? { object_story_spec: { link_data: { link } } } : {}) } });

describe("GA4 combined tools", () => {
  let h: CrossHarness;
  beforeAll(async () => {
    h = await crossHarness("XA");
  });
  beforeEach(() => {
    h.google.reset();
    h.ga4.reset();
    h.meta.requests.length = 0;
    h.meta.ads = [
      metaAd("a1", "c1", "https://shop.example/spring", "utm_source=facebook&utm_medium=paid_social&utm_campaign=spring"),
      metaAd("a2", "c2", "https://shop.example/x", "utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}"),
      metaAd("a3", "c3", "https://shop.example/y"),
      metaAd("a4", "c4", "https://shop.example/z?utm_source=facebook&utm_medium=paid_social&utm_campaign=winter"),
      metaAd("a5", "c1", "https://shop.example/spring2", "utm_source=facebook&utm_medium=paid_social&utm_campaign=Spring"),
    ];
    h.meta.campaigns = [{ id: "c1", name: "Spring" }, { id: "c2", name: "Dyn" }, { id: "c3", name: "Untagged" }, { id: "c4", name: "Winter" }];
    h.meta.insights = (level) =>
      level === "campaign"
        ? [
            { campaign_id: "c1", campaign_name: "Spring", spend: "100", clicks: "80", inline_link_clicks: "50", actions: purchase(10) },
            { campaign_id: "c2", campaign_name: "Dyn", spend: "40", clicks: "10", inline_link_clicks: "8" },
            { campaign_id: "c3", campaign_name: "Untagged", spend: "30", clicks: "5", inline_link_clicks: "5" },
            { campaign_id: "c4", campaign_name: "Winter", spend: "20", clicks: "5", inline_link_clicks: "5" },
            { campaign_id: "c9", campaign_name: "No ads", spend: "10", clicks: "1", inline_link_clicks: "1" },
          ]
        : [{ date_start: "x", spend: "0" }];
    h.ga4.report = ga4Answer({
      sessionManualSource: {
        rows: [
          { dims: ["facebook", "paid_social", "spring"], m: { sessions: 40, engagedSessions: 30, keyEvents: 4, totalRevenue: 100 } },
          { dims: ["Facebook", "paid_social", "SPRING"], m: { sessions: 10, engagedSessions: 2, keyEvents: 0, totalRevenue: 0 } },
          { dims: ["ig", "(not set)", "story"], m: { sessions: 7, keyEvents: 0 } },
          { dims: ["newsletter", "email", "nov"], m: { sessions: 5 } },
        ],
      },
      sessionGoogleAdsCampaignId: {
        rows: [
          { dims: ["111", "Brand"], m: { sessions: 300, keyEvents: 5 } },
          { dims: ["222", "Generic"], m: { sessions: 100, keyEvents: 9 } },
          { dims: ["999", "Other account"], m: { sessions: 10, keyEvents: 1 } },
        ],
      },
      sessionDefaultChannelGroup: {
        rows: [
          { dims: ["Paid Search"], m: { sessions: 400, keyEvents: 20, totalRevenue: 500, engagementRate: 0.6 } },
          { dims: ["Organic Search"], m: { sessions: 600, keyEvents: 20, totalRevenue: 500, engagementRate: 0.7 } },
        ],
        totals: { sessions: 1000, keyEvents: 40, totalRevenue: 1000 },
      },
      sessionGoogleAdsCampaignId_query: { rows: [] },
    });
    h.google.search.campaign = (q) =>
      q.includes("conversions_by_conversion_date")
        ? [
            { campaign: { id: "111", name: "Brand" }, metrics: { conversionsByConversionDate: 20, conversions: 22 } },
            { campaign: { id: "222", name: "Generic" }, metrics: { conversionsByConversionDate: 10, conversions: 9 } },
          ]
        : [
            { campaign: { id: "111", name: "Brand", finalUrlSuffix: "utm_source=google&utm_medium=cpc" } },
            { campaign: { id: "222", name: "Generic" } },
          ];
    h.google.search.customer = (q) => (q.includes("auto_tagging") ? [{ customer: { autoTaggingEnabled: false } }] : [{ metrics: { costMicros: "250000000" } }]);
  });

  it("utmsByCampaign keeps dynamic and missing values apart", () => {
    const u = utmsByCampaign([
      { ad_id: "1", campaign_id: "c", effective_status: null, link: null, url_tags: null, utm: { utm_source: "fb", utm_medium: null, utm_campaign: "{{campaign.id}}" } },
      { ad_id: "2", campaign_id: "c", effective_status: null, link: null, url_tags: null, utm: { utm_source: "fb", utm_medium: null, utm_campaign: null } },
    ]).get("c")!;
    expect([u.ads, u.pairs.size, u.dynamic.size, u.missing]).toEqual([2, 0, 1, 1]);
  });

  describe("analyze_meta_traffic_quality", () => {
    it("matches campaigns through UTM tags only and lists every campaign it could not match, with the reason", async () => {
      const env = await h.run("analyze_meta_traffic_quality", { account_id: h.ids.meta });
      expect(env.error).toBeUndefined();
      const d = env.data;
      expect(d.campaigns.items).toEqual([
        {
          campaign_id: "c1",
          name: "Spring",
          meta: { spend: 100, clicks: 80, link_clicks: 50, conversions: 10 },
          utm: [{ source: "facebook", campaign: "spring" }],
          ga4: { sessions: 50, engaged_sessions: 32, engagement_rate: 0.64, key_events: 4, total_revenue: 100, ga4_rows: 2 },
          sessions_per_link_click: 1,
          ads_without_usable_utm: 0,
        },
      ]);
      expect(d.unmatched.campaigns.items.map((u: { campaign_id: string; reason: string }) => [u.campaign_id, u.reason])).toEqual([
        ["c2", "dynamic_parameter"],
        ["c3", "no_utm_source_or_campaign"],
        ["c4", "no_ga4_sessions"],
        ["c9", "no_ads_read"],
      ]);
      expect(d.unmatched.campaigns.items[0].detail).toContain("{{campaign.name}}");
      expect(d.unmatched.ga4_meta_like_rows_not_claimed.items).toEqual([{ source: "ig", medium: "(not set)", campaign: "story", sessions: 7, key_events: 0 }]);
      expect(d.summary).toEqual({ campaigns: 5, matched: 1, unmatched: 4, matched_spend_share: 0.5 });
      expect(d.period.time_zones.map((z: { time_zone: string }) => z.time_zone)).toEqual(["America/Chicago", "Europe/Berlin"]);
      expect(d.rules.join(" ")).toContain("dynamic parameters");
      const insight = h.meta.requests.find((r) => r.path === "act_987/insights")!;
      expect(JSON.parse(insight.params.get("time_range")!)).toEqual({ since: d.period.start_date, until: d.period.end_date });
      const ga4Body = h.ga4.dataCalls("runReport")[0]!.body;
      expect(ga4Body.dateRanges).toEqual([{ startDate: d.period.start_date, endDate: d.period.end_date }]);
    });

    it("needs a GA4 property; another workspace's property is not_found", async () => {
      expect((await h.run("analyze_meta_traffic_quality", { account_id: h.ids.meta, property_account_id: h.ids.foreignProp })).error).toMatchObject({ code: "not_found" });
      expect((await h.run("analyze_meta_traffic_quality", { account_id: h.ids.meta, property_account_id: "properties/123", limit: 1 })).data.unmatched.campaigns).toMatchObject({ total: 4, returned: 1, truncated: true });
    });
  });

  describe("compare_conversion_tracking", () => {
    it("compares per campaign, flags gaps above the threshold, lists campaigns it could not match and the reasons a gap is normal", async () => {
      const d = (await h.run("compare_conversion_tracking", { account_id: h.ids.prop })).data;
      const byId = Object.fromEntries(d.campaigns.items.map((c: { campaign_id: string }) => [c.campaign_id, c]));
      expect(byId["111"]).toMatchObject({ platform: "google_ads", platform_conversions: 20, platform_conversions_by_click_date: 22, ga4_key_events: 5, gap: 15, relative_gap: 0.75, flagged: true });
      expect(byId["222"]).toMatchObject({ platform_conversions: 10, ga4_key_events: 9, relative_gap: 0.1, flagged: false });
      expect(byId["c1"]).toMatchObject({ platform: "meta_ads", platform_conversions: 10, ga4_key_events: 4, flagged: true });
      expect(d.unmatched.ga4_google_ads_campaigns_not_in_accounts.items).toEqual([{ campaign_id: "999", campaign: "Other account", key_events: 1, sessions: 10 }]);
      expect(d.unmatched.meta_campaigns.total).toBe(4);
      expect(d.summary).toMatchObject({ campaigns_compared: 3, flagged: 2, google_ads_conversions: 30, google_ads_ga4_key_events: 14 });
      expect(d.reasons_a_gap_can_be_normal.join(" ")).toContain("ad-click date");
      expect(JSON.stringify(d)).not.toMatch(/\bis (correct|right|wrong)\b/);
      expect(d.accounts.map((a: { role: string }) => a.role)).toEqual(["ga4_property", "google_ads", "meta_ads"]);
    });

    it("refuses when no ad account is linked or named, and an explicit foreign id is not_found", async () => {
      const lone = (await import("../support/helpers")).seedAccount;
      const p2 = (await lone(h.db, h.tenantId, "google_analytics", "read", "active", "properties/777", { currencyCode: "EUR", timeZone: "Europe/Berlin" })).id;
      const env = await h.run("compare_conversion_tracking", { account_id: p2 });
      expect(env.error).toMatchObject({ code: "invalid_argument" });
      expect(env.error!.message).toContain("google_ads_account_ids");
      expect((await h.run("compare_conversion_tracking", { account_id: h.ids.prop, google_ads_account_ids: [h.ids.foreignSite] })).error).toMatchObject({ code: "not_found" });
    });
  });

  it("get_channel_mix: shares of GA4's totals and spend per account, never summed across currencies", async () => {
    h.meta.insights = () => [{ date_start: "2026-11-01", spend: "12.5" }];
    const d = (await h.run("get_channel_mix", { account_id: h.ids.prop })).data;
    expect(d.channels[0]).toMatchObject({ channel: "Paid Search", sessions: 400, share_of_sessions: 0.4, share_of_key_events: 0.5, share_of_revenue: 0.5 });
    expect(d.totals).toEqual({ sessions: 1000, key_events: 40, total_revenue: 1000 });
    expect(d.ad_spend.map((s: { account: { platform: string; currency_code: string }; spend: number }) => [s.account.platform, s.account.currency_code, s.spend])).toEqual([["google_ads", "USD", 250], ["meta_ads", "USD", 12.5]]);
    expect(d.coverage.notes.join(" ")).toContain("side by side only");
    expect(JSON.stringify(d)).not.toContain("total_spend");
  });

  it("check_utm_tagging: auto-tagging, untagged and dynamic Meta campaigns, GA4 case variants and missing mediums", async () => {
    const d = (await h.run("check_utm_tagging", { account_id: h.ids.prop })).data;
    const rules = d.findings.map((f: { rule: string }) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(["auto_tagging_off", "no_auto_tagging_and_no_utm", "campaign_untagged", "dynamic_parameters", "utm_source_case_variants", "utm_campaign_case_variants", "source_without_medium"]));
    const untaggedAds = d.findings.find((f: { rule: string }) => f.rule === "no_auto_tagging_and_no_utm");
    expect(untaggedAds.items).toEqual(["Generic (222)"]);
    expect(d.findings.find((f: { rule: string }) => f.rule === "campaign_untagged").items).toEqual(["Untagged (c3)"]);
    expect(d.findings.find((f: { rule: string }) => f.rule === "utm_source_case_variants").items[0]).toContain("facebook (40 sessions) / Facebook (10 sessions)");
    expect(d.findings[0].severity).toBe("high");
    expect(d.summary.high).toBeGreaterThanOrEqual(3);
  });

  it("analyze_paid_search_on_site: fixed groups and the (not set) share", async () => {
    h.ga4.report = ga4Answer({
      sessionGoogleAdsCampaignId: {
        rows: [
          { dims: ["111", "Brand", "shop shoes"], m: { sessions: 50, engagementRate: 0.8, keyEvents: 3 } },
          { dims: ["111", "Brand", "shoe sizes"], m: { sessions: 30, engagementRate: 0.6, keyEvents: 0 } },
          { dims: ["222", "Generic", "free shoes"], m: { sessions: 40, engagementRate: 0.1, keyEvents: 0 } },
          { dims: ["222", "Generic", "rare"], m: { sessions: 2, engagementRate: 0, keyEvents: 0 } },
          { dims: ["222", "Generic", "(not set)"], m: { sessions: 78, keyEvents: 1 } },
        ],
      },
    });
    const d = (await h.run("analyze_paid_search_on_site", { account_id: h.ids.prop })).data;
    expect(d.converting.items.map((r: { query: string }) => r.query)).toEqual(["shop shoes"]);
    expect(d.engaged_without_key_events.items.map((r: { query: string }) => r.query)).toEqual(["shoe sizes"]);
    expect(d.low_engagement.items.map((r: { query: string }) => r.query)).toEqual(["free shoes"]);
    expect(d.summary).toEqual({ queries: 4, sessions: 200, not_set_sessions: 78, not_set_share: 0.39 });
    expect(h.ga4.dataCalls("runReport")[0]!.body.dimensions.map((x: { name: string }) => x.name)).toContain("sessionGoogleAdsQuery");
  });
});
