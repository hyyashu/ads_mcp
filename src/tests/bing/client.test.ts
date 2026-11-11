import { describe, expect, it } from "vitest";
import { getPageStats, getQueryStats, getRankAndTrafficStats, sumByKey } from "../../platforms/bing/api/traffic";
import { BingClient, bingDate, bingDay, isBingSiteUrl, toBingDate } from "../../platforms/bing/client";
import { BingHttp, bingUrl, mapBingError } from "../../platforms/bing/http";
import { FakeBing, J, SITE, bingErr, guardProtocol, wcfDay } from "./fake-bing";

const fake = new FakeBing();
guardProtocol(fake);
const client = (o: { signal?: AbortSignal; site?: string } = {}) => {
  fake.reset();
  return new BingClient({ http: new BingHttp({ fetch: fake.fetch, sleep: async () => {}, random: () => 0 }), getAccessToken: async () => "tok", siteUrl: o.site ?? SITE, signal: o.signal });
};

describe("Bing transport", () => {
  it("builds only www.bing.com JSON method URLs and refuses odd method names", () => {
    expect(bingUrl("GetQueryStats", { siteUrl: "https://a.example/", x: undefined }).toString()).toBe("https://www.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=https%3A%2F%2Fa.example%2F");
    for (const bad of ["../GetQueryStats", "Get/Query", "", "Get?x=1"]) expect(() => bingUrl(bad)).toThrow(/malformed/);
  });

  it("maps every documented ApiErrorCode to a stable error", () => {
    const m = (code: number, mutation = false, status = 400) => mapBingError(status, { ErrorCode: code, Message: "m" }, mutation);
    expect(m(3).code).toBe("auth_expired");
    expect(m(4).code).toBe("quota_exceeded");
    expect(m(5).code).toBe("quota_exceeded");
    expect(m(6).code).toBe("platform_permission_denied");
    expect(m(7).code).toBe("invalid_argument");
    expect(m(8).code).toBe("invalid_argument");
    expect(m(9).code).toBe("invalid_argument");
    expect(m(10).code).toBe("not_found");
    expect(m(11).code).toBe("not_found");
    expect(m(12)).toMatchObject({ code: "conflict", opts: { details: { bing_error: "AlreadyExists" } } });
    expect(m(13).code).toBe("platform_permission_denied");
    expect(m(14).code).toBe("platform_permission_denied");
    expect(m(15).code).toBe("conflict");
    expect(m(16).code).toBe("unsupported");
    expect(m(1).code).toBe("transient");
    expect(m(1, true).code).toBe("unknown_outcome");
    expect(m(2, true).code).toBe("unknown_outcome");
    expect(mapBingError(500, {}, true).code).toBe("unknown_outcome");
    expect(mapBingError(401, {}, false).code).toBe("auth_expired");
    expect(mapBingError(400, {}, false).code).toBe("invalid_argument");
  });

  it("reads are GET with siteUrl and a bearer token, unwrap d, and are retried on transient failures", async () => {
    const c = client();
    let n = 0;
    fake.handlers.GetCrawlStats = () => [{ Date: wcfDay("2026-11-01") }];
    fake.fail = (call) => (call.method === "GetCrawlStats" && n++ === 0 ? bingErr(1, "InternalError", 500) : undefined);
    expect(await c.read("GetCrawlStats")).toEqual([{ Date: wcfDay("2026-11-01") }]);
    expect(fake.of("GetCrawlStats")).toHaveLength(2);
    expect(fake.calls[0]).toMatchObject({ http: "GET", token: "tok" });
    expect(fake.calls[0]!.params.get("siteUrl")).toBe(SITE);
  });

  it("changes are one POST with siteUrl in the JSON body, never retried; a server error is unknown_outcome", async () => {
    const c = client();
    fake.handlers.SubmitUrl = () => bingErr(1, "InternalError", 500);
    await expect(c.send("SubmitUrl", { url: `${SITE}a` })).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(fake.of("SubmitUrl")).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ http: "POST", body: { siteUrl: SITE, url: `${SITE}a` } });
    expect(c.mutationsSent).toBe(1);
    fake.handlers.SubmitUrl = () => undefined;
    await expect(c.send("SubmitUrl", { url: `${SITE}a` })).resolves.toBeUndefined(); // {"d": null}
  });

  it("a cancelled change is not sent", async () => {
    const ac = new AbortController();
    ac.abort();
    const c = client({ signal: ac.signal });
    await expect(c.send("SubmitUrl", { url: `${SITE}a` })).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(fake.calls).toHaveLength(0);
    expect(c.mutationsSent).toBe(0);
  });

  it("refuses a success body without d", async () => {
    const c = client();
    fake.handlers.GetFeeds = () => J({ notD: 1 });
    await expect(c.read("GetFeeds")).rejects.toMatchObject({ code: "internal" });
  });
});

