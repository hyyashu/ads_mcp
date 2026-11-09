import type { FetchLike, GoogleTokenProvider } from "../../auth/token-providers";
import type { Db } from "../../db";
import { loadInventory } from "../../inventory";
import { createExecutor, runTool, type PipelineDeps } from "../../mcp/pipeline";
import { ToolRegistry } from "../../mcp/registry";
import { ga4Tools } from "../../platforms/ga4";
import type { AccountSummary, Audience, AttributionSettings, ChangeHistoryEvent, CustomDimension, DataStream, Ga4Metadata, Ga4Property, GoogleAdsLink, KeyEvent, RunReportResponse } from "../../platforms/ga4/types";
import { GoogleApiHttp } from "../../platforms/gapi/http";
import { createServicesFactory } from "../../platforms/services";
import { ApprovalService } from "../../security/approvals";
import { RateLimiter } from "../../security/rate-limit";
import { addUser, seedAccount, seedTenant, testDb } from "../support/helpers";

/**
 * A stand-in for analyticsdata.googleapis.com and analyticsadmin.googleapis.com (property 123, account 77), with in-memory
 * Admin state and a log of every request. Responses use the documented camelCase shapes; metric values are strings.
 */
export interface Call {
  method: string;
  host: string;
  path: string;
  body: any;
}
export interface FakeGa4 {
  fetch: FetchLike;
  calls: Call[];
  property: Ga4Property;
  streams: DataStream[];
  summaries: AccountSummary[];
  summaryPageSize: number;
  keyEvents: KeyEvent[];
  customDimensions: CustomDimension[];
  adsLinks: GoogleAdsLink[];
  audiences: Audience[];
  attribution: AttributionSettings;
  metadata: Ga4Metadata;
  /** API names checkCompatibility reports INCOMPATIBLE. */
  incompatible: string[];
  report: (body: any) => RunReportResponse;
  pivot: (body: any) => unknown;
  realtime: (body: any) => unknown;
  funnel: (body: any) => unknown;
  history: (body: any) => { changeHistoryEvents?: ChangeHistoryEvent[]; nextPageToken?: string };
  /** Fail the first request whose "METHOD path" contains the key, with this status and Google error body. */
  fail: Record<string, { status: number; body: unknown }>;
  /** Writes answer success but change nothing (read-back must catch it). */
  dropWrites: boolean;
  /** Data API calls (host analyticsdata). */
  dataCalls(kind?: string): Call[];
  /** Mutations sent (POST/DELETE to the Admin API, except searchChangeHistoryEvents). */
  mutations(): Call[];
  /** Back to the initial state (same fetch function, empty call log). */
  reset(): void;
}

const PROP = "properties/123";
export const dim = (apiName: string, o: Record<string, unknown> = {}) => ({ apiName, uiName: apiName, category: "General", ...o });
export const met = (apiName: string, o: Record<string, unknown> = {}) => ({ apiName, uiName: apiName, category: "General", type: "TYPE_INTEGER", ...o });

export const baseMetadata = (): Ga4Metadata => ({
  name: `${PROP}/metadata`,
  dimensions: [
    "date",
    "country",
    "eventName",
    "sessionSource",
    "sessionMedium",
    "sessionCampaignName",
    "sessionDefaultChannelGroup",
    "sessionPrimaryChannelGroup",
    "landingPage",
    "landingPagePlusQueryString",
    "pagePath",
    "pageTitle",
    "deviceCategory",
    "sessionGoogleAdsCampaignId",
    "sessionGoogleAdsCampaignName",
  ].map((n) => dim(n)),
  metrics: [
    met("sessions"),
    met("totalUsers"),
    met("activeUsers"),
    met("eventCount"),
    met("keyEvents", { deprecatedApiNames: ["conversions"] }),
    met("sessionKeyEventRate", { type: "TYPE_FLOAT" }),
    met("engagementRate", { type: "TYPE_FLOAT" }),
    met("totalRevenue", { type: "TYPE_CURRENCY" }),
    met("advertiserAdCost", { type: "TYPE_CURRENCY", blockedReasons: ["NO_COST_METRICS"] }),
    met("screenPageViews"),
  ],
});

