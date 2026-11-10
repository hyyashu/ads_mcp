import { afterEach, expect } from "vitest";
import type { BingTokenProvider, FetchLike } from "../../auth/token-providers";
import { type Db, schema } from "../../db";
import { loadInventory } from "../../inventory";
import { createExecutor, runTool, type PipelineDeps } from "../../mcp/pipeline";
import { ToolRegistry } from "../../mcp/registry";
import type { AnyTool } from "../../mcp/tool";
import { BingHttp } from "../../platforms/bing/http";
import { createServicesFactory } from "../../platforms/services";
import { ApprovalService } from "../../security/approvals";
import { RateLimiter } from "../../security/rate-limit";
import { addUser, seedTenant, testDb } from "../support/helpers";

/**
 * A stand-in for the Bing Webmaster JSON API (https://www.bing.com/webmaster/api.svc/json/{Method}).
 *
 * - GetUserSites answers from `sites`. Every other method answers from `handlers[Method]`, which a test (or a section's own
 *   fixture file) registers; an unregistered method fails the test with a clear message instead of answering something.
 * - A handler returns the value Bing would put in `d` (wrapped here as `{"d": value}`), `undefined` for `{"d": null}`, or a
 *   Response (use `bingErr` for Bing's documented 400 `{ErrorCode, Message}` body).
 * - Every request is recorded with its method name, query parameters (GET) or JSON body (POST) and bearer token.
 * - Protocol checks (collected in `problems`, asserted by `guardProtocol`): reads are GET without a body, changes are POST
 *   with a JSON object body, every call carries `Authorization: Bearer`, and no call ever sends an `apikey`.
 */
export interface BingCall {
  /** Method name from the URL path, e.g. "GetQueryStats". */
  method: string;
  http: "GET" | "POST" | string;
  params: URLSearchParams;
  body: Record<string, any> | undefined;
  token: string | null;
}
export type BingHandler = (c: BingCall, fake: FakeBing) => unknown;

export const J = (body: unknown, status = 200) => new Response(body === undefined ? "" : JSON.stringify(body), { status });
/** Bing's documented error: HTTP 400 with {"ErrorCode": n, "Message": "..."} (ApiErrorCode values in platforms/bing/http.ts). */
export const bingErr = (errorCode: number, message: string, status = 400) => J({ ErrorCode: errorCode, Message: message }, status);
/** A WCF JSON date for a calendar day at midnight in -07:00, as Bing's samples render them. */
export const wcfDay = (isoDay: string, offset = "-0700") => {
  const sign = offset.startsWith("-") ? -1 : 1;
  const mins = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)));
  return `/Date(${Date.parse(`${isoDay}T00:00:00Z`) - mins * 60_000}${offset})/`;
};

export const SITE = "https://www.example.com/";
export const SITE2 = "https://shop.example.com/";
export const RO_SITE = "https://ro.example.com/";

export class FakeBing {
  sites: { Url: string; IsVerified: boolean; AuthenticationCode?: string; DnsVerificationCode?: string }[] = [];
  handlers: Record<string, BingHandler> = {};
  calls: BingCall[] = [];
  problems: string[] = [];
  /** Return a Response to fail a request before it is handled (e.g. a 500 on the first try). */
  fail: (c: BingCall) => Response | undefined = () => undefined;

  constructor() {
    this.reset();
  }

  reset() {
    this.sites = [
      { Url: SITE, IsVerified: true, AuthenticationCode: "AUTHCODE1", DnsVerificationCode: "authcode1.www.example.com" },
      { Url: SITE2, IsVerified: true },
      { Url: RO_SITE, IsVerified: true },
    ];
    this.handlers = {};
    this.calls = [];
    this.problems = [];
    this.fail = () => undefined;
  }

  /** Calls of one method, in order. */
  of(method: string): BingCall[] {
    return this.calls.filter((c) => c.method === method);
  }
  /** Every POST (a change was attempted). */
  get mutations(): BingCall[] {
    return this.calls.filter((c) => c.http === "POST");
  }

