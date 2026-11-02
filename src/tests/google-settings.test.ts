import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GoogleTokenProvider } from "../auth/token-providers";
import { type Db } from "../db";
import { loadInventory } from "../inventory";
import { createExecutor, runTool, type PipelineDeps } from "../mcp/pipeline";
import { ToolRegistry } from "../mcp/registry";
import { googleTools } from "../platforms/google";
import { GoogleAdsHttp } from "../platforms/google/http";
import { createServicesFactory } from "../platforms/google/services";
import { ApprovalService } from "../security/approvals";
import { RateLimiter } from "../security/rate-limit";
import { addUser, seedAccount, seedTenant, testDb } from "./helpers";

const C = "customers/1234567890";
type Camp = { name: string; status: string; start: string; end?: string; budget: string; shared?: boolean };
let camps: Record<string, Camp>;
let budgets: Record<string, string>;
let groups: Record<string, { name: string; cpc?: string; cpa?: string; status: string }>;
let calls: { path: string; body: any }[];
let dropWrites = false;
const J = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const sent: string[] = [];

function applyUpdate(resourceName: string, update: any, mask: string) {
  const [, kind, id] = /\/(campaigns|campaignBudgets|adGroups)\/(\d+)/.exec(resourceName)!;
  const fields = mask.split(",");
  if (dropWrites) return;
  if (kind === "campaigns") {
    const c = camps[id!]!;
    if (fields.includes("name")) c.name = update.name;
    if (fields.includes("start_date_time")) c.start = update.startDateTime;
    if (fields.includes("end_date_time")) c.end = update.endDateTime; // absent in body => cleared
  } else if (kind === "campaignBudgets") budgets[id!] = update.amountMicros;
  else {
    const g = groups[id!]!;
    if (fields.includes("name")) g.name = update.name;
    if (fields.includes("cpc_bid_micros")) g.cpc = update.cpcBidMicros;
    if (fields.includes("target_cpa_micros")) g.cpa = update.targetCpaMicros;
  }
}

const http = new GoogleAdsHttp({
  apiVersion: "v99",
  sleep: async () => {},
  fetch: async (url, init) => {
    const path = url.replace("https://googleads.googleapis.com/v99/", "");
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path.endsWith("googleAds:search")) {
      const q: string = body.query;
      sent.push(q);
      const id = (q.includes("FROM ad_group") ? /ad_group\.id = (\d+)/ : /campaign\.id = (\d+)/).exec(q)?.[1];
      if (q.includes("FROM campaign") && id) {
        const c = camps[id];
        return J(c ? { results: [{ campaign: { id, name: c.name, status: c.status, resourceName: `${C}/campaigns/${id}`, startDateTime: c.start, ...(c.end ? { endDateTime: c.end } : {}), campaignBudget: `${C}/campaignBudgets/${id}` }, campaignBudget: { amountMicros: budgets[id], explicitlyShared: !!c.shared, resourceName: `${C}/campaignBudgets/${id}` } }] } : {});
      }
      if (q.includes("FROM campaign")) return J({ results: Object.entries(camps).map(([i, c]) => ({ campaign: { id: i, name: c.name, status: c.status, startDateTime: c.start, ...(c.end ? { endDateTime: c.end } : {}) } })) });
      if (q.includes("FROM ad_group") && id) {
        const g = groups[id];
        return J(g ? { results: [{ adGroup: { id, name: g.name, status: g.status, resourceName: `${C}/adGroups/${id}`, ...(g.cpc ? { cpcBidMicros: g.cpc } : {}), ...(g.cpa ? { targetCpaMicros: g.cpa } : {}) } }] } : {});
      }
      if (q.includes("FROM ad_group")) return J({ results: Object.entries(groups).map(([i, g]) => ({ adGroup: { id: i, name: g.name, status: g.status, type: "SEARCH_STANDARD", cpcBidMicros: g.cpc }, campaign: { id: "11" } })) });
    }
    calls.push({ path, body });
    if (path.endsWith("googleAds:mutate")) for (const op of body.mutateOperations) { const o = op.campaignOperation ?? op.campaignBudgetOperation; applyUpdate(o.update.resourceName, o.update, o.updateMask); }
    else for (const op of body.operations) applyUpdate(op.update.resourceName, op.update, op.updateMask);
    return J({ results: [{}], mutateOperationResponses: [{}] });
  },
});