/** A runReport response built from header names and string rows. */
export function reportOf(dims: string[], mets: string[], rows: [string[], (string | undefined)[]][], o: Partial<RunReportResponse> & { totals?: any } = {}): RunReportResponse {
  return {
    dimensionHeaders: dims.map((name) => ({ name })),
    metricHeaders: mets.map((name) => ({ name, type: "TYPE_INTEGER" })),
    rows: rows.map(([d, m]) => ({ dimensionValues: d.map((value) => ({ value })), metricValues: m.map((value) => ({ value })) })),
    rowCount: rows.length,
    metadata: { currencyCode: "EUR", timeZone: "Europe/Berlin" },
    propertyQuota: { tokensPerDay: { consumed: 10, remaining: 199_990 }, tokensPerHour: { consumed: 10, remaining: 39_990 }, tokensPerProjectPerHour: { consumed: 10, remaining: 13_990 } },
    kind: "analyticsData#runReport",
    ...o,
  };
}

export function fakeGa4(): FakeGa4 {
  let nextId = 900;
  const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const page = <T>(items: T[], key: string, token: string | null, size: number) => {
    const start = token ? Number(token) : 0;
    const slice = items.slice(start, start + size);
    return { [key]: slice, ...(start + size < items.length ? { nextPageToken: String(start + size) } : {}) };
  };
  const initial = () => ({
    property: { name: PROP, displayName: "Shop", account: "accounts/77", parent: "accounts/77", propertyType: "PROPERTY_TYPE_ORDINARY", serviceLevel: "GOOGLE_ANALYTICS_STANDARD", timeZone: "Europe/Berlin", currencyCode: "EUR", industryCategory: "SHOPPING", createTime: "2024-01-01T00:00:00Z" },
    streams: [] as DataStream[],
    summaries: [] as AccountSummary[],
    summaryPageSize: 200,
    keyEvents: [] as KeyEvent[],
    customDimensions: [] as CustomDimension[],
    adsLinks: [] as GoogleAdsLink[],
    audiences: [] as Audience[],
    attribution: {} as AttributionSettings,
    metadata: baseMetadata(),
    incompatible: [] as string[],
    report: (_b: any): RunReportResponse => reportOf([], [], []),
    pivot: (_b: any): unknown => ({}),
    realtime: (_b: any): unknown => ({}),
    funnel: (_b: any): unknown => ({}),
    history: (_b: any): { changeHistoryEvents?: ChangeHistoryEvent[]; nextPageToken?: string } => ({ changeHistoryEvents: [] }),
    fail: {} as FakeGa4["fail"],
    dropWrites: false,
  });
  const f: FakeGa4 = {
    ...initial(),
    calls: [],
    reset() {
      Object.assign(f, initial());
      f.calls.length = 0;
    },
    dataCalls: (kind) => f.calls.filter((c) => c.host === "analyticsdata.googleapis.com" && (!kind || c.path.endsWith(kind))),
    mutations: () => f.calls.filter((c) => c.host === "analyticsadmin.googleapis.com" && (c.method === "POST" || c.method === "DELETE" || c.method === "PATCH") && !c.path.includes(":searchChangeHistoryEvents")),
    fetch: async (url, init) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const path = u.pathname;
      f.calls.push({ method, host: u.hostname, path, body });
      const key = Object.keys(f.fail).find((k) => `${method} ${path}`.includes(k));
      if (key) {
        const { status, body: b } = f.fail[key]!;
        delete f.fail[key];
        return J(b, status);
      }
      const token = u.searchParams.get("pageToken");
      const size = Number(u.searchParams.get("pageSize") ?? 50);
      const admin = u.hostname === "analyticsadmin.googleapis.com";
      if (admin) {
        if (method === "GET" && path === "/v1beta/accountSummaries") return J(page(f.summaries, "accountSummaries", token, Math.min(size, f.summaryPageSize)));
        if (method === "GET" && path === `/v1beta/${PROP}`) return J(f.property);
        if (method === "GET" && path === `/v1beta/${PROP}/dataStreams`) return J(page(f.streams, "dataStreams", token, size));
        if (path === `/v1beta/${PROP}/keyEvents`) {
          if (method === "GET") return J(page(f.keyEvents, "keyEvents", token, size));
          const k: KeyEvent = { ...body, name: `${PROP}/keyEvents/${nextId++}`, createTime: "2026-11-10T10:00:00Z", deletable: true, custom: true };
          if (!f.dropWrites) f.keyEvents.push(k);
          return J(k);
        }
        if (method === "DELETE" && path.startsWith(`/v1beta/${PROP}/keyEvents/`)) {
          if (!f.dropWrites) f.keyEvents = f.keyEvents.filter((k) => `/v1beta/${k.name}` !== path);
          return new Response("", { status: 200 });
        }
        if (path === `/v1beta/${PROP}/customDimensions`) {
          if (method === "GET") return J(page(f.customDimensions, "customDimensions", token, size));
          const d: CustomDimension = { ...body, name: `${PROP}/customDimensions/${nextId++}` };
          if (!f.dropWrites) f.customDimensions.push(d);
          return J(d);
        }
        if (method === "GET" && path === `/v1beta/${PROP}/googleAdsLinks`) return J(page(f.adsLinks, "googleAdsLinks", token, size));
        if (method === "GET" && path === `/v1alpha/${PROP}/attributionSettings`) return J(f.attribution);
        if (path === `/v1alpha/${PROP}/audiences`) {
          if (method === "GET") return J(page(f.audiences, "audiences", token, size));
          const a: Audience = { ...body, name: `${PROP}/audiences/${nextId++}`, createTime: "2026-11-10T10:00:00Z" };
          if (!f.dropWrites) f.audiences.push(a);
          return J(a);
        }
        if (method === "POST" && /^\/v1beta\/accounts\/\d+:searchChangeHistoryEvents$/.test(path)) return J(f.history(body));
      } else {
        if (method === "GET" && path === `/v1beta/${PROP}/metadata`) return J(f.metadata);
        if (method === "POST" && path === `/v1beta/${PROP}:checkCompatibility`) {
          const c = (x: { name: string }) => (f.incompatible.includes(x.name) ? "INCOMPATIBLE" : "COMPATIBLE");
          return J({
            dimensionCompatibilities: (body.dimensions ?? []).map((d: { name: string }) => ({ dimensionMetadata: { apiName: d.name }, compatibility: c(d) })),
            metricCompatibilities: (body.metrics ?? []).map((m: { name: string }) => ({ metricMetadata: { apiName: m.name }, compatibility: c(m) })),
          });
        }
        if (method === "POST" && path === `/v1beta/${PROP}:runReport`) return J(f.report(body));
        if (method === "POST" && path === `/v1beta/${PROP}:runPivotReport`) return J(f.pivot(body));
        if (method === "POST" && path === `/v1beta/${PROP}:runRealtimeReport`) return J(f.realtime(body));
        if (method === "POST" && path === `/v1alpha/${PROP}:runFunnelReport`) return J(f.funnel(body));
      }
      return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `fake has no handler for ${method} ${u.hostname}${path}` } }, 400);
    },
  };
  return f;
}

