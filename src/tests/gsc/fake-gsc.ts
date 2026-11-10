import { afterEach, expect } from "vitest";
import type { FetchLike, GoogleTokenProvider } from "../../auth/token-providers";
import { type Db, schema } from "../../db";
import { loadInventory } from "../../inventory";
import { createExecutor, runTool, type PipelineDeps } from "../../mcp/pipeline";
import { ToolRegistry } from "../../mcp/registry";
import { GoogleApiHttp } from "../../platforms/gapi/http";
import { gscTools } from "../../platforms/gsc";
import { createServicesFactory } from "../../platforms/services";
import { ApprovalService } from "../../security/approvals";
import { RateLimiter } from "../../security/rate-limit";
import { addUser, seedAccount, seedTenant, testDb } from "../support/helpers";

/**
 * A stateful stand-in for the Search Console API (www.googleapis.com/webmasters/v3 and searchconsole.googleapis.com/v1):
 * sites and sitemaps live in memory and change on PUT/DELETE; search analytics and URL inspection answer from callbacks.
 * Every request is recorded. GET, PUT and DELETE must carry no body (Google: "do not supply a request body").
 */
export interface Call {
  method: string;
  url: URL;
  /** Decoded path parts after webmasters/v3, e.g. ["sites", "sc-domain:example.com", "sitemaps", "https://example.com/s.xml"]. */
  parts: string[];
  body: any;
}
export interface FakeSitemap {
  path: string;
  lastSubmitted?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  lastDownloaded?: string;
  warnings?: string | number;
  errors?: string | number;
  contents?: { type?: string; submitted?: string | number; indexed?: string }[];
}
export const J = (body: unknown, status = 200) => new Response(body === undefined ? "" : JSON.stringify(body), { status });
export const gErr = (status: number, message: string, reason?: string, extra: Record<string, unknown> = {}) => J({ error: { code: status, message, ...(reason ? { errors: [{ reason, message }] } : {}), ...extra } }, status);

export class FakeGsc {
  sites: { siteUrl: string; permissionLevel: string }[] = [];
  sitemaps: Record<string, FakeSitemap[]> = {};
  calls: Call[] = [];
  /** searchAnalytics.query: return the response body (or a Response for errors). Default: no rows. */
  sa: (site: string, body: any) => unknown = () => ({});
  /** urlInspection.index.inspect. */
  inspect: (body: any) => unknown = () => ({ inspectionResult: {} });
  /** Return a Response to fail a request before the fake handles it. */
  fail: (c: Call) => Response | undefined = () => undefined;
  /** Accept writes without changing state (to test read-back failures). */
  ignoreWrites = false;
  clock = "2026-11-10T08:00:00Z";
  bodyProblems: string[] = [];

