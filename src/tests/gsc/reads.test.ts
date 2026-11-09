import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGsc, gErr, guardBodies, gscHarness, J, type GscHarness } from "./fake-gsc";

const fake = new FakeGsc();
guardBodies(fake);
let kit: GscHarness;
beforeAll(async () => {
  fake.reset();
  kit = await gscHarness("GSCR", fake);
});
beforeEach(() => fake.reset());

describe("list_gsc_sites", () => {
  it("lists the user's properties with permission, verification and which one is this account", async () => {
    fake.sites.push({ siteUrl: "https://new.example.com/", permissionLevel: "siteUnverifiedUser" });
    const r = await kit.run("list_gsc_sites");
    expect(r.ok).toBe(true);
    const sites = (r.data as any).sites;
    expect(sites.map((s: any) => s.site_url)).toEqual(["https://new.example.com/", "https://ro.example.com/", "https://shop.example.com/", "sc-domain:example.com"]);
    expect(sites[0]).toMatchObject({ property_type: "url_prefix", verified: false, is_this_account: false });
    expect(sites[3]).toMatchObject({ property_type: "domain", permission_level: "siteOwner", permission: "owner", verified: true, is_this_account: true });
    expect(r.data).toMatchObject({ returned: 4, total: 4, truncated: false });
    expect(fake.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /webmasters/v3/sites"]);
  });

  it("reports truncation past the limit and handles an empty list", async () => {
    let r = await kit.run("list_gsc_sites", { limit: 2 });
    expect(r.data).toMatchObject({ returned: 2, total: 3, truncated: true });
    fake.fail = () => J({});
    r = await kit.run("list_gsc_sites");
    expect(r.data).toMatchObject({ sites: [], returned: 0, truncated: false });
  });

  it("a rejected token is auth_expired", async () => {
    fake.fail = () => gErr(401, "Invalid Credentials", "authError");
    const r = await kit.run("list_gsc_sites");
    expect(r.error).toMatchObject({ code: "auth_expired" });
    expect(r.error!.message).toContain("Reconnect Search Console");
  });

  it("names the account by its site URL too", async () => {
    const r = await kit.run("list_gsc_sites", { account_id: "https://shop.example.com/" });
    expect((r.data as any).sites.find((s: any) => s.is_this_account).site_url).toBe("https://shop.example.com/");
  });
});

describe("list_sitemaps", () => {
  it("maps fields, accepts long values as strings or numbers, and never returns the deprecated indexed count", async () => {
    fake.sitemaps["sc-domain:example.com"] = [
      { path: "https://example.com/z.xml", type: "sitemap", isPending: false, isSitemapsIndex: false, lastSubmitted: "2026-11-01T00:00:00Z", lastDownloaded: "2026-11-02T00:00:00Z", errors: "2", warnings: 5, contents: [{ type: "web", submitted: "120", indexed: "100" }, { type: "image", submitted: 30 }] },
      { path: "https://example.com/a.xml" },
    ];
    const r = await kit.run("list_sitemaps");
    const d = r.data as any;
    expect(d.sitemaps.map((s: any) => s.path)).toEqual(["https://example.com/a.xml", "https://example.com/z.xml"]);
    expect(d.sitemaps[0]).toEqual({ path: "https://example.com/a.xml", type: null, is_index: null, is_pending: null, last_submitted: null, last_downloaded: null, errors: null, warnings: null, contents: [] });
    expect(d.sitemaps[1]).toMatchObject({ errors: 2, warnings: 5, contents: [{ type: "web", submitted: 120 }, { type: "image", submitted: 30 }] });
    expect(JSON.stringify(d)).not.toContain("indexed\":");
    expect(fake.calls[0]!.url.pathname).toBe("/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps");
  });

  it("lists inside a sitemap index, truncates past the limit, and an empty list is []", async () => {
    let r = await kit.run("list_sitemaps", { sitemap_index: "https://example.com/index.xml" });
    expect(r.data).toMatchObject({ sitemap_index: "https://example.com/index.xml", sitemaps: [], returned: 0 });
    expect(fake.calls[0]!.url.searchParams.get("sitemapIndex")).toBe("https://example.com/index.xml");
    fake.sitemaps["sc-domain:example.com"] = [{ path: "https://example.com/1.xml" }, { path: "https://example.com/2.xml" }];
    r = await kit.run("list_sitemaps", { limit: 1 });
    expect(r.data).toMatchObject({ returned: 1, total: 2, truncated: true });
  });
});

describe("inspect_url", () => {
  const full = {
    inspectionResult: {
      inspectionResultLink: "https://search.google.com/search-console/inspect?resource_id=x",
      indexStatusResult: {
        sitemap: ["https://example.com/sitemap.xml"],
        referringUrls: Array.from({ length: 25 }, (_, i) => `https://example.com/r${i}`),
        verdict: "PASS",
        coverageState: "Submitted and indexed",
        robotsTxtState: "ALLOWED",
        indexingState: "INDEXING_ALLOWED",
        lastCrawlTime: "2026-11-01T10:00:00Z",
        pageFetchState: "SUCCESSFUL",
        googleCanonical: "https://example.com/p",
        userCanonical: "https://example.com/p",
        crawledAs: "MOBILE",
      },
      mobileUsabilityResult: { verdict: "PASS", issues: [] },
      richResultsResult: { verdict: "PASS", detectedItems: [{ richResultType: "Product snippets", items: [{ name: "Shoe", issues: [{ issueMessage: "Missing field \"brand\"", severity: "WARNING" }] }] }] },
    },
  };

  it("sends only the documented body and maps a full result", async () => {
    fake.inspect = () => full;
    const r = await kit.run("inspect_url", { url: "https://www.example.com/p", language_code: "de-DE" });
    expect(r.ok).toBe(true);
    expect(fake.calls[0]!.url.toString()).toBe("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");
    expect(fake.calls[0]!.body).toEqual({ inspectionUrl: "https://www.example.com/p", siteUrl: "sc-domain:example.com", languageCode: "de-DE" });
    const d = r.data as any;
    expect(d).toMatchObject({ verdict: "PASS", coverage_state: "Submitted and indexed", canonical_mismatch: false, crawled_as: "MOBILE", amp: null, sitemaps: ["https://example.com/sitemap.xml"], referring_urls_truncated: true });
    expect(d.referring_urls).toHaveLength(20);
    expect(d.rich_results).toEqual({ verdict: "PASS", items: [{ type: "Product snippets", name: "Shoe", issues: [{ message: "Missing field \"brand\"", severity: "WARNING" }] }], truncated: false });
    expect(d.explanation[0]).toContain("indexed");
    expect(JSON.stringify(d)).not.toContain("mobile");
  });

  it("omits languageCode when not given and explains exclusions, noindex and canonical mismatch", async () => {
    fake.inspect = () => ({ inspectionResult: { indexStatusResult: { verdict: "NEUTRAL", coverageState: "Excluded by 'noindex' tag", indexingState: "BLOCKED_BY_META_TAG", pageFetchState: "SOFT_404", robotsTxtState: "SOMETHING_NEW", googleCanonical: "https://example.com/a", userCanonical: "https://example.com/b" } } });
    const r = await kit.run("inspect_url", { url: "https://example.com/b" });
    expect(fake.calls[0]!.body).toEqual({ inspectionUrl: "https://example.com/b", siteUrl: "sc-domain:example.com" });
    const d = r.data as any;
    expect(d.canonical_mismatch).toBe(true);
    expect(d.rich_results).toBeNull();
    const text = d.explanation.join(" ");
    expect(text).toContain("Excluded from the index");
    expect(text).toContain("noindex meta tag");
    expect(text).toContain("soft 404");
    expect(text).toContain("SOMETHING_NEW, which this server does not recognise");
    expect(text).toContain("instead of the declared");
    expect(text).toContain("no crawl");
  });

  it("refuses a URL outside the property without spending quota", async () => {
    const r = await kit.run("inspect_url", { url: "https://other.test/p" });
    expect(r.error).toMatchObject({ code: "invalid_argument" });
    expect(fake.calls).toHaveLength(0);
    const p = await kit.run("inspect_url", { account_id: kit.shopId, url: "https://example.com/p" });
    expect(p.error).toMatchObject({ code: "invalid_argument" });
    expect(fake.calls).toHaveLength(0);
  });

  it("explains the inspection quota and permission errors", async () => {
    fake.inspect = () => J({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }, 429);
    let r = await kit.run("inspect_url", { url: "https://example.com/p" });
    expect(r.error).toMatchObject({ code: "quota_exceeded", retryable: true });
    expect(r.error!.message).toContain("2,000 URL inspections");
    fake.inspect = () => J({ error: { code: 403, status: "PERMISSION_DENIED", message: "You do not own this site" } }, 403);
    r = await kit.run("inspect_url", { url: "https://example.com/p" });
    expect(r.error).toMatchObject({ code: "platform_permission_denied" });
    expect(r.error!.message).toContain("no access to sc-domain:example.com");
  });

  it("parses AMP results", async () => {
    fake.inspect = () => ({ inspectionResult: { indexStatusResult: { verdict: "PASS" }, ampResult: { ampUrl: "https://example.com/p.amp", verdict: "FAIL", indexingState: "BLOCKED_DUE_TO_NOINDEX", issues: [{ issueMessage: "bad", severity: "ERROR" }] } } });
    const d = (await kit.run("inspect_url", { url: "https://example.com/p" })).data as any;
    expect(d.amp).toMatchObject({ amp_url: "https://example.com/p.amp", verdict: "FAIL", indexing_state: "BLOCKED_DUE_TO_NOINDEX", issues: [{ message: "bad", severity: "ERROR" }] });
    expect(d.explanation.join(" ")).toContain("blocked by noindex");
  });
});