  fetch: FetchLike = async (raw, init) => {
    const url = new URL(raw);
    const http = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const prefix = "/webmaster/api.svc/json/";
    if (url.hostname !== "www.bing.com" || !url.pathname.startsWith(prefix)) this.problems.push(`unexpected URL ${url.toString()}`);
    if (url.searchParams.has("apikey")) this.problems.push(`${url.pathname} sent an apikey`);
    if (!token) this.problems.push(`${url.pathname} had no bearer token`);
    let body: Record<string, any> | undefined;
    if (init?.body !== undefined && init?.body !== null) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        this.problems.push(`${url.pathname} body is not JSON`);
      }
    }
    if (http === "GET" && body !== undefined) this.problems.push(`GET ${url.pathname} carried a body`);
    if (http === "POST" && (!body || typeof body !== "object" || Array.isArray(body))) this.problems.push(`POST ${url.pathname} without a JSON object body`);
    const c: BingCall = { method: url.pathname.slice(prefix.length), http, params: url.searchParams, body, token };
    this.calls.push(c);
    const failed = this.fail(c);
    if (failed) return failed;

    if (c.method === "GetUserSites" && http === "GET") return J({ d: this.sites.map((s) => ({ __type: "Site:#Microsoft.Bing.Webmaster.Api", ...s })) });
    const h = this.handlers[c.method];
    if (!h) {
      this.problems.push(`no fake handler for ${http} ${c.method}`);
      return bingErr(11, `NotFound (fake has no handler for ${c.method})`);
    }
    const r = h(c, this);
    if (r instanceof Response) return r;
    return J({ d: r === undefined ? null : r });
  };
}

/** Fails the test when a request broke the protocol rules above or hit a method without a handler. */
export function guardProtocol(fake: FakeBing) {
  afterEach(() => {
    const found = fake.problems.splice(0);
    expect(found, "Bing protocol problems").toEqual([]);
  });
}

/**
 * Database, tenant (owner + second admin), three Bing site accounts and the given tools behind the real pipeline, approval
 * service and services factory. SITE (write) and SITE2 (write) share one connection; RO_SITE is a read-only connection.
 */
export async function bingHarness(label: string, fake: FakeBing, tools: AnyTool[]) {
  const db: Db = await testDb();
  const t = await seedTenant(db, label, "owner");
  const tenantId = t.tenant.id;
  const owner = t.user.id;
  const second = (await addUser(db, tenantId, "adm", "admin")).id;
  const conn = async () => (await db.insert(schema.platformConnection).values({ tenantId, platform: "bing_webmaster", credentialsEnc: "test-not-real", status: "active" }).returning())[0]!;
  const main = await conn();
  const ro = await conn();
  const acc = async (connectionId: string, externalId: string, access: "read" | "write") =>
    (await db.insert(schema.connectedAccount).values({ tenantId, connectionId, platform: "bing_webmaster", externalId, displayName: externalId, access }).returning())[0]!;
  const site = await acc(main.id, SITE, "write");
  const site2 = await acc(main.id, SITE2, "write");
  const readOnly = await acc(ro.id, RO_SITE, "read");
  const http = new BingHttp({ fetch: fake.fetch, sleep: async () => {}, random: () => 0 });
  const approvals = new ApprovalService(db);
  const deps: PipelineDeps = {
    db,
    registry: new ToolRegistry(loadInventory()).registerAll(tools),
    approvals,
    tenantLimiter: new RateLimiter(10_000, 10_000),
    accountLimiter: new RateLimiter(10_000, 10_000),
    createServices: createServicesFactory({ db, bing: { tokens: { getAccessToken: async () => "bing-tok" } as unknown as BingTokenProvider, http } }),
  };
  const run = (name: string, args: Record<string, unknown> = {}, as: { userId?: string; role?: "owner" | "admin" | "member"; scopes?: string[] } = {}) => {
    const tool = deps.registry.get(name);
    if (!tool) throw new Error(`tool ${name} is not registered in this harness`);
    return runTool(deps, tool, { account_id: site.id, ...args }, { tenantId, userId: as.userId ?? owner, role: as.role ?? "owner", scopes: as.scopes ?? ["ads:read", "ads:write"] });
  };
  return {
    db,
    tenantId,
    owner,
    second,
    accountId: site.id,
    site2Id: site2.id,
    readOnlyId: readOnly.id,
    deps,
    approvals,
    /** Calls a tool as the owner with read and write scopes (account_id defaults to SITE). */
    run,
    approveAs: (approvalId: string, userId: string) => approvals.decide({ tenantId, approvalId, decider: { userId, role: userId === owner ? "owner" : "admin" }, decision: "approve", execute: createExecutor(deps) }),
  };
}
export type BingHarness = Awaited<ReturnType<typeof bingHarness>>;