/** 429 RESOURCE_EXHAUSTED as the Data API sends it. */
export const quotaError = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Exhausted property tokens per hour for a project per property.", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1200s" }] } };

/**
 * A fresh database with one tenant (owner + admin), a GA4 property properties/123 connected with changes allowed, a second
 * property properties/456 connected read-only, the real registry with ga4Tools, and run / approveAs helpers.
 */
export async function ga4Harness(label: string, f: FakeGa4, o: { units?: { currencyCode: string | null; timeZone: string | null } | null } = {}) {
  const db: Db = await testDb();
  const t = await seedTenant(db, label, "owner");
  const tenantId = t.tenant.id;
  const owner = t.user.id;
  const second = (await addUser(db, tenantId, "adm", "admin")).id;
  const units = o.units === undefined ? { currencyCode: "EUR", timeZone: "Europe/Berlin" } : o.units;
  const accountId = (await seedAccount(db, tenantId, "google_analytics", "write", "active", "properties/123", units)).id;
  const readAccountId = (await seedAccount(db, tenantId, "google_analytics", "read", "active", "properties/456", units)).id;
  const approvals = new ApprovalService(db);
  const http = new GoogleApiHttp({ fetch: f.fetch, sleep: async () => {} });
  const deps: PipelineDeps = {
    db,
    registry: new ToolRegistry(loadInventory()).registerAll(ga4Tools),
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
    accountId,
    readAccountId,
    approvals,
    deps,
    run: (name: string, args: Record<string, unknown>) => runTool(deps, deps.registry.get(name)!, { account_id: accountId, ...args }, { tenantId, userId: owner, role: "owner", scopes: ["ads:read", "ads:write"] }),
    /** A tool context with the property's services, for calling verify() directly. */
    ctx: async () => ({ services: await deps.createServices({ tenantId, account: { id: accountId, platform: "google_analytics", externalId: "properties/123", loginCustomerId: null, connectionId: "c", currencyCode: "EUR", timeZone: "Europe/Berlin" } }) }) as never,
    approveAs: (approvalId: string, userId: string) =>
      approvals.decide({ tenantId, approvalId, decider: { userId, role: userId === owner ? "owner" : "admin" }, decision: "approve", execute: createExecutor(deps) }),
  };
}
export type Ga4Harness = Awaited<ReturnType<typeof ga4Harness>>;
