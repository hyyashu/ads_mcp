import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../auth/token-providers";
import * as schema from "../db/schema";
import { MetaSchema } from "../mcp/envelope";
import { runTool } from "../mcp/pipeline";
import { seedAccount, seedTenant } from "./helpers";
import { googleHarness, type GoogleHarness } from "./support/harness";

/** Fake Google Ads: answers the units query and a campaign list; can be told to fail the units query. */
let queries: string[] = [];
let unitsFail = false;
let units: { currencyCode?: string; timeZone?: string } = { currencyCode: "JPY", timeZone: "Asia/Tokyo" };
const J = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fake: FetchLike = async (_url, init) => {
  const q = JSON.parse(String(init?.body ?? "{}")).query as string;
  queries.push(q);
  if (q.includes("customer.currency_code")) {
    if (unitsFail) return J({ error: { code: 403, status: "PERMISSION_DENIED", message: "no" } }, 403);
    return J({ results: [{ customer: units }] });
  }
  if (q.includes("FROM campaign")) return J({ results: [{ campaign: { id: "11", name: "Brand", status: "ENABLED", advertisingChannelType: "SEARCH", biddingStrategyType: "MANUAL_CPC" }, campaignBudget: { amountMicros: "5000000" } }] });
  return J({ results: [] });
};

let kit: GoogleHarness;
const account = (id: string) => kit.db.select().from(schema.connectedAccount).where(eq(schema.connectedAccount.id, id)).then((r) => r[0]!);
const clearUnits = (id: string) => kit.db.update(schema.connectedAccount).set({ currencyCode: null, timeZone: null }).where(eq(schema.connectedAccount.id, id));
const unitQueries = () => queries.filter((q) => q.includes("customer.currency_code")).length;

beforeAll(async () => {
  kit = await googleHarness("RU", fake);
});
beforeEach(() => {
  queries = [];
  unitsFail = false;
  units = { currencyCode: "JPY", timeZone: "Asia/Tokyo" };
});

describe("reporting units in the response envelope", () => {
  it("account tools carry the account's currency and time zone; known units cost no extra query", async () => {
    const env = await kit.run("list_campaigns", {});
    expect(env.ok).toBe(true);
    expect(env.meta.account).toEqual({ id: kit.accountId, currency_code: "USD", time_zone: "America/New_York" });
    expect(unitQueries()).toBe(0);
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

describe("backfill for accounts connected before units were stored", () => {
  it("reads units once from Google, stores them, and returns them; the next call issues no units query", async () => {
    await clearUnits(kit.accountId);
    const first = await kit.run("list_campaigns", {});
    expect(first.ok).toBe(true);
    expect(first.meta.account).toEqual({ id: kit.accountId, currency_code: "JPY", time_zone: "Asia/Tokyo" });
    expect(unitQueries()).toBe(1);
    expect(await account(kit.accountId)).toMatchObject({ currencyCode: "JPY", timeZone: "Asia/Tokyo" });

    queries = [];
    const second = await kit.run("list_campaigns", {});
    expect(second.meta.account).toEqual({ id: kit.accountId, currency_code: "JPY", time_zone: "Asia/Tokyo" });
    expect(unitQueries()).toBe(0);
  });

  it("a failing units query never fails the call: the data comes back and units stay null (unknown, not guessed)", async () => {
    await clearUnits(kit.accountId);
    unitsFail = true;
    const env = await kit.run("list_campaigns", {});
    expect(env.ok).toBe(true);
    expect((env.data as { campaigns: unknown[] }).campaigns).toHaveLength(1);
    expect(env.meta.account).toEqual({ id: kit.accountId, currency_code: null, time_zone: null });
    expect(await account(kit.accountId)).toMatchObject({ currencyCode: null, timeZone: null });
  });

  it("only the missing unit is filled; a stored one is never overwritten by the backfill", async () => {
    await kit.db.update(schema.connectedAccount).set({ currencyCode: "EUR", timeZone: null }).where(eq(schema.connectedAccount.id, kit.accountId));
    const env = await kit.run("list_campaigns", {});
    expect(env.meta.account).toEqual({ id: kit.accountId, currency_code: "EUR", time_zone: "Asia/Tokyo" });
    expect(await account(kit.accountId)).toMatchObject({ currencyCode: "EUR", timeZone: "Asia/Tokyo" });
  });

  it("a platform that reports nothing leaves units null and the row unchanged", async () => {
    await clearUnits(kit.accountId);
    units = {};
    const env = await kit.run("list_campaigns", {});
    expect(env.meta.account).toEqual({ id: kit.accountId, currency_code: null, time_zone: null });
  });

  it("the backfill update is tenant-scoped: another tenant's account with the same external id is untouched", async () => {
    const other = await seedTenant(kit.db, "RU2", "owner");
    const theirs = await seedAccount(kit.db, other.tenant.id, "google_ads", "read", "active", "1234567890", null);
    await clearUnits(kit.accountId);
    await kit.run("list_campaigns", {});
    expect(await account(kit.accountId)).toMatchObject({ currencyCode: "JPY", timeZone: "Asia/Tokyo" });
    expect(await account(theirs.id)).toMatchObject({ currencyCode: null, timeZone: null });
  });
});
