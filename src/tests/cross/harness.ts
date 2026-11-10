import type { FetchLike, GoogleTokenProvider, MetaTokenProvider } from "../../auth/token-providers";
import { type Db, schema } from "../../db";
import { loadInventory } from "../../inventory";
import type { Envelope } from "../../mcp/envelope";
import { runTool, type PipelineDeps } from "../../mcp/pipeline";
import { ToolRegistry } from "../../mcp/registry";
import { allTools } from "../../platforms";
import { BingHttp } from "../../platforms/bing/http";
import { GoogleApiHttp } from "../../platforms/gapi/http";
import { GoogleAdsHttp } from "../../platforms/google/http";
import { MetaGraphHttp } from "../../platforms/meta/http";
import { createServicesFactory } from "../../platforms/services";
import { ApprovalService } from "../../security/approvals";
import { RateLimiter } from "../../security/rate-limit";
import { FakeBing } from "../bing/fake-bing";
import { type FakeGa4, fakeGa4 } from "../ga4/fake-ga4";
import { FakeGsc } from "../gsc/fake-gsc";
import { FakeGtm, seedContainer } from "../gtm/support/fake-gtm";
import { type FakeGoogle, fakeGoogle } from "../support/fake-google";
import { seedAccount, seedTenant, testDb } from "../support/helpers";
import { J, metaPage } from "../support/meta";
import { schemaChecked } from "../support/schema-guard";

/**
 * One workspace with an account on every platform, linked the way a customer would link them, behind the real pipeline and
 * the real services factory. Each product answers from its existing fake: Google Ads (fakeGoogle, schema-checked), Search
 * Console (FakeGsc), GA4 (fakeGa4), Tag Manager (FakeGtm), Bing Webmaster (FakeBing) and a small Graph API fake. A second
 * workspace owns accounts whose ids are used to probe tenant isolation.
 *
 * Bing: `bing` (https://shop.example.com/) is linked to the Google Ads account and to the Search Console site; `bing2`
 * (https://www.example.com/) is not linked (name it explicitly); `foreignBing` belongs to the other workspace.
 */
type Row = Record<string, unknown>;
export interface FakeMeta {
  fetch: FetchLike;
  ads: Row[];
  campaigns: Row[];
  pixels: Row[];
  insights: (level: string, p: URLSearchParams) => Row[];
  requests: { path: string; params: URLSearchParams }[];
}
export function fakeMeta(): FakeMeta {
  const f: FakeMeta = {
    ads: [],
    campaigns: [],
    pixels: [],
    insights: () => [],
    requests: [],
    fetch: async (url) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/v\d+\.\d+\//, "");
      f.requests.push({ path, params: u.searchParams });
      if (path === "act_987/ads") return metaPage(f.ads, u.searchParams);
      if (path === "act_987/campaigns") return metaPage(f.campaigns, u.searchParams);
      if (path === "act_987/adspixels") return metaPage(f.pixels, u.searchParams);
      if (path === "act_987/insights") return metaPage(f.insights(u.searchParams.get("level") ?? "", u.searchParams), u.searchParams);
      return J({ error: { code: 100, error_subcode: 33, message: "does not exist" } }, 400);
    },
  };
  return f;
}

const tok = { getAccessToken: async () => "tok" } as unknown as GoogleTokenProvider;
const metaTok = { getToken: async () => ({ accessToken: "EAAuser", appSecretProof: "proof" }), proofFor: (t: string) => `proof-${t}` } as unknown as MetaTokenProvider;

export async function link(db: Db, tenantId: string, x: string, y: string) {
  const [a, b] = x < y ? [x, y] : [y, x];
  await db.insert(schema.accountLink).values({ tenantId, accountAId: a, accountBId: b });
}