let db: Db, tenantId: string, owner: string, second: string, accountId: string, d: PipelineDeps, approvals: ApprovalService;
beforeAll(async () => {
  db = await testDb();
  const t = await seedTenant(db, "ST", "owner");
  tenantId = t.tenant.id;
  owner = t.user.id;
  second = (await addUser(db, tenantId, "adm", "admin")).id;
  accountId = (await seedAccount(db, tenantId, "google_ads")).id;
  approvals = new ApprovalService(db);
  d = { db, registry: new ToolRegistry(loadInventory()).registerAll(googleTools), approvals, tenantLimiter: new RateLimiter(10_000, 10_000), accountLimiter: new RateLimiter(10_000, 10_000), createServices: createServicesFactory({ db, google: { tokens: { getAccessToken: async () => "tok" } as unknown as GoogleTokenProvider, http } }) };
});
let n = 0;
beforeEach(() => {
  n++;
  camps = { "11": { name: "Brand", status: "ENABLED", start: "2026-01-01 00:00:00", budget: "50000000" }, "12": { name: "Shared", status: "ENABLED", start: "2026-01-01 00:00:00", budget: "10000000", shared: true }, "13": { name: "Gone", status: "REMOVED", start: "2026-01-01 00:00:00", budget: "1" } };
  budgets = { "11": "50000000", "12": "10000000", "13": "1" };
  groups = { "21": { name: "Core", cpc: "1500000", status: "ENABLED" }, "22": { name: "Removed", status: "REMOVED" } };
  calls = [];
  dropWrites = false;
  sent.length = 0;
});

const asOwner = { tenantId: "", userId: "", role: "owner" as const, scopes: ["ads:read", "ads:write"] };
const run = (name: string, args: Record<string, unknown>) => runTool(d, d.registry.get(name)!, { account_id: accountId, ...args }, { ...asOwner, tenantId, userId: owner });
const approve = (id: string, by = second) => approvals.decide({ tenantId, approvalId: id, decider: { userId: by, role: by === owner ? "owner" : "admin" }, decision: "approve", execute: createExecutor(d) });
// Each test uses a distinct value so identical requests are not deduplicated onto an earlier approval.
const day = () => `2027-02-${String(10 + n).padStart(2, "0")}`;