describe("Bing values", () => {
  it("parses WCF dates as instants and as the calendar day in Bing's offset", () => {
    expect(bingDate("/Date(1316156400000-0700)/")).toBe("2011-09-16T07:00:00.000Z");
    expect(bingDay("/Date(1316156400000-0700)/")).toBe("2011-09-16");
    expect(bingDay(wcfDay("2026-03-01", "+0100"))).toBe("2026-03-01");
    expect(bingDay("/Date(1316156400000)/")).toBe("2011-09-16");
    expect(bingDate("/Date(-62135596800000)/")).toBeNull(); // DateTime.MinValue: never
    expect(bingDate("2011-09-16")).toBeNull();
    expect(toBingDate("2026-11-01")).toBe(`/Date(${Date.UTC(2026, 10, 1)})/`);
  });

  it("accepts Bing site URLs as GetUserSites returns them", () => {
    for (const ok of ["http://example.com", "https://www.example.com/", "https://example.com/shop/"]) expect(isBingSiteUrl(ok)).toBe(true);
    for (const bad of ["sc-domain:example.com", "ftp://x.example/", "https://example.com/?q=1", "example.com"]) expect(isBingSiteUrl(bad)).toBe(false);
  });

  it("lists sites and finds one by exact URL", async () => {
    const c = client();
    expect((await c.listSites()).map((s) => s.url)).toEqual([SITE, "https://shop.example.com/", "https://ro.example.com/"]);
    expect(await c.findSite(SITE)).toMatchObject({ isVerified: true, authenticationCode: "AUTHCODE1" });
    expect(await c.findSite("https://www.example.com")).toBeNull();
    expect(fake.calls.every((x) => !x.params.has("siteUrl"))).toBe(true);
  });
});

describe("traffic reads", () => {
  it("daily traffic is sorted by day; query and page stats keep each weekly bucket", async () => {
    const c = client();
    fake.handlers.GetRankAndTrafficStats = () => [
      { Date: wcfDay("2026-11-02"), Clicks: 3, Impressions: 30 },
      { Date: wcfDay("2026-11-01"), Clicks: 1, Impressions: 10 },
    ];
    fake.handlers.GetQueryStats = () => [
      { Query: "shoes", Date: wcfDay("2026-10-25"), Clicks: 2, Impressions: 40, AvgImpressionPosition: 3, AvgClickPosition: 2 },
      { Query: "shoes", Date: wcfDay("2026-11-01"), Clicks: 6, Impressions: 60, AvgImpressionPosition: 5, AvgClickPosition: 4 },
      { Query: "boots", Date: wcfDay("2026-11-01"), Clicks: 0, Impressions: 5, AvgImpressionPosition: -1, AvgClickPosition: -1 },
    ];
    fake.handlers.GetPageStats = () => [{ Query: `${SITE}shoes`, Date: wcfDay("2026-11-01"), Clicks: 1, Impressions: 2, AvgImpressionPosition: 1, AvgClickPosition: 1 }];
    expect(await getRankAndTrafficStats(c)).toEqual([
      { date: "2026-11-01", clicks: 1, impressions: 10 },
      { date: "2026-11-02", clicks: 3, impressions: 30 },
    ]);
    const q = await getQueryStats(c);
    expect(q[2]).toMatchObject({ key: "boots", avgImpressionPosition: null, avgClickPosition: null });
    expect((await getPageStats(c))[0]!.key).toBe(`${SITE}shoes`);

    const all = sumByKey(q);
    expect(all.totals.get("shoes")).toEqual({ key: "shoes", clicks: 8, impressions: 100, avgImpressionPosition: 4.2, avgClickPosition: 3.5 });
    expect(all.bucketDates).toEqual(["2026-10-25", "2026-11-01"]);
    const lastWeek = sumByKey(q, { start: "2026-10-30", end: "2026-11-05" });
    expect(lastWeek.totals.get("shoes")).toMatchObject({ clicks: 6, impressions: 60 });
    expect(lastWeek.bucketDates).toEqual(["2026-11-01"]);
  });
});