  reset() {
    this.sites = [
      { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
      { siteUrl: "https://shop.example.com/", permissionLevel: "siteFullUser" },
      { siteUrl: "https://ro.example.com/", permissionLevel: "siteRestrictedUser" },
    ];
    this.sitemaps = {};
    this.calls = [];
    this.sa = () => ({});
    this.inspect = () => ({ inspectionResult: {} });
    this.fail = () => undefined;
    this.ignoreWrites = false;
  }

  get mutations() {
    return this.calls.filter((c) => c.method !== "GET" && !(c.method === "POST"));
  }

  fetch: FetchLike = async (raw, init) => {
    const url = new URL(raw);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined || init?.body === null ? undefined : JSON.parse(String(init.body));
    if (method !== "POST" && init?.body !== undefined) this.bodyProblems.push(`${method} ${url.pathname} carried a body`);
    let parts: string[] = [];
    if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/webmasters/v3/")) parts = url.pathname.slice("/webmasters/v3/".length).split("/").map(decodeURIComponent);
    else if (url.hostname === "searchconsole.googleapis.com") parts = [url.pathname];
    const c: Call = { method, url, parts, body };
    this.calls.push(c);
    const failed = this.fail(c);
    if (failed) return failed;

    if (url.hostname === "searchconsole.googleapis.com" && url.pathname === "/v1/urlInspection/index:inspect" && method === "POST") {
      const r = this.inspect(body);
      return r instanceof Response ? r : J(r);
    }
    const [root, site, sub, item] = parts;
    if (root !== "sites") return gErr(404, "Not found");
    if (site === undefined) return method === "GET" ? J({ siteEntry: this.sites }) : gErr(405, "no");
    const entry = this.sites.find((s) => s.siteUrl === site);
    if (sub === undefined) {
      if (method === "GET") return entry ? J(entry) : gErr(403, `User does not have sufficient permission for site '${site}'.`, "forbidden");
      if (method === "PUT") {
        if (!this.ignoreWrites && !entry) this.sites.push({ siteUrl: site, permissionLevel: "siteUnverifiedUser" });
        return J(undefined);
      }
      if (method === "DELETE") {
        if (!entry) return gErr(404, "Not found");
        if (!this.ignoreWrites) this.sites = this.sites.filter((s) => s !== entry);
        return J(undefined);
      }
    }
    if (!entry) return gErr(403, `User does not have sufficient permission for site '${site}'.`, "forbidden");
    if (sub === "searchAnalytics" && item === "query" && method === "POST") {
      const r = this.sa(site, body);
      return r instanceof Response ? r : J(r);
    }
    if (sub === "sitemaps") {
      const list = (this.sitemaps[site] ??= []);
      if (item === undefined && method === "GET") return J(list.length ? { sitemap: list } : {});
      const sm = list.find((s) => s.path === item);
      if (method === "GET") return sm ? J(sm) : gErr(404, "Sitemap not found.", "notFound");
      if (method === "PUT") {
        if (!this.ignoreWrites) {
          if (sm) sm.lastSubmitted = this.clock;
          else list.push({ path: item!, lastSubmitted: this.clock, isPending: true, isSitemapsIndex: false, type: "sitemap", warnings: "0", errors: "0" });
        }
        return J(undefined);
      }
      if (method === "DELETE") {
        if (!sm) return gErr(404, "Sitemap not found.", "notFound");
        if (!this.ignoreWrites) this.sitemaps[site] = list.filter((s) => s !== sm);
        return J(undefined);
      }
    }
    return gErr(404, "Not found");
  };
}

/**
 * Database, tenant (owner + second admin), three Search Console site accounts and the real GSC tools behind the real
 * pipeline and approval service. `sc-domain:example.com` (write) and `https://shop.example.com/` (write) share one
 * connection; `https://ro.example.com/` is a read-only connection.
 */
export async function gscHarness(label: string, fake: FakeGsc) {
  const db: Db = await testDb();
  const t = await seedTenant(db, label, "owner");
  const tenantId = t.tenant.id;
  const owner = t.user.id;
  const second = (await addUser(db, tenantId, "adm", "admin")).id;
  const main = await seedAccount(db, tenantId, "google_search_console", "write", "active", "sc-domain:example.com", null);
  const [shop] = await db.insert(schema.connectedAccount).values({ tenantId, connectionId: main.connectionId, platform: "google_search_console", externalId: "https://shop.example.com/", access: "write" }).returning();
  const readOnly = await seedAccount(db, tenantId, "google_search_console", "read", "active", "https://ro.example.com/", null);
  const http = new GoogleApiHttp({ fetch: fake.fetch, sleep: async () => {}, random: () => 0 });
  const approvals = new ApprovalService(db);
  const deps: PipelineDeps = {
    db,
    registry: new ToolRegistry(loadInventory()).registerAll(gscTools),
    approvals,
    tenantLimiter: new RateLimiter(10_000, 10_000),
    accountLimiter: new RateLimiter(10_000, 10_000),
    createServices: createServicesFactory({ db, gapi: { tokens: { getAccessToken: async () => "tok" } as unknown as GoogleTokenProvider, http } }),
  };
  return {
    db,
    tenantId,
    owner,
    second,
    accountId: main.id,
    shopId: shop!.id,
    readOnlyId: readOnly.id,
    deps,
    approvals,
    /** Calls a tool as the owner with read and write scopes (account_id defaults to sc-domain:example.com). */
    run: (name: string, args: Record<string, unknown> = {}) => runTool(deps, deps.registry.get(name)!, { account_id: main.id, ...args }, { tenantId, userId: owner, role: "owner", scopes: ["ads:read", "ads:write"] }),
    approveAs: (approvalId: string, userId: string) => approvals.decide({ tenantId, approvalId, decider: { userId, role: userId === owner ? "owner" : "admin" }, decision: "approve", execute: createExecutor(deps) }),
  };
}
export type GscHarness = Awaited<ReturnType<typeof gscHarness>>;

/** Fails the test when a GET, PUT or DELETE carried a body. */
export function guardBodies(fake: FakeGsc) {
  afterEach(() => {
    const found = fake.bodyProblems.splice(0);
    expect(found, "requests that must not carry a body").toEqual([]);
  });
}
