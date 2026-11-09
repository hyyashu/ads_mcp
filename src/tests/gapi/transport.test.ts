import { describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { ToolError } from "../../mcp/errors";
import { Ga4Client } from "../../platforms/ga4/client";
import { GoogleApiClient, HARD_ROW_CAP } from "../../platforms/gapi/client";
import { GoogleApiHttp, mapGapiError } from "../../platforms/gapi/http";
import { GscClient } from "../../platforms/gsc/client";
import { GtmClient } from "../../platforms/gtm/client";

/** The shared Search Console / GA4 / Tag Manager transport and client base: error mapping, host allow-list, paging. */
const J = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers });

function recorder(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const seen: { url: URL; method: string; headers: Record<string, string>; body: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    seen.push({ url: u, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? "") });
    return respond(u, init ?? {});
  };
  return { seen, http: new GoogleApiHttp({ fetch, sleep: async () => {}, random: () => 0 }) };
}
const client = (http: GoogleApiHttp, signal?: AbortSignal) => new GoogleApiClient({ http, getAccessToken: async () => "ya29.test-token-value", signal });

describe("Google API error mapping", () => {
  const map = (status: number, error: Record<string, unknown>, mutation = false) => mapGapiError(status, { error } as never, mutation, "Google Analytics");

  it("maps statuses to stable codes", () => {
    expect(map(400, { status: "INVALID_ARGUMENT", message: "Field foo is not a valid dimension." })).toMatchObject({ code: "invalid_argument", message: "Field foo is not a valid dimension." });
    expect(map(401, { status: "UNAUTHENTICATED" }).code).toBe("auth_expired");
    expect(map(403, { status: "PERMISSION_DENIED", message: "User does not have sufficient permissions" }).code).toBe("platform_permission_denied");
    expect(map(404, { status: "NOT_FOUND", message: "missing" }).code).toBe("not_found");
    expect(map(409, { status: "ALREADY_EXISTS", message: "exists" }).code).toBe("conflict");
    expect(map(503, { status: "UNAVAILABLE" })).toMatchObject({ code: "transient", retryable: true });
    expect(map(418, {}).code).toBe("internal");
  });

  it("429 and quota reasons are quota_exceeded, with Google's retry delay when given", () => {
    // GA4 Data API token quota: 429 RESOURCE_EXHAUSTED
    expect(map(429, { status: "RESOURCE_EXHAUSTED", message: "Exhausted property tokens per day" })).toMatchObject({ code: "quota_exceeded", opts: { retryAfterSeconds: 60 } });
    expect(map(429, { status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12.5s" }] }).opts.retryAfterSeconds).toBe(13);
    // a 403 is a quota only when Google says so (legacy errors[] or ErrorInfo reason), otherwise a permission problem
    expect(map(403, { message: "Quota exceeded", errors: [{ reason: "quotaExceeded" }] }).code).toBe("quota_exceeded");
    expect(map(403, { errors: [{ reason: "dailyLimitExceeded" }] }).code).toBe("quota_exceeded");
    expect(map(403, { status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" }] }).code).toBe("quota_exceeded");
    expect(map(403, { errors: [{ reason: "forbidden" }] }).code).toBe("platform_permission_denied");
  });

  it("a server error after a mutation was sent is unknown_outcome, never a definite failure", () => {
    expect(map(500, { status: "INTERNAL" }, true).code).toBe("unknown_outcome");
    expect(map(500, { status: "INTERNAL" }, false).code).toBe("transient");
  });

  it("redacts tokens that appear in Google's message", () => {
    const e = map(400, { message: "bad header Bearer ya29.abcdefghijklmnopqrstuvwxyz" });
    expect(e.message).not.toContain("ya29.abcdefghijklmnop");
  });
});

describe("GoogleApiHttp", () => {
  it("only reaches the allowed Google API hosts over https", async () => {
    const { seen, http } = recorder(() => J({}));
    for (const url of [
      "http://www.googleapis.com/webmasters/v3/sites",
      "https://evil.example/webmasters/v3/sites",
      "https://www.googleapis.com.evil.example/x",
      "https://googleads.googleapis.com/v23/customers",
      "https://user:pw@tagmanager.googleapis.com/tagmanager/v2/accounts",
      "https://tagmanager.googleapis.com:8443/tagmanager/v2/accounts",
      "not a url",
    ]) {
      await expect(http.call({ accessToken: "t", url, idempotent: true }), url).rejects.toMatchObject({ code: "internal" });
    }
    expect(seen).toHaveLength(0); // nothing left the process, so no token was sent anywhere
    for (const host of ["www.googleapis.com", "searchconsole.googleapis.com", "analyticsdata.googleapis.com", "analyticsadmin.googleapis.com", "tagmanager.googleapis.com"]) {
      await http.call({ accessToken: "t", url: `https://${host}/x`, idempotent: true });
    }
    expect(seen.map((s) => s.url.hostname)).toHaveLength(5);
  });

  it("sends the token only in the Authorization header and encodes query parameters", async () => {
    const { seen, http } = recorder(() => J({ ok: true }));
    await http.call({ accessToken: "ya29.secret-token", url: "https://analyticsadmin.googleapis.com/v1beta/accountSummaries", params: { pageSize: 200, pageToken: "a b&c", skip: undefined, ids: ["1", "2"] }, idempotent: true });
    expect(seen[0]!.headers.authorization).toBe("Bearer ya29.secret-token");
    expect(seen[0]!.url.toString()).not.toContain("ya29");
    expect(seen[0]!.url.searchParams.get("pageToken")).toBe("a b&c");
    expect(seen[0]!.url.searchParams.has("skip")).toBe(false);
    expect(seen[0]!.url.searchParams.getAll("ids")).toEqual(["1", "2"]);
  });

  it("retries reads on transient errors but sends a mutation exactly once", async () => {
    let n = 0;
    const { seen, http } = recorder(() => (++n < 3 ? J({ error: { code: 503, status: "UNAVAILABLE" } }, 503) : J({ done: true })));
    expect(await http.call({ accessToken: "t", url: "https://www.googleapis.com/webmasters/v3/sites", idempotent: true })).toEqual({ done: true });
    expect(seen).toHaveLength(3);

    const once = recorder(() => J({ error: { code: 500, status: "INTERNAL" } }, 500));
    await expect(once.http.call({ accessToken: "t", method: "PUT", url: "https://www.googleapis.com/webmasters/v3/sites/x/sitemaps/y", idempotent: false })).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(once.seen).toHaveLength(1);
  });

  it("an empty success body (sitemaps.submit, sites.delete) is an empty object, not an error", async () => {
    const { http } = recorder(() => J(undefined, 200));
    expect(await http.call({ accessToken: "t", method: "DELETE", url: "https://www.googleapis.com/webmasters/v3/sites/x", idempotent: false })).toEqual({});
  });
});

describe("GoogleApiClient", () => {
  /** A list of `total` items served `size` per page with numeric page tokens. */
  const paged = (total: number, size: number) =>
    recorder((u) => {
      const off = Number(u.searchParams.get("pageToken") ?? 0);
      const items = Array.from({ length: Math.min(size, Math.max(0, total - off)) }, (_, i) => ({ id: off + i }));
      return J({ items, ...(off + size < total ? { nextPageToken: String(off + size) } : {}) });
    });

  it("pages() follows nextPageToken and returns everything when it fits", async () => {
    const { seen, http } = paged(25, 10);
    const r = await client(http).pages("https://tagmanager.googleapis.com/tagmanager/v2/accounts", { pageSize: 10 }, { itemsKey: "items", maxRows: 100 });
    expect(r.items.map((x) => (x as { id: number }).id)).toEqual([...Array(25).keys()]);
    expect(r.truncated).toBe(false);
    expect(seen.map((s) => s.url.searchParams.get("pageToken"))).toEqual([null, "10", "20"]);
    expect(seen.every((s) => s.url.searchParams.get("pageSize") === "10")).toBe(true);
  });

  it("pages() refuses past maxRows (row_cap) instead of returning a silently cut list", async () => {
    const { http } = paged(25, 10);
    const e = await client(http).pages("https://tagmanager.googleapis.com/tagmanager/v2/accounts", {}, { itemsKey: "items", maxRows: 20, what: "containers" }).catch((x) => x);
    expect(e).toBeInstanceOf(ToolError);
    expect(e).toMatchObject({ code: "unsupported", opts: { definite: true, details: { reason: "row_cap", cap: 20, resource: "containers" } } });
    // exactly maxRows rows is not a cut
    expect((await client(paged(20, 10).http).pages("https://tagmanager.googleapis.com/x", {}, { itemsKey: "items", maxRows: 20 })).truncated).toBe(false);
  });

  it("pages() with partial returns the first maxRows rows and says truncated", async () => {
    const r = await client(paged(25, 10).http).pages("https://tagmanager.googleapis.com/x", {}, { itemsKey: "items", maxRows: 15, partial: true });
    expect(r.items).toHaveLength(15);
    expect(r.truncated).toBe(true);
    // the hard cap holds whatever a caller asks for
    const big = await client(paged(HARD_ROW_CAP + 5, 5_000).http).pages("https://tagmanager.googleapis.com/x", {}, { itemsKey: "items", maxRows: 1_000_000, partial: true });
    expect(big.items).toHaveLength(HARD_ROW_CAP);
    expect(big.truncated).toBe(true);
  });

  it("read and query are retried reads; send counts mutations, never retries, and stops before sending when aborted", async () => {
    const { seen, http } = recorder((u) => (u.pathname.endsWith("fail") ? J({ error: { code: 500, status: "INTERNAL" } }, 500) : J({ ok: 1 })));
    const c = client(http);
    await c.read("https://www.googleapis.com/webmasters/v3/sites");
    await c.query("https://analyticsdata.googleapis.com/v1beta/properties/1:runReport", { limit: 1 });
    expect(seen[1]).toMatchObject({ method: "POST", body: '{"limit":1}' });
    expect(c.mutationsSent).toBe(0);
    await expect(c.send("PUT", "https://www.googleapis.com/webmasters/v3/fail")).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(c.mutationsSent).toBe(1);
    expect(seen.filter((s) => s.url.pathname.endsWith("fail"))).toHaveLength(1);

    const ac = new AbortController();
    ac.abort();
    const stopped = client(http, ac.signal);
    const before = seen.length;
    await expect(stopped.send("DELETE", "https://www.googleapis.com/webmasters/v3/sites/x")).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(stopped.mutationsSent).toBe(0);
    expect(seen.length).toBe(before);
  });
});

describe("product clients", () => {
  const http = new GoogleApiHttp({ fetch: async () => J({}) });
  const base = { http, getAccessToken: async () => "t" };
  it("know their account and refuse ids that are not theirs to build URLs from", () => {
    expect(new GscClient({ ...base, siteUrl: "sc-domain:shop.example" }).siteBase).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Ashop.example");
    expect(new GscClient({ ...base, siteUrl: "https://shop.example/" }).siteBase).toBe("https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fshop.example%2F");
    const ga4 = new Ga4Client({ ...base, property: "properties/42", currencyCode: "EUR", timeZone: "Europe/Berlin" });
    expect([ga4.property, ga4.currencyCode, ga4.timeZone]).toEqual(["properties/42", "EUR", "Europe/Berlin"]);
    expect(new GtmClient({ ...base, containerPath: "accounts/1/containers/2" }).containerBase).toBe("https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2");
    expect(() => new GscClient({ ...base, siteUrl: "example.com" })).toThrow();
    expect(() => new Ga4Client({ ...base, property: "properties/1/../../x", currencyCode: null, timeZone: null })).toThrow();
    expect(() => new GtmClient({ ...base, containerPath: "accounts/1/containers/2/workspaces/3" })).toThrow();
  });
});

describe("shared fixes before the channel builds (2026-11-10)", () => {
  it("412 (Tag Manager fingerprint mismatch) is a definite conflict, even for a change", () => {
    const e = mapGapiError(412, { error: { code: 412, message: "Fingerprint mismatch" } }, true, "Tag Manager");
    expect(e.code).toBe("conflict");
    expect(e.opts.definite).toBe(true);
  });

  it("every quota reason Search Console documents is a quota error, not a permission error", () => {
    for (const reason of ["quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "limitExceeded", "concurrentLimitExceeded", "servingLimitExceeded"]) {
      expect(mapGapiError(403, { error: { code: 403, message: "x", errors: [{ reason }] } }, false).code).toBe("quota_exceeded");
    }
    expect(mapGapiError(403, { error: { code: 403, message: "x", errors: [{ reason: "forbidden" }] } }, false).code).toBe("platform_permission_denied");
  });

  it("the Tag Manager project limit stops a request before it is sent", async () => {
    const { createServicesFactory } = await import("../../platforms/services");
    const { GoogleApiHttp } = await import("../../platforms/gapi/http");
    let calls = 0;
    const http = new GoogleApiHttp({ fetch: async () => { calls++; return new Response(JSON.stringify({ account: [] })); } } as never);
    const make = createServicesFactory({ db: undefined as never, gapi: { tokens: { getAccessToken: async () => "t" }, http, gtmLimiter: { take: () => ({ ok: false, retryAfterSeconds: 7 }) } } });
    const s = (await make({ tenantId: "t", account: { platform: "google_tag_manager", externalId: "accounts/1/containers/2", loginCustomerId: null, connectionId: "c" } })) as { gtm: { read(u: string): Promise<unknown> } };
    await expect(s.gtm.read("https://tagmanager.googleapis.com/tagmanager/v2/accounts")).rejects.toMatchObject({ code: "quota_exceeded", opts: { retryAfterSeconds: 7 } });
    expect(calls).toBe(0);
  });
});
