import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import type { Db } from "../../db";
import { createExecutor, runTool, type PipelineDeps } from "../../mcp/pipeline";
import { MetaAdsClient, currencyOffset, fromMinor, toMinor } from "../../platforms/meta/client";
import { MetaGraphHttp, mapMetaError, retryAfterFromHeaders } from "../../platforms/meta/http";
import { addUser, seedAccount, seedTenant, testDb } from "../support/helpers";
import { J, metaDeps, metaNotFound } from "../support/meta";

const TOKEN = "EAAsecretaccesstoken1234567890";
const tokens = { getToken: async () => ({ accessToken: TOKEN, appSecretProof: "proof123" }) };

describe("error mapping (documented codes)", () => {
  const m = (code: number, extra: Record<string, unknown> = {}, status = 400, mutation = false) => mapMetaError(status, { error: { code, message: "m", ...extra } }, mutation).code;
  it("maps auth, throttling, permission, not found, transient and validation errors", () => {
    expect(m(190)).toBe("auth_expired");
    expect(m(102)).toBe("auth_expired");
    for (const c of [4, 17, 32, 613, 80000, 80004, 80014]) expect(m(c)).toBe("quota_exceeded");
    expect(m(10)).toBe("platform_permission_denied");
    expect(m(200)).toBe("platform_permission_denied");
    expect(m(100, { error_subcode: 33 })).toBe("not_found");
    expect(m(2, {}, 500)).toBe("transient");
    expect(m(1, { is_transient: true }, 500, true)).toBe("unknown_outcome"); // a write that may have landed
    expect(m(100)).toBe("invalid_argument");
  });
  it("uses the user-facing message, redacts tokens, and keeps the fbtrace id for support", () => {
    const e = mapMetaError(400, { error: { code: 100, message: "raw", error_user_msg: `Bad value for access_token=${TOKEN}`, fbtrace_id: "Abc123" } }, false);
    expect(e.message).not.toContain(TOKEN);
    expect(e.opts.details).toEqual({ fbtrace_id: "Abc123" });
  });
  it("reads the wait from usage headers: business use case in minutes, ad account in seconds", () => {
    expect(retryAfterFromHeaders(new Headers({ "x-business-use-case-usage": JSON.stringify({ "123": [{ type: "ads_management", call_count: 100, estimated_time_to_regain_access: 19 }] }) }))).toBe(19 * 60);
    expect(retryAfterFromHeaders(new Headers({ "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 100, reset_time_duration: 42 }) }))).toBe(42);
    expect(retryAfterFromHeaders(new Headers({ "x-business-use-case-usage": "not json" }))).toBeUndefined();
    const e = mapMetaError(400, { error: { code: 80004 } }, false, new Headers({ "x-business-use-case-usage": JSON.stringify({ "1": [{ estimated_time_to_regain_access: 2 }] }) }));
    expect(e.opts.retryAfterSeconds).toBe(120);
  });
});

describe("currency offsets (Marketing API currencies reference)", () => {
  it("offset 1 currencies are whole units; others are hundredths", () => {
    expect(currencyOffset("JPY")).toBe(1);
    expect(currencyOffset("TWD")).toBe(1);
    expect(currencyOffset("USD")).toBe(100);
    expect(currencyOffset("HKD")).toBe(100);
    expect(fromMinor("5000", "USD")).toBe(50);
    expect(fromMinor("5000", "JPY")).toBe(5000);
    expect(fromMinor(undefined, "USD")).toBeNull();
    expect(toMinor(12.345, "USD")).toBe(1235);
    expect(() => fromMinor("1", null)).toThrow(/currency is unknown/);
  });
});

describe("transport", () => {
  let calls: { url: string; init: RequestInit }[];
  const http = (fetch: FetchLike) => new MetaGraphHttp({ apiVersion: "v26.0", fetch: async (u, i) => (calls.push({ url: u, init: i ?? {} }), fetch(u, i)), sleep: async () => {}, random: () => 0 });
  beforeEach(() => (calls = []));

  it("requires an explicit version and a plain path", async () => {
    expect(() => new MetaGraphHttp({ apiVersion: "v26" })).toThrow();
    await expect(http(async () => J({})).call({ accessToken: TOKEN, appSecretProof: "p", path: "https://evil.example/x", idempotent: true })).rejects.toMatchObject({ code: "internal" });
  });

  it("the token travels only in the Authorization header; appsecret_proof in the query (GET) or body (POST)", async () => {
    const h = http(async () => J({ ok: 1 }));
    await h.call({ accessToken: TOKEN, appSecretProof: "proof123", path: "act_1/campaigns", params: { fields: "id" }, idempotent: true });
    await h.call({ accessToken: TOKEN, appSecretProof: "proof123", path: "123", method: "POST", params: { status: "PAUSED" }, idempotent: false });
    for (const c of calls) {
      expect(c.url).not.toContain(TOKEN);
      expect(c.url.startsWith("https://graph.facebook.com/v26.0/")).toBe(true);
      expect((c.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(new URL(calls[0]!.url).searchParams.get("appsecret_proof")).toBe("proof123");
    expect(String(calls[1]!.init.body)).toBe("status=PAUSED&appsecret_proof=proof123");
    expect(String(calls[1]!.init.body)).not.toContain(TOKEN);
  });

  it("retries reads on transient errors, never writes", async () => {
    let n = 0;
    const flaky = http(async () => (++n < 3 ? J({ error: { code: 2, message: "down" } }, 500) : J({ data: [] })));
    await expect(flaky.call({ accessToken: TOKEN, appSecretProof: "p", path: "act_1/campaigns", idempotent: true })).resolves.toEqual({ data: [] });
    expect(n).toBe(3);
    n = 0;
    const down = http(async () => (n++, J({ error: { code: 2, message: "down" } }, 500)));
    await expect(down.call({ accessToken: TOKEN, appSecretProof: "p", path: "1", method: "POST", params: {}, idempotent: false })).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(n).toBe(1);
    const dead = http(async () => {
      throw new TypeError("network");
    });
    await expect(dead.call({ accessToken: TOKEN, appSecretProof: "p", path: "1", method: "POST", params: {}, idempotent: false })).rejects.toMatchObject({ code: "unknown_outcome" });
  });

  it("an error body on a 200 response is still an error", async () => {
    await expect(http(async () => J({ error: { code: 100, message: "bad" } }, 200)).call({ accessToken: TOKEN, appSecretProof: "p", path: "1", idempotent: true })).rejects.toMatchObject({ code: "invalid_argument" });
  });
});

describe("client", () => {
  it("paginates with the after cursor and never follows the raw next URL", async () => {
    const urls: string[] = [];
    const http = new MetaGraphHttp({
      apiVersion: "v26.0",
      fetch: async (u) => {
        urls.push(u);
        const after = new URL(u).searchParams.get("after");
        return after ? J({ data: [{ id: "2" }] }) : J({ data: [{ id: "1" }], paging: { cursors: { after: "CUR" }, next: "https://graph.facebook.com/v26.0/act_1/campaigns?access_token=LEAKED&after=CUR" } });
      },
    });
    const c = new MetaAdsClient({ http, adAccountId: "act_1", currency: "USD", getToken: tokens.getToken });
    expect((await c.list("act_1/campaigns", { fields: "id" })).map((r) => r.id)).toEqual(["1", "2"]);
    expect(urls.every((u) => !u.includes("LEAKED"))).toBe(true);
  });

  it("refuses objects that belong to another ad account the token can also reach", async () => {
    const http = new MetaGraphHttp({ apiVersion: "v26.0", fetch: async () => J({ id: "55", account_id: "999", status: "ACTIVE" }) });
    const c = new MetaAdsClient({ http, adAccountId: "act_1", currency: "USD", getToken: tokens.getToken });
    await expect(c.getOwned("55", ["status"], "campaign")).rejects.toMatchObject({ code: "not_found" });
    await expect(c.getOwned("55; DROP", ["status"], "campaign")).rejects.toMatchObject({ code: "invalid_argument" });
  });
});

// ------------------------------------------------------------------------------------- tools through the pipeline
type Camp = { name: string; status: string; account: string; daily?: string };
let camps: Record<string, Camp>;
let posts: { url: string; body: string }[];
let postFails = false;
const fake: FetchLike = async (url, init) => {
  const u = new URL(url);
  const path = u.pathname.replace("/v26.0/", "");
  if ((init?.method ?? "GET") === "POST") {
    posts.push({ url, body: String(init?.body) });
    if (postFails) return J({ error: { code: 2, message: "temporary", is_transient: true } }, 500);
    const st = new URLSearchParams(String(init?.body)).get("status");
    if (st && camps[path]) camps[path]!.status = st;
    return J({ success: true });
  }
  if (path === "act_987/campaigns") {
    return J({ data: Object.entries(camps).filter(([, c]) => c.account === "987").map(([id, c]) => ({ id, name: c.name, status: c.status, effective_status: c.status, objective: "OUTCOME_SALES", ...(c.daily ? { daily_budget: c.daily } : {}) })) });
  }
  const c = camps[path];
  return c ? J({ id: path, name: c.name, status: c.status, effective_status: c.status, account_id: c.account }) : metaNotFound();
};

let db: Db, deps: PipelineDeps, tenantId: string, owner: string, second: string, accountId: string;
beforeAll(async () => {
  db = await testDb();
  const t = await seedTenant(db, "MT", "owner");
  tenantId = t.tenant.id;
  owner = t.user.id;
  second = (await addUser(db, tenantId, "mt-adm", "admin")).id;
  accountId = (await seedAccount(db, tenantId, "meta_ads", "write", "active", "act_987", { currencyCode: "JPY", timeZone: "Asia/Tokyo" })).id;
  deps = metaDeps(db, { tokens, fetch: fake, apiVersion: "v26.0" });
});
beforeEach(() => {
  camps = { "120001": { name: "Spring", status: "ACTIVE", account: "987", daily: "5000" }, "120002": { name: "Old", status: "ARCHIVED", account: "987" }, "120003": { name: "Paused", status: "PAUSED", account: "987" }, "120004": { name: "Summer", status: "ACTIVE", account: "987" }, "120009": { name: "Other account", status: "ACTIVE", account: "111" } };
  posts = [];
  postFails = false;
});
const run = (name: string, args: Record<string, unknown>) => runTool(deps, deps.registry.get(name)!, { account_id: accountId, ...args }, { tenantId, userId: owner, role: "owner", scopes: ["ads:read", "ads:write"] });
const approve = (id: string, by = owner) => deps.approvals.decide({ tenantId, approvalId: id, decider: { userId: by, role: by === owner ? "owner" : "admin" }, decision: "approve", execute: createExecutor(deps) });

describe("list_meta_campaigns", () => {
  it("lists live campaigns with budgets in account currency units, leaving out archived ones", async () => {
    const r = await run("list_meta_campaigns", {});
    expect(r.ok).toBe(true);
    const d = r.data as { campaigns: { campaign_id: string; daily_budget: number | null }[] };
    expect(d.campaigns.map((c) => c.campaign_id)).toEqual(["120001", "120003", "120004"]);
    expect(d.campaigns[0]!.daily_budget).toBe(5000); // JPY has offset 1
    expect(r.meta.account).toEqual({ id: accountId, currency_code: "JPY", time_zone: "Asia/Tokyo" });
    expect((await run("list_meta_campaigns", { status: "PAUSED" })).data).toMatchObject({ returned: 1 });
    expect((await run("list_meta_campaigns", { include_archived: true })).data).toMatchObject({ returned: 4 });
  });
});

describe("pause / resume Meta campaign", () => {
  it("pausing queues a write-risk approval with a change set, then applies and confirms it", async () => {
    const r = await run("pause_meta_campaign", { campaign_id: "120001" });
    expect(r.approval).toMatchObject({ risk: "write", change_set: { changes: [{ resource: "campaign", id: "120001", before: "ACTIVE", after: "PAUSED", effect: "pause" }] } });
    expect(posts).toHaveLength(0);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(done.result).toEqual({ campaign_id: "120001", status: "PAUSED", previous_status: "ACTIVE" });
    expect(posts).toHaveLength(1);
    expect(new URL(posts[0]!.url).pathname).toBe("/v26.0/120001");
    expect(new URLSearchParams(posts[0]!.body).get("status")).toBe("PAUSED");
  });

  it("resuming is high impact and waits for a person", async () => {
    const r = await run("resume_meta_campaign", { campaign_id: "120003" });
    expect(r.approval).toMatchObject({ risk: "high_impact", change_set: { changes: [{ effect: "enable" }] } });
    expect((await approve(r.approval!.approval_id, second)).status).toBe("executed");
    expect(camps["120003"]!.status).toBe("ACTIVE");
  });

  it("refuses campaigns of another ad account, archived and no-op requests, and sends nothing", async () => {
    expect((await run("pause_meta_campaign", { campaign_id: "120009" })).error?.code).toBe("not_found");
    expect((await run("pause_meta_campaign", { campaign_id: "424242" })).error?.code).toBe("not_found");
    expect((await run("pause_meta_campaign", { campaign_id: "120002" })).error?.message).toContain("archived");
    expect((await run("pause_meta_campaign", { campaign_id: "120003" })).error?.message).toContain("already");
    expect(posts).toHaveLength(0);
  });

  it("refuses on drift, and a failed write is an unknown outcome that verify() reconciles from live state", async () => {
    const r = await run("pause_meta_campaign", { campaign_id: "120004" });
    camps["120004"]!.status = "PAUSED";
    const drifted = await approve(r.approval!.approval_id);
    expect(drifted.status).toBe("failed");
    expect(posts).toHaveLength(0);

    camps["120004"]!.status = "ACTIVE";
    const again = await run("pause_meta_campaign", { campaign_id: "120004" });
    postFails = true;
    const unknown = await approve(again.approval!.approval_id);
    expect(unknown.status).toBe("unknown_outcome");
    const tool = deps.registry.get("pause_meta_campaign")!;
    if (tool.kind !== "write") throw new Error("expected a write tool");
    const ctx = { tenantId, userId: owner, account: null, signal: new AbortController().signal, services: await deps.createServices({ tenantId, account: { platform: "meta_ads", externalId: "act_987", id: accountId, loginCustomerId: null, connectionId: "x", currencyCode: "JPY" } }) };
    expect(await tool.verify({ account_id: accountId, campaign_id: "120004" }, ctx as never, { snapshot: { status: "ACTIVE" } })).toEqual({ outcome: "not_applied" });
  });
});
