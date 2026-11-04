import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfToken, getSession } from "../auth/web-session";
import { schema } from "../db";
import { addUser, harness, seedAccount, seedTenant, setPassword, startStack, token, type Harness, type Stack } from "./helpers";

interface Env {
  h: Harness;
  stack: Stack;
  server: Stack["server"];
  base: string;
  A: { tenantId: string; account: string; owner: string; ownerEmail: string; admin2: string; admin2Email: string; tokens: Record<"full" | "readOnly", string> };
  B: { tenantId: string; account: string; token: string; ownerEmail: string };
}

async function setup(tenantBurst?: number): Promise<Env> {
  const h = await harness({ tenantBurst });
  const a = await seedTenant(h.db, "A", "owner");
  await setPassword(h.db, a.user.id);
  const accA = await seedAccount(h.db, a.tenant.id, "google_ads");
  const admin2 = await addUser(h.db, a.tenant.id, "A-admin2", "admin");
  await setPassword(h.db, admin2.id);
  const b = await seedTenant(h.db, "B", "owner");
  await setPassword(h.db, b.user.id);
  const accB = await seedAccount(h.db, b.tenant.id, "google_ads");
  // Bearer tokens can read and propose. They can never approve: approval needs a human browser session.
  const tokens = {
    full: (await token(h.db, a.tenant.id, a.user.id, ["ads:read", "ads:write"])).token,
    readOnly: (await token(h.db, a.tenant.id, a.user.id, ["ads:read"])).token,
  };
  const bToken = (await token(h.db, b.tenant.id, b.user.id, ["ads:read", "ads:write"])).token;
  const stack = await startStack(h);
  return { h, stack, server: stack.server, base: stack.base, A: { tenantId: a.tenant.id, account: accA.id, owner: a.user.id, ownerEmail: a.user.email, admin2: admin2.id, admin2Email: admin2.email, tokens }, B: { tenantId: b.tenant.id, account: accB.id, token: bToken, ownerEmail: b.user.email } };
}

async function client(base: string, tok: string) {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
  return c;
}

type Env2 = { ok: boolean; data?: any; error?: any; approval?: any; meta: any };
const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = await c.callTool({ name, arguments: args });
  return { r, env: r.structuredContent as Env2 };
};

/** A human decides in the browser: log in, open the page, submit its CSRF-protected form. */
async function decide(e: Env, email: string | null, id: string, decision: string) {
  if (!email) {
    const r = await fetch(`${e.base}/approvals/${id}/decision`, { method: "POST", redirect: "manual", headers: { origin: e.base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ decision }) });
    return r.status;
  }
  const cookie = await e.stack.login(email);
  // Use the page's own token when the form is shown. Otherwise behave like a user with a VALID session and CSRF token
  // for their own session who aims the request at an approval they should not be able to decide.
  const csrf = await e.stack.csrfFor(cookie, "/approvals", `/approvals/${id}/decision`).catch(async () => csrfToken((await getSession(e.h.db, cookie))!, `approval:${id}`));
  const r = await fetch(`${e.base}/approvals/${id}/decision`, { method: "POST", redirect: "manual", headers: { cookie, origin: e.base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ decision, csrf }) });
  return r.status === 303 ? decodeURIComponent(r.headers.get("location") ?? "") : r.status;
}
const statusOf = async (e: Env, tenantId: string, id: string) => (await e.h.approvals.get(tenantId, id))?.status;

let env: Env;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => { await env.stack.close(); });

