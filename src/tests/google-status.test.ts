import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../auth/token-providers";
import { type Db } from "../db";
import { googleHarness, type GoogleHarness } from "./support/harness";
import { runTool, type PipelineDeps } from "../mcp/pipeline";
import { seedTenant } from "./helpers";

/** A tiny stateful stand-in for the Google Ads API: statuses live in memory, mutate changes them. */
const state = { campaign: { "11": "ENABLED", "12": "PAUSED", "13": "REMOVED", "14": "ENABLED", "15": "ENABLED", "16": "ENABLED", "17": "ENABLED" } as Record<string, string>, ad_group: { "21": "ENABLED" } as Record<string, string> };
let mutateCalls: { path: string; body: any }[] = [];
let ignoreMutations = false;
let failReads = false;
let mutateFails = false;
const J = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const fake: FetchLike = async (url, init) => {
    const path = url.replace("https://googleads.googleapis.com/v99/", "");
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path.endsWith("googleAds:search")) {
      if (failReads) return J({ error: { code: 503, status: "UNAVAILABLE", message: "try later" } }, 503);
      const m = /FROM (campaign|ad_group) WHERE \w+\.id = (\d+)/.exec(body.query);
      const status = m && state[m[1] as "campaign"][m[2]!];
      return J(status ? { results: [{ [m![1]!.replace(/_(\w)/g, (_, c) => c.toUpperCase())]: { id: m![2], name: `N${m![2]}`, status, resourceName: `customers/1234567890/${m![1] === "campaign" ? "campaigns" : "adGroups"}/${m![2]}` } }] } : {});
    }
    mutateCalls.push({ path, body });
    if (mutateFails) return J({ error: { code: 500, status: "INTERNAL", message: "boom" } }, 500);
    const op = body.operations[0];
    const [, kind, id] = /customers\/\d+\/(campaigns|adGroups)\/(\d+)/.exec(op.update.resourceName)!;
    if (!ignoreMutations) state[kind === "campaigns" ? "campaign" : "ad_group"][id!] = op.update.status;
    return J({ results: [{ resourceName: op.update.resourceName }] });
};

let kit: GoogleHarness;
let db: Db, tenantId: string, owner: string, second: string, accountId: string, d: PipelineDeps;
beforeAll(async () => {
  kit = await googleHarness("ST", fake);
  ({ db, tenantId, owner, second, accountId } = kit);
  d = kit.deps;
});
beforeEach(() => {
  state.campaign = { "11": "ENABLED", "12": "PAUSED", "13": "REMOVED", "14": "ENABLED", "15": "ENABLED", "16": "ENABLED", "17": "ENABLED" };
  state.ad_group = { "21": "ENABLED" };
  mutateCalls = [];
  ignoreMutations = false;
  failReads = false;
  mutateFails = false;
});

const request = (name: string, args: Record<string, unknown>) => runTool(d, d.registry.get(name)!, { account_id: accountId, ...args }, { tenantId, userId: owner, role: "owner", scopes: ["ads:read", "ads:write"] });
const approve = (id: string, by = owner) => kit.approveAs(id, by);

