import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gaPath, landing, utmOf } from "../../platforms/cross/common";
import { gErr } from "../gsc/fake-gsc";
import { ga4Answer } from "./ga4-fixture";
import { type CrossHarness, crossHarness } from "./harness";

const ad = (id: string, url: string, clicks: number, cost = 1) => ({ adGroupAd: { ad: { id, finalUrls: [url] } }, metrics: { impressions: String(clicks * 10), clicks: String(clicks), costMicros: String(cost * 1e6) } });

describe("normalisation helpers", () => {
  it("landing URLs drop query, fragment and trailing slash; host is lower-cased; path keeps its case", () => {
    expect(landing("HTTPS://Shop.Example.com/Shoes/?utm_source=x&gclid=1#top")).toEqual({ host: "shop.example.com", path: "/Shoes", clean_url: "https://shop.example.com/Shoes/" });
    expect(landing("https://example.com/")!.path).toBe("/");
    expect(landing("https://example.com/caf%C3%A9")!.path).toBe("/café");
    expect(landing("ftp://example.com/x")).toBeNull();
    expect(landing("not a url")).toBeNull();
    expect(gaPath("/shoes/")).toBe("/shoes");
    expect(gaPath("(not set)")).toBeNull();
  });
  it("UTM values come from the link, and url_tags win", () => {
    expect(utmOf("https://x.example/?utm_source=fb&utm_campaign=a", "utm_campaign=b&utm_medium=paid")).toEqual({ utm_source: "fb", utm_medium: "paid", utm_campaign: "b" });
    expect(utmOf(null, null)).toEqual({ utm_source: null, utm_medium: null, utm_campaign: null });
  });
});