describe("transport and authentication", () => {
  it("rejects requests with no or invalid credentials (401 + WWW-Authenticate)", async () => {
    for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: "Bearer adsmcp_doesnotexist" }] as Record<string, string>[]) {
      const res = await fetch(`${env.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
  });

  it("rejects browser origins that are not allowed, even with a valid token", async () => {
    const res = await fetch(`${env.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${env.A.tokens.full}`, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
  });

  it("is stateless POST-only and bounds request size", async () => {
    const get = await fetch(`${env.base}/mcp`, { headers: { authorization: `Bearer ${env.A.tokens.full}` } });
    expect(get.status).toBe(405);
    const big = await fetch(`${env.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${env.A.tokens.full}`, "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(60_000) }) });
    expect(big.status).toBe(400);
    expect((await fetch(`${env.base}/healthz`)).status).toBe(200);
  });

  it("an MCP client can connect and initialize", async () => {
    const c = await client(env.base, env.A.tokens.full);
    expect(c.getServerVersion()?.name).toBe("ads-mcp");
    await c.close();
  });

  it("an expired or revoked token is rejected", async () => {
    const { token: expired } = await (await import("../auth/api-token")).issueApiToken(env.h.db, { tenantId: env.A.tenantId, userId: env.A.owner, label: "old", scopes: ["ads:read"], expiresAt: new Date(Date.now() - 1000) });
    expect((await fetch(`${env.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${expired}`, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    const { token: t, id } = await (await import("../auth/api-token")).issueApiToken(env.h.db, { tenantId: env.A.tenantId, userId: env.A.owner, label: "r", scopes: ["ads:read"] });
    await env.h.db.update(schema.apiToken).set({ revokedAt: new Date() }).where(eq(schema.apiToken.id, id));
    expect((await fetch(`${env.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });
});

describe("protocol revisions", () => {
  // ChatGPT tries 2026-07-28 first. SDK v1 answered 400 "Unsupported protocol version"; v2 serves it natively.
  for (const mode of [{ pin: "2026-07-28" } as const, "auto" as const, "legacy" as const]) {
    it(`serves a client negotiating ${JSON.stringify(mode)}`, async () => {
      const c = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode } });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${env.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${env.A.tokens.full}` } } }));
      const { tools } = await c.listTools();
      expect(tools.map((t) => t.name)).toContain("list_campaigns");
      const r = await c.callTool({ name: "list_campaigns", arguments: { account_id: env.A.account } });
      expect((r.structuredContent as Env2).ok).toBe(true);
      await c.close();
    });
  }
});

describe("tool discovery", () => {
  it("lists only registered tools, each with input schema and annotations, and no output schema", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_campaign_dates", "get_campaign_labels", "list_campaigns", "pause_campaign", "remove_ad"]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema).toBeUndefined(); // keeps tools/list small enough for ChatGPT (see server.ts)
      expect(t.description!.length).toBeGreaterThan(20);
    }
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(by.list_campaigns).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(by.pause_campaign).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(by.remove_ad).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((t) => t.name === "add_keywords")).toBeUndefined(); // pending tools are never exposed
    await c.close();
  });
});

describe("read tools", () => {
  it("returns validated, normalized, structured data and marks text as untrusted", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const { env: e, r } = await call(c, "list_campaigns", { account_id: env.A.account });
    expect(r.isError).toBeFalsy();
    expect(e.ok).toBe(true);
    expect(e.data.campaigns).toHaveLength(1);
    expect(e.data.extra).toBeUndefined(); // fields outside the output schema are dropped
    expect(e.meta.untrusted_text).toBe(true);
    await c.close();
  });

  it("cannot use another tenant's account (reported as not_found, handler not run)", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const before = env.h.calls.read;
    const { env: e } = await call(c, "list_campaigns", { account_id: env.B.account });
    expect(e.ok).toBe(false);
    expect(e.error.code).toBe("not_found");
    expect(env.h.calls.read).toBe(before);
    await c.close();
  });

  it("rejects invalid arguments", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const { r } = await call(c, "list_campaigns", { account_id: env.A.account, limit: 999 });
    expect(r.isError).toBe(true);
    await c.close();
  });

  it("refuses to return data that fails its own output schema", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const { env: e } = await call(c, "get_campaign_dates", { account_id: env.A.account });
    expect(e.ok).toBe(false);
    expect(e.error.code).toBe("internal");
    expect(JSON.stringify(e)).not.toContain("wrong");
    await c.close();
  });

  it("maps platform quota errors to a structured, retryable error with secrets redacted", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const { env: e } = await call(c, "get_campaign_labels", { account_id: env.A.account });
    expect(e.error).toMatchObject({ code: "quota_exceeded", retryable: true, retry_after_seconds: 30 });
    expect(JSON.stringify(e)).not.toContain("SECRETSECRET");
    await c.close();
  });

  it("a read-only token is not shown write tools, cannot call them, and nothing executes", async () => {
    const c = await client(env.base, env.A.tokens.readOnly);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list_campaigns");
    expect(names).not.toContain("pause_campaign");
    const r = await c.callTool({ name: "pause_campaign", arguments: { account_id: env.A.account, campaign_id: "9" } }).catch((e: Error) => ({ isError: true, thrown: e.message }));
    expect(r.isError).toBe(true);
    expect(env.h.calls.execute).toBe(0);
    await c.close();
  });

  it("a write tool on a read-only connected account is refused", async () => {
    const ro = await seedAccount(env.h.db, env.A.tenantId, "google_ads", "read", "active", "7777777777");
    const c = await client(env.base, env.A.tokens.full);
    const { env: e } = await call(c, "pause_campaign", { account_id: ro.id, campaign_id: "9" });
    expect(e.error.code).toBe("permission_denied");
    await c.close();
  });

  it("a connection that needs re-authentication is reported as auth_expired", async () => {
    const stale = await seedAccount(env.h.db, env.A.tenantId, "google_ads", "write", "needs_reauth", "8888888888");
    const c = await client(env.base, env.A.tokens.full);
    const { env: e } = await call(c, "list_campaigns", { account_id: stale.id });
    expect(e.error.code).toBe("auth_expired");
    await c.close();
  });
});

describe("write tools and approval", () => {
  it("queues a pending approval and changes nothing", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const before = env.h.calls.execute;
    const { env: e } = await call(c, "pause_campaign", { account_id: env.A.account, campaign_id: "100" });
    expect(e.ok).toBe(true);
    expect(e.approval).toMatchObject({ status: "pending_approval", risk: "write", summary: "Pause campaign 100" });
    expect(e.data).toBeUndefined();
    expect(env.h.calls.execute).toBe(before);
    await c.close();
  });

  it("deduplicates the same request: one approval, one mutation", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const a = await call(c, "pause_campaign", { account_id: env.A.account, campaign_id: "101" });
    const b = await call(c, "pause_campaign", { account_id: env.A.account, campaign_id: "101" });
    expect(b.env.approval.approval_id).toBe(a.env.approval.approval_id);
    await c.close();
  });

  it("the same change named by Google customer id or by account_id is one approval, stored with this server's id", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const a = await call(c, "pause_campaign", { account_id: "123-456-7890", campaign_id: "109" });
    const b = await call(c, "pause_campaign", { account_id: env.A.account, campaign_id: "109" });
    expect(a.env.ok).toBe(true);
    expect(b.env.approval.approval_id).toBe(a.env.approval.approval_id);
    const [row] = await env.h.db.select().from(schema.approvalRequest).where(eq(schema.approvalRequest.id, a.env.approval.approval_id));
    expect((row!.args as { account_id: string }).account_id).toBe(env.A.account);
    expect(row!.accountId).toBe(env.A.account);
    await c.close();
  });

  it("no bearer token, however privileged, can approve: only a human browser session can", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const { env: e } = await call(c, "pause_campaign", { account_id: env.A.account, campaign_id: "102" });
    const id = e.approval.approval_id as string;
    const exec0 = env.h.calls.execute;
    for (const tok of [env.A.tokens.full, env.B.token]) {
      const r = await fetch(`${env.base}/approvals/${id}/decision`, { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${tok}`, origin: env.base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ decision: "approve" }) });
      expect([401, 403]).toContain(r.status);
    }
    expect(await decide(env, null, id, "approve")).toBe(401); // no session
    expect(env.h.calls.execute).toBe(exec0);
    expect(await statusOf(env, env.A.tenantId, id)).toBe("pending");
    await c.close();
  });

  it("a signed-in owner approves in the browser; it executes exactly once with an idempotency key", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const { env: e } = await call(c, "pause_campaign", { account_id: env.A.account, campaign_id: "103" });
    const id = e.approval.approval_id as string;
    const exec0 = env.h.calls.execute;
    expect(await decide(env, env.A.ownerEmail, id, "approve")).toMatch(/executed/);
    expect(env.h.calls.execute).toBe(exec0 + 1);
    expect(env.h.calls.lastKey).toMatch(/^[0-9a-f]{64}$/);
    expect(await statusOf(env, env.A.tenantId, id)).toBe("executed");
    expect(String(await decide(env, env.A.ownerEmail, id, "approve"))).toMatch(/already executed|conflict/i);
    expect(env.h.calls.execute).toBe(exec0 + 1);
    await c.close();
  });

  it("another tenant's user cannot decide it", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const { env: e } = await call(c, "pause_campaign", { account_id: env.A.account, campaign_id: "104" });
    const id = e.approval.approval_id as string;
    const exec0 = env.h.calls.execute;
    expect(String(await decide(env, env.B.ownerEmail, id, "approve"))).toMatch(/No such approval/);
    expect(env.h.calls.execute).toBe(exec0);
    expect(await statusOf(env, env.A.tenantId, id)).toBe("pending");
    await c.close();
  });

  it("rejecting never executes", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const { env: e } = await call(c, "pause_campaign", { account_id: env.A.account, campaign_id: "105" });
    const exec0 = env.h.calls.execute;
    expect(await decide(env, env.A.ownerEmail, e.approval.approval_id, "reject")).toMatch(/rejected/);
    expect(env.h.calls.execute).toBe(exec0);
    await c.close();
  });

  it("destructive changes need a second person to approve", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const { env: e } = await call(c, "remove_ad", { account_id: env.A.account, campaign_id: "ad-1" });
    expect(e.approval.risk).toBe("destructive");
    expect(String(await decide(env, env.A.ownerEmail, e.approval.approval_id, "approve"))).toMatch(/someone other than the requester/);
    expect(await statusOf(env, env.A.tenantId, e.approval.approval_id)).toBe("pending");
    expect(await decide(env, env.A.admin2Email, e.approval.approval_id, "approve")).toMatch(/executed/);
    await c.close();
  });

  it("detects drift: if the account changed since the request, nothing is applied", async () => {
    const c = await client(env.base, env.A.tokens.full);
    env.h.calls.snapshot = { status: "ENABLED" };
    const { env: e } = await call(c, "pause_campaign", { account_id: env.A.account, campaign_id: "106" });
    env.h.calls.snapshot = { status: "PAUSED_BY_SOMEONE_ELSE" };
    const exec0 = env.h.calls.execute;
    expect(await decide(env, env.A.ownerEmail, e.approval.approval_id, "approve")).toMatch(/failed/);
    expect(env.h.calls.execute).toBe(exec0);
    const row = await env.h.approvals.get(env.A.tenantId, e.approval.approval_id);
    expect(row?.result).toMatchObject({ error: { code: "conflict" } });
    env.h.calls.snapshot = { status: "ENABLED" };
    await c.close();
  });
});

