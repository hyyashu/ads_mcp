import { describe, expect, it } from "vitest";
import { ToolError } from "../../mcp/errors";
import { GoogleApiHttp, mapGapiError } from "../../platforms/gapi/http";
import { GscClient } from "../../platforms/gsc/client";
import { FakeGsc, gErr, J } from "./fake-gsc";

const make = (fake: FakeGsc, siteUrl = "sc-domain:example.com") => {
  const http = new GoogleApiHttp({ fetch: fake.fetch, sleep: async () => {}, random: () => 0 });
  return new GscClient({ http, getAccessToken: async () => "tok", siteUrl });
};
const fresh = () => {
  const f = new FakeGsc();
  f.reset();
  return f;
};
const row = (i: number) => ({ keys: [`q${i}`], clicks: 1, impressions: 2, ctr: 0.5, position: 3 });

describe("GscClient.searchAnalytics", () => {
  it("pages with startRow, asking for one row past the cap, and stops at the cap", async () => {
    const f = fresh();
    f.sa = (_s, b) => ({ rows: Array.from({ length: Math.min(b.rowLimit, 100_000 - b.startRow) }, (_, i) => row(b.startRow + i)), responseAggregationType: "byProperty" });
    const r = await make(f).searchAnalytics({ startDate: "2026-10-01", endDate: "2026-10-28" }, { maxRows: 50_000, partial: true });
    const bodies = f.calls.map((c) => c.body);
    expect(bodies.map((b) => [b.rowLimit, b.startRow])).toEqual([[25_000, 0], [25_000, 25_000], [1, 50_000]]);
    expect(r.rows).toHaveLength(50_000);
    expect(r.truncated).toBe(true);
    expect(r.responseAggregationType).toBe("byProperty");
  });

  it("stops on an empty page and reports not truncated", async () => {
    const f = fresh();
    f.sa = (_s, b) => ({ rows: b.startRow === 0 ? [row(0), row(1)] : [] });
    const r = await make(f).searchAnalytics({ startDate: "2026-10-01", endDate: "2026-10-28", dimensions: ["query"] }, { maxRows: 10 });
    expect(r).toMatchObject({ truncated: false });
    expect(r.rows.map((x) => x.keys[0])).toEqual(["q0", "q1"]);
    expect(f.calls.map((c) => c.body.startRow)).toEqual([0, 2]);
    expect(f.calls[0]!.url.pathname).toBe("/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
  });

  it("refuses with row_cap past the cap unless partial, and honours a start offset", async () => {
    const f = fresh();
    f.sa = (_s, b) => ({ rows: Array.from({ length: b.rowLimit }, (_, i) => row(b.startRow + i)) });
    await expect(make(f).searchAnalytics({ startDate: "2026-10-01", endDate: "2026-10-02" }, { maxRows: 5 })).rejects.toMatchObject({ code: "unsupported", opts: { details: { reason: "row_cap" } } });
    f.calls = [];
    const r = await make(f).searchAnalytics({ startDate: "2026-10-01", endDate: "2026-10-02" }, { maxRows: 5, startRow: 40, partial: true });
    expect(r.rows[0]!.keys).toEqual(["q40"]);
    expect(f.calls[0]!.body).toMatchObject({ rowLimit: 6, startRow: 40 });
  });

  it("takes metadata from the first page and accepts numeric strings", async () => {
    const f = fresh();
    f.sa = (_s, b) => (b.startRow === 0 ? { rows: [{ keys: ["2026-11-01"], clicks: "4", impressions: "10", ctr: 0.4 }], metadata: { first_incomplete_date: "2026-11-01" } } : {});
    const r = await make(f).searchAnalytics({ startDate: "2026-10-01", endDate: "2026-11-02", dimensions: ["date"], dataState: "all" }, { maxRows: 10 });
    expect(r.firstIncompleteDate).toBe("2026-11-01");
    expect(r.rows[0]).toEqual({ keys: ["2026-11-01"], clicks: 4, impressions: 10, ctr: 0.4, position: null });
  });

  it("never asks for more than Google can hold", async () => {
    await expect(make(fresh()).searchAnalytics({ startDate: "2026-10-01", endDate: "2026-10-02" }, { maxRows: 50_001 })).rejects.toMatchObject({ code: "internal" });
  });
});

describe("GscClient sites and sitemaps", () => {
  it("lists sites, treats a missing siteEntry as none, and finds by exact URL", async () => {
    const f = fresh();
    expect((await make(f).listSites()).map((s) => s.siteUrl)).toContain("https://shop.example.com/");
    expect(await make(f).findSite("https://shop.example.com")).toBeNull(); // no trailing slash: a different property
    f.sites = [];
    f.fail = () => J({});
    expect(await make(f).listSites()).toEqual([]);
  });

  it("encodes the site and sitemap URLs as single path segments and sends writes without a body", async () => {
    const f = fresh();
    const c = make(f, "https://shop.example.com/");
    await c.submitSitemap("https://shop.example.com/sitemap.xml?x=1");
    await c.deleteSitemap("https://shop.example.com/sitemap.xml?x=1");
    expect(f.calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      "PUT /webmasters/v3/sites/https%3A%2F%2Fshop.example.com%2F/sitemaps/https%3A%2F%2Fshop.example.com%2Fsitemap.xml%3Fx%3D1",
      "DELETE /webmasters/v3/sites/https%3A%2F%2Fshop.example.com%2F/sitemaps/https%3A%2F%2Fshop.example.com%2Fsitemap.xml%3Fx%3D1",
    ]);
    expect(f.bodyProblems).toEqual([]);
    expect(c.mutationsSent).toBe(2);
  });

  it("getSitemap is null on 404, passes other errors on", async () => {
    const f = fresh();
    expect(await make(f).getSitemap("https://example.com/none.xml")).toBeNull();
    f.fail = () => gErr(403, "denied", "forbidden");
    await expect(make(f).getSitemap("https://example.com/none.xml")).rejects.toMatchObject({ code: "platform_permission_denied" });
  });

  it("passes sitemapIndex as a query parameter", async () => {
    const f = fresh();
    await make(f).listSitemaps("https://example.com/index.xml");
    expect(f.calls[0]!.url.searchParams.get("sitemapIndex")).toBe("https://example.com/index.xml");
  });

  it("a mutation that fails with a server error is sent once and is unknown_outcome", async () => {
    const f = fresh();
    f.fail = (c) => (c.method === "PUT" ? gErr(503, "backend", "backendError") : undefined);
    await expect(make(f).addSite("sc-domain:new.example")).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(f.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });
});

describe("Search Console error bodies", () => {
  const m = (status: number, reason: string) => mapGapiError(status, { error: { code: status, message: "x", errors: [{ reason }] } }, false, "Search Console");
  it("maps the documented reasons", () => {
    for (const r of ["quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "limitExceeded", "concurrentLimitExceeded", "servingLimitExceeded"]) expect(m(403, r).code, r).toBe("quota_exceeded");
    for (const r of ["forbidden", "insufficientPermissions"]) expect(m(403, r).code, r).toBe("platform_permission_denied");
    expect(m(401, "authError").code).toBe("auth_expired");
    expect(m(404, "notFound").code).toBe("not_found");
    expect(m(429, "rateLimitExceeded").code).toBe("quota_exceeded");
    expect(m(400, "invalidParameter").code).toBe("invalid_argument");
    expect(m(500, "internalError")).toBeInstanceOf(ToolError);
    expect(m(503, "backendError").code).toBe("transient");
  });
});
