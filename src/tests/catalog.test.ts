import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { tenantCapabilities, visibleTools } from "../mcp/catalog";
import { googleTools } from "../platforms/google";
import { seedAccount, seedTenant, startStack, token as issue, type Stack } from "./helpers";

const token = async (...a: Parameters<typeof issue>) => (await issue(...a)).token;
import { googleHarness, type GoogleHarness } from "./support/harness";

const READ = ["ads:read"];
const FULL = ["ads:read", "ads:write"];
const WORKSPACE_TOOLS = googleTools.filter((t) => t.accountScope === "none").map((t) => t.name).sort();

describe("visibleTools (pure)", () => {
  const google = new Map([["google_ads" as const, { write: true }]]);
  it("a read-only token sees no write tools", () => {
    const v = visibleTools(googleTools, { scopes: READ }, google);
    expect(v.some((t) => t.kind === "write")).toBe(false);
    expect(v.length).toBe(googleTools.filter((t) => t.kind === "read").length);
  });
  it("an account connected read-only hides write tools even for a full token", () => {
    expect(visibleTools(googleTools, { scopes: FULL }, new Map([["google_ads", { write: false }]])).some((t) => t.kind === "write")).toBe(false);
  });
  it("no connection: only workspace tools", () => {
    expect(visibleTools(googleTools, { scopes: FULL }, new Map()).map((t) => t.name).sort()).toEqual(WORKSPACE_TOOLS);
  });
  it("a connection to another platform does not expose this platform's tools", () => {
    expect(visibleTools(googleTools, { scopes: FULL }, new Map([["meta_ads", { write: true }]])).map((t) => t.name).sort()).toEqual(WORKSPACE_TOOLS);
  });
  it("full token with a write account sees every tool", () => {
    expect(visibleTools(googleTools, { scopes: FULL }, google)).toHaveLength(googleTools.length);
  });
});

describe("tools/list over MCP", () => {
  let kit: GoogleHarness;
  let stack: Stack;
  beforeAll(async () => {
    kit = await googleHarness("CT", async () => new Response("{}"));
    stack = await startStack({ ...kit, registry: kit.deps.registry, calls: {} } as never);
  });
  afterAll(() => stack.close());

  const connect = async (tok: string) => {
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${stack.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
    return c;
  };
  const list = async (tok: string) => {
    const c = await connect(tok);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    const instructions = c.getInstructions() ?? "";
    await c.close();
    return { names, instructions };
  };

  it("a workspace with a write-connected Google account sees every Google tool", async () => {
    const { names, instructions } = await list(await token(kit.db, kit.tenantId, kit.owner, FULL));
    expect(names).toHaveLength(googleTools.length);
    expect(instructions).toContain("Connected: Google Ads (read and write)");
  });

  it("a read-only token sees read tools only, and the instructions say so", async () => {
    const { names, instructions } = await list(await token(kit.db, kit.tenantId, kit.owner, READ));
    expect(names).toContain("list_campaigns");
    expect(names).not.toContain("pause_campaign");
    expect(instructions).toContain("authorized read-only");
  });

  it("a workspace with nothing connected sees only workspace tools and is told how to connect", async () => {
    const t = await seedTenant(kit.db, "CT-empty", "owner");
    const { names, instructions } = await list(await token(kit.db, t.tenant.id, t.user.id, FULL));
    expect(names).toEqual(WORKSPACE_TOOLS);
    expect(instructions).toContain("No ad accounts are connected");
    expect(instructions).toContain("Connections page");
  });

  it("read-only accounts expose read tools only; a revoked connection exposes nothing; the next listing reflects a new connection", async () => {
    const t = await seedTenant(kit.db, "CT-ro", "owner");
    const tok = await token(kit.db, t.tenant.id, t.user.id, FULL);
    const ro = await seedAccount(kit.db, t.tenant.id, "google_ads", "read");
    let r = await list(tok);
    expect(r.names).toContain("list_campaigns");
    expect(r.names).not.toContain("pause_campaign");
    expect(r.instructions).toContain("Google Ads (read only)");

    await kit.db.update(schema.platformConnection).set({ status: "revoked" }).where(eq(schema.platformConnection.id, ro.connectionId));
    expect((await list(tok)).names).toEqual(WORKSPACE_TOOLS);

    await seedAccount(kit.db, t.tenant.id, "google_ads", "write", "active", "4444444444");
    r = await list(tok);
    expect(r.names).toContain("pause_campaign");
  });

  it("another workspace's connections never count", async () => {
    const t = await seedTenant(kit.db, "CT-iso", "owner");
    expect((await tenantCapabilities(kit.db, t.tenant.id)).size).toBe(0);
    expect((await tenantCapabilities(kit.db, kit.tenantId)).get("google_ads")).toEqual({ write: true });
  });

  it("a hidden tool cannot be called by name", async () => {
    const t = await seedTenant(kit.db, "CT-hidden", "owner");
    const c = await connect(await token(kit.db, t.tenant.id, t.user.id, FULL));
    const r = await c.callTool({ name: "list_campaigns", arguments: { account_id: kit.accountId } }).catch(() => ({ isError: true }));
    expect(r.isError).toBe(true);
    await c.close();
  });
});