describe("audit_ad_landing_pages", () => {
  let h: CrossHarness;
  beforeAll(async () => {
    h = await crossHarness("XL");
  });
  beforeEach(() => {
    h.google.reset();
    h.gsc.reset();
    h.ga4.reset();
    h.google.search.ad_group_ad = [ad("1", "https://shop.example.com/shoes/?utm_source=x", 50, 20), ad("2", "https://shop.example.com/shoes", 10, 5), ad("3", "https://other.net/shoes", 5), ad("4", "https://example.com/boots", 3), { adGroupAd: { ad: { id: "5", finalUrls: ["not a url"] } }, metrics: { clicks: "1" } }];
    h.ga4.report = ga4Answer({
      landingPage: {
        rows: [
          { dims: ["/shoes"], m: { sessions: 100, engagedSessions: 50, engagementRate: 0.5, keyEvents: 5, sessionKeyEventRate: 0.04, totalRevenue: 10 } },
          { dims: ["/shoes/"], m: { sessions: 20, engagedSessions: 14, engagementRate: 0.7, keyEvents: 1, sessionKeyEventRate: 0.05, totalRevenue: 0 } },
          { dims: ["(not set)"], m: { sessions: 3 } },
        ],
      },
    });
    h.gsc.inspect = (body) => ({ inspectionResult: { indexStatusResult: { verdict: body.inspectionUrl.includes("boots") ? "NEUTRAL" : "PASS", coverageState: "Submitted and indexed", indexingState: "INDEXING_ALLOWED", pageFetchState: "SUCCESSFUL" } } });
  });

  it("joins ad URLs to GA4 on the path, samples inspections within the site, and reports what it could not match", async () => {
    const env = await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, inspect_max: 1 });
    expect(env.error).toBeUndefined();
    const d = env.data;
    const [shoes, other, boots] = d.pages.items;
    expect(shoes).toMatchObject({ url: "https://shop.example.com/shoes/", path: "/shoes", google_ads: { ads: 2, clicks: 60, cost: 25 }, path_shared_with_other_hosts: true });
    // two GA4 rows fold into one page: counts add, the rate is recomputed, GA4's per-row key-event rate cannot be added
    expect(shoes.ga4).toEqual({ sessions: 120, engaged_sessions: 64, engagement_rate: 0.5333, key_events: 6, session_key_event_rate: null, total_revenue: 10, ga4_rows: 2 });
    expect(shoes.index).toMatchObject({ status: "inspected", verdict: "PASS" });
    expect(other.index.status).toBe("outside_site");
    expect(other.ga4.sessions).toBe(120); // same path on another host: same GA4 figures, flagged
    expect(boots).toMatchObject({ ga4: null, index: { status: "not_sampled" } });
    expect(boots.ga4_unmatched_reason).toContain("no session");
    expect(d.unmatched.urls_not_parsed).toEqual(["not a url"]);
    expect(d.summary).toMatchObject({ pages: 3, with_ga4_data: 2, without_ga4_data: 1, inspected: 1, not_indexed: 0 });
    expect(h.gsc.calls.filter((c) => c.url.hostname === "searchconsole.googleapis.com")).toHaveLength(1);
    expect(d.coverage.sources.find((s: { source: string }) => s.source.includes("inspection")).note).toContain("Sampled");
    expect(d.coverage.not_checked.map((x: { source: string }) => x.source)).toEqual(["meta_ads"]);
    expect(d.coverage.notes.join(" ")).toContain("more than one host");
    expect(d.period.time_zones.map((z: { time_zone: string }) => z.time_zone)).toEqual(["America/New_York", "Europe/Berlin"]);
  });

  it("stops inspecting when the daily quota is hit and marks the rest", async () => {
    h.gsc.inspect = () => gErr(429, "Quota exceeded", "rateLimitExceeded");
    const d = (await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, inspect_max: 5 })).data;
    expect(d.pages.items.filter((p: { index: { status: string } }) => p.index.status === "quota_reached").length).toBe(2);
    expect(d.summary.inspected).toBe(0);
    expect(h.gsc.calls.filter((c) => c.url.hostname === "searchconsole.googleapis.com")).toHaveLength(1); // nothing more was sent
  });

  it("adds a named Meta account's active ads; a Meta id of another platform is not_found; GA4 truncation is stated", async () => {
    h.meta.ads = [
      { id: "m1", campaign_id: "c1", effective_status: "ACTIVE", creative: { object_story_spec: { link_data: { link: "https://example.com/boots?fbclid=1" } } } },
      { id: "m2", campaign_id: "c1", effective_status: "PAUSED", creative: { object_story_spec: { link_data: { link: "https://example.com/paused" } } } },
      { id: "m3", campaign_id: "c2", effective_status: "ACTIVE", creative: { asset_feed_spec: { link_urls: [{ website_url: "https://example.com/feed" }] } } },
    ];
    h.ga4.report = ga4Answer({ landingPage: { rows: [{ dims: ["/shoes"], m: { sessions: 1 } }], rowCount: 50_000 } });
    const d = (await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, meta_account_id: "act_987", inspect_max: 0 })).data;
    const boots = d.pages.items.find((p: { path: string }) => p.path === "/boots");
    expect(boots.meta_ads).toEqual({ active_ads: 1 });
    expect(d.pages.items.find((p: { path: string }) => p.path === "/feed").meta_ads).toEqual({ active_ads: 1 });
    expect(d.pages.items.some((p: { path: string }) => p.path === "/paused")).toBe(false);
    expect(boots.ga4_unmatched_reason).toContain("more landing pages than were read");
    expect(d.coverage.sources.find((s: { source: string }) => s.source.includes("landing")).complete).toBe(false);
    expect((await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, meta_account_id: h.ids.prop })).error).toMatchObject({ code: "not_found" });
  });

  it("says when the Meta account has more ads than are read (Meta's client stops at 5,000)", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, campaign_id: "c1", effective_status: "ACTIVE", creative: { object_story_spec: { link_data: { link: "https://example.com/boots" } } } }));
    h.meta.ads = many(6_000);
    const src = (d: { coverage: { sources: { source: string; complete: boolean; rows_read: number; note: string | null }[] } }) => d.coverage.sources.find((s) => s.source.startsWith("meta_ads"))!;
    const d = (await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, meta_account_id: "act_987", inspect_max: 0 })).data;
    expect(src(d)).toMatchObject({ rows_read: 4_999, complete: false });
    expect(src(d).note).toContain("only the first 4,999 were read");
    h.meta.ads = many(4_999);
    expect(src((await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, meta_account_id: "act_987", inspect_max: 0 })).data)).toMatchObject({ rows_read: 4_999, complete: true });
  });

  it("needs a GA4 property: without a link it says what to link", async () => {
    const env = await h.run("audit_ad_landing_pages", { account_id: h.ids.gadsUnlinked });
    expect(env.error).toMatchObject({ code: "invalid_argument" });
    expect(env.error!.message).toContain("No GA4 property is linked to this Google Ads account");
    expect((await h.run("audit_ad_landing_pages", { account_id: h.ids.gads, property_account_id: h.ids.foreignProp })).error).toMatchObject({ code: "not_found" });
  });
});