export async function crossHarness(label: string) {
  const google: FakeGoogle = fakeGoogle();
  const gsc = new FakeGsc();
  gsc.reset();
  const ga4: FakeGa4 = fakeGa4();
  const gtm = new FakeGtm();
  seedContainer(gtm);
  const meta = fakeMeta();
  const bing = new FakeBing();
  const db = await testDb();
  const t = await seedTenant(db, label, "owner");
  const tenantId = t.tenant.id;
  const other = await seedTenant(db, `${label}-other`, "owner");
  const ids = {
    gads: (await seedAccount(db, tenantId, "google_ads", "read", "active", "1234567890", { currencyCode: "USD", timeZone: "America/New_York" })).id,
    gadsUnlinked: (await seedAccount(db, tenantId, "google_ads", "read", "active", "5555555555", { currencyCode: "USD", timeZone: "America/New_York" })).id,
    meta: (await seedAccount(db, tenantId, "meta_ads", "read", "active", "act_987", { currencyCode: "USD", timeZone: "America/Chicago" })).id,
    site: (await seedAccount(db, tenantId, "google_search_console", "read", "active", "sc-domain:example.com", null)).id,
    site2: (await seedAccount(db, tenantId, "google_search_console", "read", "active", "https://shop.example.com/", null)).id,
    prop: (await seedAccount(db, tenantId, "google_analytics", "read", "active", "properties/123", { currencyCode: "EUR", timeZone: "Europe/Berlin" })).id,
    gtm: (await seedAccount(db, tenantId, "google_tag_manager", "read", "active", "accounts/1/containers/2", null)).id,
    foreignSite: (await seedAccount(db, other.tenant.id, "google_search_console", "read", "active", "https://ro.example.com/", null)).id,
    foreignProp: (await seedAccount(db, other.tenant.id, "google_analytics", "read", "active", "properties/123", { currencyCode: "EUR", timeZone: "Europe/Berlin" })).id,
    bing: (await seedAccount(db, tenantId, "bing_webmaster", "read", "active", "https://shop.example.com/", null)).id,
    bing2: (await seedAccount(db, tenantId, "bing_webmaster", "read", "active", "https://www.example.com/", null)).id,
    foreignBing: (await seedAccount(db, other.tenant.id, "bing_webmaster", "read", "active", "https://ro.example.com/", null)).id,
  };
  for (const [x, y] of [
    [ids.gads, ids.site],
    [ids.gads, ids.prop],
    [ids.meta, ids.prop],
    [ids.site, ids.meta],
    [ids.gtm, ids.prop],
    [ids.gtm, ids.gads],
    [ids.gtm, ids.meta],
    [ids.gads, ids.bing],
    [ids.site, ids.bing],
  ] as const)
    await link(db, tenantId, x, y);

  const gapiFetch: FetchLike = (url, init) => {
    const host = new URL(url).hostname;
    if (host.startsWith("analytics")) return ga4.fetch(url, init);
    if (host === "tagmanager.googleapis.com") return gtm.fetch(url, init);
    return gsc.fetch(url, init);
  };
  const deps: PipelineDeps = {
    db,
    registry: new ToolRegistry(loadInventory()).registerAll(allTools()),
    approvals: new ApprovalService(db),
    tenantLimiter: new RateLimiter(10_000, 10_000),
    accountLimiter: new RateLimiter(10_000, 10_000),
    createServices: createServicesFactory({
      db,
      google: { tokens: tok, http: new GoogleAdsHttp({ apiVersion: "v99", sleep: async () => {}, fetch: schemaChecked(google.fetch) }) },
      meta: { tokens: metaTok, http: new MetaGraphHttp({ apiVersion: "v27.0", fetch: meta.fetch, sleep: async () => {} }) },
      gapi: { tokens: tok, http: new GoogleApiHttp({ fetch: gapiFetch, sleep: async () => {}, random: () => 0 }) },
      bing: { tokens: { getAccessToken: async () => "bing-tok" }, http: new BingHttp({ fetch: bing.fetch, sleep: async () => {}, random: () => 0 }) },
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (name: string, args: Record<string, unknown>) => runTool(deps, deps.registry.get(name)!, args, { tenantId, userId: t.user.id, role: "owner", scopes: ["ads:read"] }) as Promise<Envelope & { data: any }>;
  return { db, tenantId, ids, deps, run, google, gsc, ga4, gtm, meta, bing };
}
export type CrossHarness = Awaited<ReturnType<typeof crossHarness>>;

export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const pacificToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/**
 * Search Console analytics answering like Google: `date` rows for every day up to the latest final day (3 days ago, Pacific),
 * `query` rows from the given list; a `query` filter is applied with RE2-like JS regex semantics.
 */
export function gscAnalytics(f: FakeGsc, o: { queries?: [string, number, number, number][]; daily?: (date: string, branded: boolean) => [number, number] } = {}) {
  const latest = addDays(pacificToday(), -3);
  f.sa = (_site, body) => {
    const dims: string[] = body.dimensions ?? [];
    const filters = body.dimensionFilterGroups?.[0]?.filters ?? [];
    if (dims.length === 1 && dims[0] === "date") {
      const rows = [];
      for (let d = body.startDate; d <= body.endDate && d <= latest; d = addDays(d, 1)) {
        const [clicks, impressions] = o.daily ? o.daily(d, filters.length > 0) : [1, 10];
        rows.push({ keys: [d], clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: 3 });
      }
      return { rows: rows.slice(body.startRow ?? 0, (body.startRow ?? 0) + body.rowLimit) };
    }
    if (dims[0] === "query") {
      const rows = (o.queries ?? []).map(([q, clicks, impressions, position]) => ({ keys: [q], clicks, impressions, ctr: impressions ? clicks / impressions : 0, position }));
      return { rows: rows.slice(body.startRow ?? 0, (body.startRow ?? 0) + body.rowLimit) };
    }
    return {};
  };
  return latest;
}