describe("safety properties", () => {
  it("never leaks credentials or tokens in any response", async () => {
    const c = await client(env.base, env.A.tokens.full);
    const seen: string[] = [];
    for (const [n, a] of [["list_campaigns", { account_id: env.A.account }], ["get_campaign_labels", { account_id: env.A.account }], ["pause_campaign", { account_id: env.A.account, campaign_id: "555" }]] as const) {
      seen.push(JSON.stringify((await call(c, n, a as Record<string, unknown>)).r));
    }
    const all = seen.join("");
    for (const secret of ["test-not-real", "adsmcp_", "ya29.", env.A.tokens.full]) expect(all).not.toContain(secret);
    await c.close();
  });

  it("audit and usage records contain no arguments or results", async () => {
    const rows = await env.h.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, env.A.tenantId));
    expect(rows.length).toBeGreaterThan(0);
    const blob = JSON.stringify(rows);
    for (const leaked of ["Ignore previous instructions", "campaign_id", "SECRETSECRET"]) expect(blob).not.toContain(leaked);
    const usage = await env.h.db.select().from(schema.usageCounter).where(eq(schema.usageCounter.tenantId, env.A.tenantId));
    expect(usage.find((u) => u.tool === "list_campaigns")!.calls).toBeGreaterThan(0);
  });

  it("tenant B sees none of tenant A's approvals or usage", async () => {
    const rows = await env.h.db.select().from(schema.approvalRequest).where(eq(schema.approvalRequest.tenantId, env.B.tenantId));
    expect(rows).toHaveLength(0);
  });
});

describe("rate limiting", () => {
  it("refuses calls beyond the tenant's burst with a retry hint", async () => {
    const small = await setup(2);
    const c = await client(small.base, small.A.tokens.full);
    const results: Env2[] = [];
    for (let i = 0; i < 4; i++) results.push((await call(c, "list_campaigns", { account_id: small.A.account })).env);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    const denied = results.find((r) => !r.ok)!;
    expect(denied.error).toMatchObject({ code: "quota_exceeded", retryable: true });
    expect(denied.error.retry_after_seconds).toBeGreaterThanOrEqual(1);
    await c.close();
    await small.stack.close();
  });
});
