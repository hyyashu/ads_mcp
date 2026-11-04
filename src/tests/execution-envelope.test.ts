/**
 * Milestone 1 (docs/ARCHITECTURE.md): request ids, redacting structured logs, per-call deadlines, cancellation that reaches
 * the upstream client, jittered backoff, and execution records.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { FetchLike } from "../auth/token-providers";
import { schema } from "../db";
import { loadInventory } from "../inventory";
import { type PipelineDeps, runTool } from "../mcp/pipeline";
import { ToolRegistry, validateTool } from "../mcp/registry";
import type { ReadTool, WriteTool } from "../mcp/tool";
import { pruneExecutions } from "../obs/executions";
import { scrub, setLogSink } from "../obs/logger";
import { GoogleAdsClient } from "../platforms/google/client";
import { GoogleAdsHttp } from "../platforms/google/http";
import { ApprovalService } from "../security/approvals";
import { RateLimiter } from "../security/rate-limit";
import { harness, seedAccount, seedTenant, startStack, testDb, token, type Harness } from "./helpers";
import { googleHarness } from "./support/harness";

const J = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const never = <T>() => new Promise<T>(() => {});
// Like real fetch: rejects at once if the signal is already aborted, otherwise when it aborts.
const waitAbort = (s: AbortSignal) => new Promise<never>((_, rej) => (s.aborted ? rej(new Error("aborted")) : s.addEventListener("abort", () => rej(new Error("aborted")), { once: true })));

// ------------------------------------------------------------------------------------------------ logger
describe("structured logs are redacted", () => {
  let lines: string[] = [];
  let restore: () => void;
  afterEach(() => restore?.());

  it("drops sensitive keys entirely and redacts token patterns in every string", () => {
    const out = scrub({
      authorization: "Bearer abc.def",
      nested: { refresh_token: "1//x", accessToken: "ya29.y", client_secret: "s", cookie: "c", apiKey: "k", ok: "kept" },
      message: "upstream said Bearer ya29.A0ARrdaMsecretsecretsecretsecret and EAABwzLixnjYBO1234567890abcdef",
      list: ["fine", "Bearer qwertyuiopasdfgh"],
    }) as Record<string, any>;
    expect(out.authorization).toBe("[redacted]");
    expect(out.nested).toMatchObject({ refresh_token: "[redacted]", accessToken: "[redacted]", client_secret: "[redacted]", cookie: "[redacted]", apiKey: "[redacted]", ok: "kept" });
    expect(out.message).not.toMatch(/ya29|EAABwz/);
    expect(out.list[1]).not.toContain("qwertyuiop");
  });

  it("serializes errors with redacted message and stack, and bounds depth", () => {
    const e = new Error("failed with access_token=SUPERSECRETVALUE123");
    const out = scrub({ error: e }) as { error: { message: string; stack: string } };
    expect(out.error.message).not.toContain("SUPERSECRETVALUE123");
    expect(out.error.stack).not.toContain("SUPERSECRETVALUE123");
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(scrub(deep))).toContain("[truncated]");
  });

  it("emits one JSON object per line with timestamp, level and event", async () => {
    lines = [];
    restore = setLogSink((l) => lines.push(l));
    const { logger } = await import("../obs/logger");
    logger.warn("test.event", { requestId: "r-1", token: "should-not-appear" });
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ level: "warn", event: "test.event", requestId: "r-1", token: "[redacted]" });
    expect(typeof rec.ts).toBe("string");
  });
});

// ------------------------------------------------------------------------------------------------ contract
describe("tool contract additions", () => {
  const inv = loadInventory();
  it("operation category comes from the inventory", () => {
    const reg = new ToolRegistry(inv);
    expect(reg.operationOf("list_campaigns")).toBe("read");
    expect(reg.operationOf("analyze_wasted_spend")).toBe("analyze");
    expect(reg.operationOf("create_ad")).toBe("create");
    expect(reg.operationOf("pause_campaign")).toBe("update");
    expect(reg.operationOf("remove_ad")).toBe("delete");
  });

  it("rejects out-of-range deadlines", () => {
    const t: ReadTool = { kind: "read", name: "list_labels", platform: "google_ads", title: "x", description: "A test tool with an invalid timeout setting.", input: z.object({ account_id: z.string() }), output: z.object({}), permissions: { scope: "ads:read", platformPermissions: ["x"] }, handler: async () => ({}), timeoutMs: 50 };
    expect(validateTool(t, inv.find((x) => x.name === "list_labels")).join()).toMatch(/timeoutMs/);
    expect(validateTool({ ...t, timeoutMs: 5000 }, inv.find((x) => x.name === "list_labels"))).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------- deadlines, cancellation, records
describe("pipeline deadlines, cancellation and execution records", () => {
  let h: Harness;
  let deps: PipelineDeps;
  let auth: { tenantId: string; userId: string; role: "owner"; scopes: string[] };
  let accountId: string;
  const seen = { signalAbortedLater: false };

  const slowRead: ReadTool = {
    kind: "read", name: "list_labels", platform: "google_ads", title: "Slow", description: "Never finishes on its own (test fixture).", timeoutMs: 150,
    input: z.object({ account_id: z.string() }), output: z.object({ ok: z.boolean() }), permissions: { scope: "ads:read", platformPermissions: ["x"] },
    handler: async (_a, ctx) => {
      ctx.signal.addEventListener("abort", () => (seen.signalAbortedLater = true));
      return never();
    },
  };
  const okRead: ReadTool = { ...slowRead, name: "list_campaigns", timeoutMs: undefined, description: "Answers immediately (test fixture).", handler: async () => ({ ok: true }) };
  const slowPlan: WriteTool = {
    kind: "write", risk: "write", name: "pause_campaign", platform: "google_ads", title: "Slow plan", description: "Planning never finishes (test fixture).", timeoutMs: 150,
    input: z.object({ account_id: z.string(), campaign_id: z.string() }), output: z.object({}), permissions: { scope: "ads:write", platformPermissions: ["x"] },
    plan: () => never(), execute: async () => ({}), verify: async () => ({ outcome: "indeterminate" }),
  };

  beforeAll(async () => {
    h = await harness();
    const t = await seedTenant(h.db, "M1", "owner");
    accountId = (await seedAccount(h.db, t.tenant.id, "google_ads")).id;
    auth = { tenantId: t.tenant.id, userId: t.user.id, role: "owner", scopes: ["ads:read", "ads:write"] };
    deps = { ...h.deps, registry: new ToolRegistry(loadInventory()).registerAll([slowRead, okRead, slowPlan]) };
  });

  const rowsFor = async (requestId: string) => h.db.select().from(schema.toolExecution).where(eq(schema.toolExecution.requestId, requestId));

  it("a call past its deadline returns deadline_exceeded promptly, aborts the handler's signal, and is recorded", async () => {
    const t0 = Date.now();
    const env = await runTool(deps, slowRead, { account_id: accountId }, auth, undefined, "req-deadline-1");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(env.error).toMatchObject({ code: "deadline_exceeded", retryable: true });
    expect(env.meta.request_id).toBe("req-deadline-1");
    expect(seen.signalAbortedLater).toBe(true); // upstream requests made with ctx.signal are aborted too
    const [row] = await rowsFor("req-deadline-1");
    expect(row).toMatchObject({ tool: "list_labels", outcome: "error", errorCode: "deadline_exceeded", operation: "read", accountId });
  });

  it("a client cancellation returns cancelled (not retryable)", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const env = await runTool(deps, { ...slowRead, timeoutMs: 5000 }, { account_id: accountId }, auth, ac.signal, "req-cancel-1");
    expect(env.error).toMatchObject({ code: "cancelled", retryable: false });
  });

  it("planning past its deadline queues nothing", async () => {
    const before = (await h.db.select().from(schema.approvalRequest)).length;
    const env = await runTool(deps, slowPlan, { account_id: accountId, campaign_id: "1" }, auth, undefined, "req-plan-1");
    expect(env.error?.code).toBe("deadline_exceeded");
    expect((await h.db.select().from(schema.approvalRequest)).length).toBe(before);
  });

  it("successful calls are recorded with duration and no arguments or results", async () => {
    const env = await runTool(deps, okRead, { account_id: accountId }, auth, undefined, "req-ok-1");
    expect(env.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20)); // recording is fire-and-forget
    const [row] = await rowsFor("req-ok-1");
    expect(row).toMatchObject({ outcome: "ok", errorCode: null, operation: "read", tenantId: auth.tenantId });
    expect(row!.durationMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(row!)).not.toEqual(expect.arrayContaining(["args", "result"]));
  });

  it("old execution records are pruned", async () => {
    await h.db.update(schema.toolExecution).set({ createdAt: new Date(Date.now() - 40 * 86_400_000) }).where(eq(schema.toolExecution.requestId, "req-ok-1"));
    expect(await pruneExecutions(h.db, 30)).toBeGreaterThanOrEqual(1);
    expect(await rowsFor("req-ok-1")).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------ HTTP request ids
describe("request ids over HTTP", () => {
  it("returns a request id on every response, honours a well-formed inbound one, and puts it in the tool envelope", async () => {
    const h = await harness();
    const t = await seedTenant(h.db, "RQ", "owner");
    const acc = await seedAccount(h.db, t.tenant.id, "google_ads");
    const { token: tok } = await token(h.db, t.tenant.id, t.user.id, ["ads:read"]);
    const st = await startStack(h);
    const minted = (await fetch(`${st.base}/healthz`)).headers.get("x-request-id");
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
    expect((await fetch(`${st.base}/healthz`, { headers: { "x-request-id": "proxy-abc-123" } })).headers.get("x-request-id")).toBe("proxy-abc-123");
    expect((await fetch(`${st.base}/healthz`, { headers: { "x-request-id": "bad id <script>" } })).headers.get("x-request-id")).not.toContain("bad");

    const res = await fetch(`${st.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-request-id": "corr-0001-test" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_campaigns", arguments: { account_id: acc.id } } }),
    });
    expect(res.headers.get("x-request-id")).toBe("corr-0001-test");
    const body = (await res.json()) as { result: { structuredContent: { meta: { request_id: string } } } };
    expect(body.result.structuredContent.meta.request_id).toBe("corr-0001-test");
    await st.close();
  });
});

// ------------------------------------------------------------------------------------------------ Google client
describe("cancellation reaches Google, and retries are jittered", () => {
  it("passes the call's signal to fetch, and an aborted read is not retried", async () => {
    const ac = new AbortController();
    let calls = 0;
    const http = new GoogleAdsHttp({ apiVersion: "v99", sleep: async () => {}, fetch: async (_u, init) => (calls++, ac.abort(), waitAbort(init!.signal as AbortSignal)) });
    const c = new GoogleAdsClient({ http, customerId: "1", loginCustomerId: null, getAccessToken: async () => "tok", signal: ac.signal });
    await expect(c.query("SELECT campaign.id FROM campaign")).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(calls).toBe(1);
  });

  it("a mutation is never started once the call was cancelled (definite: nothing sent)", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const http = new GoogleAdsHttp({ apiVersion: "v99", fetch: async () => (calls++, J({})) });
    const c = new GoogleAdsClient({ http, customerId: "1", loginCustomerId: null, getAccessToken: async () => "tok", signal: ac.signal });
    await expect(c.mutate("campaigns", [{ update: {} }])).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(calls).toBe(0);
    expect(c.mutationsSent).toBe(0);
  });

  it("uses full-jitter backoff bounded by the exponential cap", async () => {
    const sleeps: number[] = [];
    const randoms = [0, 0.999];
    const http = new GoogleAdsHttp({ apiVersion: "v99", sleep: async (ms) => void sleeps.push(ms), random: () => randoms.shift() ?? 0.5, fetch: async () => J({ error: { status: "UNAVAILABLE" } }, 503) });
    await expect(http.call({ accessToken: "t", path: "x", body: {}, idempotent: true })).rejects.toMatchObject({ code: "transient" });
    expect(sleeps).toEqual([0, 499]); // attempt 1: [0,250), attempt 2: [0,500)
  });
});

// ------------------------------------------------------------------------------------------------ executor deadline
describe("an approved change that hits its deadline before sending is a definite failure", () => {
  it("records failed (re-requestable), never unknown_outcome, when nothing reached Google", async () => {
    let executing = false;
    const campaign = { campaign: { id: "5", name: "C", status: "ENABLED", resourceName: "customers/1234567890/campaigns/5" } };
    const fetchFake: FetchLike = async (_u, init) => (executing ? waitAbort(init!.signal as AbortSignal) : J({ results: [campaign] }));
    const g = await googleHarness("exdl", fetchFake);
    g.deps.timeouts = { execute: 150 };
    const env = await g.run("pause_campaign", { campaign_id: "5" });
    expect(env.approval?.status).toBe("pending_approval");
    executing = true; // Google stops answering while the approved change is being prepared
    const done = await g.approveAs(env.approval!.approval_id, g.owner);
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({ error: { code: "deadline_exceeded" } });
    void ApprovalService;
    void RateLimiter;
    void testDb;
  });
});