describe("pause/resume campaign and ad group", () => {
  it("registers all four tools with the inventory's risk tiers", () => {
    for (const [n, risk] of [["pause_campaign", "write"], ["resume_campaign", "high_impact"], ["pause_ad_group", "write"], ["resume_ad_group", "high_impact"]] as const) {
      const t = d.registry.get(n)!;
      expect(t.kind === "write" && t.risk).toBe(risk);
    }
  });

  it("requesting a pause changes nothing and queues an approval", async () => {
    const r = await request("pause_campaign", { campaign_id: "11" });
    expect(r.ok).toBe(true);
    expect(r.approval?.status).toBe("pending_approval");
    expect(r.approval?.summary).toContain("ENABLED -> PAUSED");
    expect(mutateCalls).toHaveLength(0);
    expect(state.campaign["11"]).toBe("ENABLED");
  });

  it("applies the pause after approval and confirms it by re-reading", async () => {
    const r = await request("pause_campaign", { campaign_id: "11" });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(done.result).toEqual({ campaign_id: "11", status: "PAUSED", previous_status: "ENABLED" });
    expect(mutateCalls).toHaveLength(1);
    expect(mutateCalls[0]!.path).toBe("customers/1234567890/campaigns:mutate");
    expect(mutateCalls[0]!.body.operations[0]).toEqual({ update: { resourceName: "customers/1234567890/campaigns/11", status: "PAUSED" }, updateMask: "status" });
  });

  it("pauses an ad group through the adGroups service", async () => {
    const r = await request("pause_ad_group", { ad_group_id: "21" });
    await approve(r.approval!.approval_id);
    expect(mutateCalls[0]!.path).toBe("customers/1234567890/adGroups:mutate");
    expect(state.ad_group["21"]).toBe("PAUSED");
  });

  it("resume needs a second approver", async () => {
    const r = await request("resume_campaign", { campaign_id: "12" });
    expect(r.approval?.risk).toBe("high_impact");
    await expect(approve(r.approval!.approval_id, owner)).rejects.toMatchObject({ code: "permission_denied" });
    expect(state.campaign["12"]).toBe("PAUSED");
    const done = await approve(r.approval!.approval_id, second);
    expect(done.status).toBe("executed");
    expect(state.campaign["12"]).toBe("ENABLED");
  });

  it("refuses no-op, removed and unknown targets at request time", async () => {
    expect((await request("pause_campaign", { campaign_id: "12" })).error?.code).toBe("invalid_argument");
    expect((await request("pause_campaign", { campaign_id: "13" })).error?.message).toContain("removed");
    expect((await request("pause_campaign", { campaign_id: "99" })).error?.code).toBe("not_found");
    expect((await request("pause_campaign", { campaign_id: "1; DROP" })).error?.code).toBe("invalid_argument");
  });

  it("refuses to apply when the campaign changed after the request (drift)", async () => {
    const r = await request("pause_campaign", { campaign_id: "15" });
    expect(r.approval?.status).toBe("pending_approval");
    state.campaign["15"] = "PAUSED";
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({ error: { message: expect.stringContaining("already paused") } });
    expect(mutateCalls).toHaveLength(0);
  });

  it("does not report success when Google does not confirm the new status", async () => {
    const r = await request("pause_campaign", { campaign_id: "14" });
    ignoreMutations = true;
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("unknown_outcome");
    expect(done.status).not.toBe("executed");
    expect(mutateCalls).toHaveLength(1); // sent once, never retried automatically
  });

  it("rejects a read-only token and another tenant's account", async () => {
    const ro = await runTool(d, d.registry.get("pause_campaign")!, { account_id: accountId, campaign_id: "11" }, { tenantId, userId: owner, role: "owner", scopes: ["ads:read"] });
    expect(ro.error?.code).toBe("permission_denied");
    const other = await seedTenant(db, "S2", "owner");
    const foreign = await runTool(d, d.registry.get("pause_campaign")!, { account_id: accountId, campaign_id: "11" }, { tenantId: other.tenant.id, userId: other.user.id, role: "owner", scopes: ["ads:write"] });
    expect(foreign.ok).toBe(false);
    expect(mutateCalls).toHaveLength(0);
  });
});

describe("failures before and after a change is sent", () => {
  it("a transient error while re-checking at approval time is a clean failure, and the change can be requested again", async () => {
    const r = await request("pause_campaign", { campaign_id: "16" });
    failReads = true; // Google is briefly unavailable when the approver clicks approve
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({ error: { code: "transient" } });
    expect(mutateCalls).toHaveLength(0); // nothing reached Google
    failReads = false;
    const again = await request("pause_campaign", { campaign_id: "16" });
    expect(again.approval?.status).toBe("pending_approval"); // not blocked by an unknown outcome
    expect((await approve(again.approval!.approval_id)).status).toBe("executed");
    expect(state.campaign["16"]).toBe("PAUSED");
  });

  it("a server error AFTER the change was sent stays an unknown outcome, and a blind retry is blocked", async () => {
    const r = await request("pause_campaign", { campaign_id: "17" });
    mutateFails = true;
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("unknown_outcome");
    expect(mutateCalls).toHaveLength(1); // sent exactly once, never retried automatically
    mutateFails = false;
    const retry = await request("pause_campaign", { campaign_id: "17" });
    expect(retry.ok).toBe(false);
    expect(retry.error?.code).toBe("conflict");
    expect(retry.error?.message).toContain("unconfirmed");
  });
});