describe("campaign dates", () => {
  it("queries the date-time fields (start_date/end_date do not exist in the current API)", async () => {
    const r = await run("get_campaign_dates", {});
    expect(r.ok).toBe(true);
    expect(sent.at(-1)).toContain("campaign.start_date_time, campaign.end_date_time");
    expect(sent.at(-1)).not.toMatch(/campaign\.(start|end)_date[^_]/);
    expect((r.data as any).campaigns[0]).toMatchObject({ campaign_id: "11", start_date_time: "2026-01-01 00:00:00", end_date_time: null });
  });

  it("sets an end date after approval and reads it back", async () => {
    const r = await run("update_campaign_dates", { campaign_id: "11", end_date: day() });
    expect(r.approval?.risk).toBe("high_impact");
    expect(calls).toHaveLength(0);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls[0]!.body.operations[0]).toEqual({ update: { resourceName: `${C}/campaigns/11`, endDateTime: `${day()} 23:59:59` }, updateMask: "end_date_time" });
    expect(camps["11"]!.end).toBe(`${day()} 23:59:59`);
  });

  it("clears the end date by masking it without a value", async () => {
    camps["11"]!.end = "2027-01-01 23:59:59";
    const r = await run("update_campaign_dates", { campaign_id: "11", clear_end_date: true });
    await approve(r.approval!.approval_id);
    expect(calls[0]!.body.operations[0]).toEqual({ update: { resourceName: `${C}/campaigns/11` }, updateMask: "end_date_time" });
    expect(camps["11"]!.end).toBeUndefined();
  });

  it("rejects bad input and no-ops at request time", async () => {
    for (const a of [{}, { start_date: "2027-5-1" }, { start_date: "2027-03-01", end_date: "2027-02-01" }, { end_date: "2027-02-30" }, { end_date: day(), clear_end_date: true }]) expect((await run("update_campaign_dates", { campaign_id: "11", ...a })).error?.code).toBe("invalid_argument");
    expect((await run("update_campaign_dates", { campaign_id: "11", start_date: "2026-01-01" })).error?.message).toContain("already");
    expect((await run("update_campaign_dates", { campaign_id: "13", end_date: day() })).error?.message).toContain("removed");
    expect(calls).toHaveLength(0);
  });

  it("does not claim success if the dates do not read back", async () => {
    const r = await run("update_campaign_dates", { campaign_id: "11", end_date: day() });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});

describe("update_campaign", () => {
  it("renames and changes the budget in one atomic request", async () => {
    const r = await run("update_campaign", { campaign_id: "11", name: `Brand ${n}`, daily_budget: 60 + n });
    expect(r.approval?.summary).toContain("daily budget 50 ->");
    expect(calls).toHaveLength(0);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("customers/1234567890/googleAds:mutate");
    expect(calls[0]!.body.mutateOperations).toEqual([
      { campaignOperation: { update: { resourceName: `${C}/campaigns/11`, name: `Brand ${n}` }, updateMask: "name" } },
      { campaignBudgetOperation: { update: { resourceName: `${C}/campaignBudgets/11`, amountMicros: String((60 + n) * 1e6) }, updateMask: "amount_micros" } },
    ]);
    expect(done.result).toMatchObject({ name: `Brand ${n}`, daily_budget: 60 + n });
  });

  it("refuses a shared budget, a no-op, and bad input", async () => {
    expect((await run("update_campaign", { campaign_id: "12", daily_budget: 99 })).error?.message).toContain("shared");
    expect((await run("update_campaign", { campaign_id: "11", daily_budget: 50 })).error?.message).toContain("Nothing");
    for (const a of [{}, { daily_budget: -1 }, { daily_budget: 0 }, { name: "a\nb" }, { name: "" }]) expect((await run("update_campaign", { campaign_id: "11", ...a })).error?.code).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });

  it("needs a second approver and refuses on drift", async () => {
    const r = await run("update_campaign", { campaign_id: "11", daily_budget: 70 + n });
    await expect(approve(r.approval!.approval_id, owner)).rejects.toMatchObject({ code: "permission_denied" });
    budgets["11"] = "1000000";
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({ error: { code: "conflict" } });
    expect(calls).toHaveLength(0);
  });
});

describe("ad group settings", () => {
  it("reads settings", async () => {
    const r = await run("get_ad_group_settings", { campaign_id: "11" });
    expect((r.data as any).ad_groups[0]).toMatchObject({ ad_group_id: "21", cpc_bid: 1.5, status: "ENABLED", type: "SEARCH_STANDARD" });
    expect((await run("get_ad_group_settings", { ad_group_ids: ["1 OR 1=1"] })).error?.code).toBe("invalid_argument");
  });

  it("updates name, CPC bid and target CPA after approval (single approver is enough)", async () => {
    const r = await run("update_ad_group_settings", { ad_group_id: "21", name: `Core ${n}`, cpc_bid: 2 + n, target_cpa: 12 });
    expect(r.approval?.risk).toBe("write");
    const done = await approve(r.approval!.approval_id, owner);
    expect(done.status).toBe("executed");
    expect(calls[0]!.path).toBe("customers/1234567890/adGroups:mutate");
    expect(calls[0]!.body.operations[0]).toEqual({ update: { resourceName: `${C}/adGroups/21`, name: `Core ${n}`, cpcBidMicros: String((2 + n) * 1e6), targetCpaMicros: "12000000" }, updateMask: "name,cpc_bid_micros,target_cpa_micros" });
    expect(done.result).toMatchObject({ cpc_bid: 2 + n, target_cpa: 12 });
  });

  it("rejects empty, removed, unknown and no-op requests, and unconfirmed writes", async () => {
    expect((await run("update_ad_group_settings", { ad_group_id: "21" })).error?.code).toBe("invalid_argument");
    expect((await run("update_ad_group_settings", { ad_group_id: "22", cpc_bid: 1 })).error?.message).toContain("removed");
    expect((await run("update_ad_group_settings", { ad_group_id: "99", cpc_bid: 1 })).error?.code).toBe("not_found");
    expect((await run("update_ad_group_settings", { ad_group_id: "21", cpc_bid: 1.5 })).error?.message).toContain("Nothing");
    const r = await run("update_ad_group_settings", { ad_group_id: "21", cpc_bid: 9 + n });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id, owner)).status).toBe("unknown_outcome");
  });
});
