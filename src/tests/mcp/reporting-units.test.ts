import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import * as schema from "../../db/schema";
import { MetaSchema } from "../../mcp/envelope";
import { runTool } from "../../mcp/pipeline";
import { googleHarness, type GoogleHarness } from "../support/harness";

/** Fake Google Ads: answers a campaign list, and records every query so tests can prove no units query is sent. */
let queries: string[] = [];
const J = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fake: FetchLike = async (_url, init) => {
  const q = JSON.parse(String(init?.body ?? "{}")).query as string;
  queries.push(q);
  if (q.includes("FROM campaign")) return J({ results: [{ campaign: { id: "11", name: "Brand", status: "ENABLED", advertisingChannelType: "SEARCH", biddingStrategyType: "MANUAL_CPC" }, campaignBudget: { amountMicros: "5000000" } }] });
  return J({ results: [] });
};

let kit: GoogleHarness;
const clearUnits = (id: string) => kit.db.update(schema.connectedAccount).set({ currencyCode: null, timeZone: null }).where(eq(schema.connectedAccount.id, id));
const unitQueries = () => queries.filter((q) => q.includes("customer.currency_code")).length;

beforeAll(async () => {
  kit = await googleHarness("RU", fake);
});
beforeEach(() => {
  queries = [];
});

describe("reporting units in the response envelope", () => {
  it("account tools carry the account's currency and time zone with no extra platform query", async () => {
    const env = await kit.run("list_campaigns", {});
    expect(env.ok).toBe(true);
    expect(env.meta.account).toEqual({ id: kit.accountId, currency_code: "USD", time_zone: "America/New_York" });
    expect(unitQueries()).toBe(0);
  });

  it("units the platform never reported are null (unknown, not guessed), and nothing is queried to fill them", async () => {
    await clearUnits(kit.accountId);
    const env = await kit.run("list_campaigns", {});
    expect(env.ok).toBe(true);
    expect(env.meta.account).toEqual({ id: kit.accountId, currency_code: null, time_zone: null });
    expect(unitQueries()).toBe(0);
    await kit.db.update(schema.connectedAccount).set({ currencyCode: "USD", timeZone: "America/New_York" }).where(eq(schema.connectedAccount.id, kit.accountId));
  });

  it("errors after the account was resolved still name the units; errors before it do not invent any", async () => {
    const bad = await kit.run("list_campaigns", { limit: -5 });
    expect(bad.ok).toBe(false);
    expect(bad.meta.account).toBeUndefined(); // invalid arguments: no account was resolved
    const foreign = await runTool(kit.deps, kit.deps.registry.get("list_campaigns")!, { account_id: "nope" }, { tenantId: kit.tenantId, userId: kit.owner, role: "owner", scopes: ["ads:read"] });
    expect(foreign.error?.code).toBe("not_found");
    expect(foreign.meta.account).toBeUndefined();
  });

  it("tenant-level tools (no ad account) have no account block", async () => {
    const env = await runTool(kit.deps, kit.deps.registry.get("get_usage_status")!, {}, { tenantId: kit.tenantId, userId: kit.owner, role: "owner", scopes: ["ads:read"] });
    expect(env.ok).toBe(true);
    expect(env.meta.account).toBeUndefined();
  });

  it("the published envelope schema accepts the account block and rejects a malformed one", () => {
    const base = { untrusted_text: true as const };
    expect(MetaSchema.safeParse({ ...base, account: { id: "a", currency_code: null, time_zone: "UTC" } }).success).toBe(true);
    expect(MetaSchema.safeParse({ ...base, account: { id: "a", currency_code: 5, time_zone: null } }).success).toBe(false);
    expect(MetaSchema.shape.account.unwrap().description).toMatch(/micros/);
  });
});
