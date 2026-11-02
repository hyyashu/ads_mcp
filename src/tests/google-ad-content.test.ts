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
type A = { text: string; pinnedField?: string };
interface Ad { ag: string; id: string; status: string; type: string; headlines: A[]; descriptions: A[]; finalUrls: string[]; path1?: string; path2?: string }
let ads: Ad[];
let adGroups: Record<string, string>;
let campaigns: Record<string, string>;
let nextId: number;
let calls: { path: string; body: any }[];
let dropWrites = false;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const idIn = (q: string, f: string) => new RegExp(`${f} = (\\d+)`).exec(q)?.[1];
const h = (...t: string[]): A[] => t.map((text) => ({ text }));
const baseHeads = h("Buy running shoes", "Free shipping", "Official store");
const baseDescs = h("Shop our range today.", "Fast delivery on all orders.");

// Stand-in for Google's own validation (the real limits are NOT asserted anywhere in this repo): it lets the tests prove that
// the validate_only result is surfaced at request time and that nothing is changed by it.
function googleSays(ops: any[]): Response | null {
  for (const op of ops) {
    const rsa = op.create?.ad?.responsiveSearchAd ?? op.update?.responsiveSearchAd;
    for (const x of rsa?.headlines ?? []) if (x.text.length > 30) return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument.", details: [{ errors: [{ errorCode: { adError: "TOO_LONG" }, message: `Too long: "${x.text.slice(0, 20)}…" exceeds the headline limit` }] }] } }, 400);
  }
  return null;
}

const http = new GoogleAdsHttp({
  apiVersion: "v99",
  sleep: async () => {},
  fetch: async (url, init) => {
    const path = url.replace("https://googleads.googleapis.com/v99/", "");
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path.endsWith("googleAds:search")) {
      const q: string = body.query;
      const from = /FROM (\w+)/.exec(q)![1]!;
      if (from === "ad_group") { const s = adGroups[idIn(q, "ad_group.id")!]; return J(s ? { results: [{ adGroup: { id: idIn(q, "ad_group.id"), status: s } }] } : {}); }
      if (from === "campaign") { const s = campaigns[idIn(q, "campaign.id")!]; return J(s ? { results: [{ campaign: { id: idIn(q, "campaign.id"), status: s } }] } : {}); }
      if (from === "ad_group_ad") {
        const ag = idIn(q, "ad_group.id"), ad = idIn(q, "ad_group_ad.ad.id");
        const rows = ads.filter((a) => (!ag || a.ag === ag) && (!ad || a.id === ad) && (!q.includes("status != 'REMOVED'") || a.status !== "REMOVED") && (!q.includes("ad.type = 'RESPONSIVE_SEARCH_AD'") || a.type === "RESPONSIVE_SEARCH_AD"));
        return J({ results: rows.map((a) => ({ adGroup: { id: a.ag }, adGroupAd: { status: a.status, ad: { id: a.id, type: a.type, resourceName: `${C}/ads/${a.id}`, finalUrls: a.finalUrls, responsiveSearchAd: { headlines: a.headlines, descriptions: a.descriptions, ...(a.path1 ? { path1: a.path1 } : {}), ...(a.path2 ? { path2: a.path2 } : {}) } } } })) });
      }
    }
    calls.push({ path, body });
    const bad = googleSays(body.operations);
    if (bad) return bad;
    if (body.validateOnly || dropWrites) return J({ results: body.operations.map(() => ({})) });
    for (const op of body.operations) {
      if (op.create) ads.push({ ag: op.create.adGroup.split("/").pop(), id: String(nextId++), status: op.create.status, type: "RESPONSIVE_SEARCH_AD", headlines: op.create.ad.responsiveSearchAd.headlines, descriptions: op.create.ad.responsiveSearchAd.descriptions, finalUrls: op.create.ad.finalUrls, path1: op.create.ad.responsiveSearchAd.path1, path2: op.create.ad.responsiveSearchAd.path2 });
      else {
        const a = ads.find((x) => x.id === op.update.resourceName.split("/").pop())!;
        for (const f of op.updateMask.split(",")) {
          if (f === "responsive_search_ad.headlines") a.headlines = op.update.responsiveSearchAd.headlines;
          if (f === "responsive_search_ad.descriptions") a.descriptions = op.update.responsiveSearchAd.descriptions;
          if (f === "responsive_search_ad.path1") a.path1 = op.update.responsiveSearchAd?.path1;
          if (f === "responsive_search_ad.path2") a.path2 = op.update.responsiveSearchAd?.path2;
          if (f === "final_urls") a.finalUrls = op.update.finalUrls;
        }
      }
    }
    return J({ results: body.operations.map(() => ({})) });
  },
});

let db: Db, tenantId: string, owner: string, accountId: string, d: PipelineDeps, approvals: ApprovalService;
beforeAll(async () => {
  db = await testDb();
  const t = await seedTenant(db, "AC", "owner");
  tenantId = t.tenant.id;
  owner = t.user.id;
  await addUser(db, tenantId, "adm", "admin");
  accountId = (await seedAccount(db, tenantId, "google_ads")).id;
  approvals = new ApprovalService(db);
  d = { db, registry: new ToolRegistry(loadInventory()).registerAll(googleTools), approvals, tenantLimiter: new RateLimiter(10_000, 10_000), accountLimiter: new RateLimiter(10_000, 10_000), createServices: createServicesFactory({ db, google: { tokens: { getAccessToken: async () => "tok" } as unknown as GoogleTokenProvider, http } }) };
});

let n = 0;
beforeEach(() => {
  n++;
  nextId = 7000;
  adGroups = { "21": "ENABLED", "22": "REMOVED" };
  campaigns = { "11": "ENABLED" };
  ads = [
    { ag: "21", id: "301", status: "ENABLED", type: "RESPONSIVE_SEARCH_AD", headlines: [...baseHeads], descriptions: [...baseDescs], finalUrls: ["https://example.com/shoes"], path1: "shoes" },
    { ag: "21", id: "302", status: "PAUSED", type: "RESPONSIVE_SEARCH_AD", headlines: [...baseHeads], descriptions: [...baseDescs], finalUrls: ["https://example.com"] },
    { ag: "21", id: "303", status: "ENABLED", type: "EXPANDED_TEXT_AD", headlines: [], descriptions: [], finalUrls: ["https://example.com"] },
    { ag: "21", id: "304", status: "REMOVED", type: "RESPONSIVE_SEARCH_AD", headlines: [...baseHeads], descriptions: [...baseDescs], finalUrls: ["https://example.com"] },
  ];
  calls = [];
  dropWrites = false;
});

const run = (name: string, args: Record<string, unknown>) => runTool(d, d.registry.get(name)!, { account_id: accountId, ...args }, { tenantId, userId: owner, role: "owner", scopes: ["ads:read", "ads:write"] });
const approve = (aid: string) => approvals.decide({ tenantId, approvalId: aid, decider: { userId: owner, role: "owner" }, decision: "approve", execute: createExecutor(d) });
const u = (s: string) => `${s} ${n}`;
const heads = (...t: string[]) => t.map((text) => ({ text }));

describe("registration", () => {
  it("registers the four tools as write tools", () => {
    for (const name of ["create_ad", "update_ad_headlines", "update_ad_descriptions", "update_ad_content"]) { const t = d.registry.get(name)!; expect(t.kind === "write" && t.risk).toBe("write"); }
  });
});

describe("update_ad_headlines", () => {
  it("validates with Google at request time (changing nothing), then applies after approval and reads back", async () => {
    const want = [{ text: u("Run faster"), pinned_field: "HEADLINE_1" }, { text: "Free shipping" }, { text: "Official store" }];
    const r = await run("update_ad_headlines", { ad_group_id: "21", ad_id: "301", headlines: want });
    expect(r.approval?.status).toBe("pending_approval");
    expect(r.approval?.summary).toContain(`adding "${u("Run faster")}"`);
    expect(r.approval?.summary).toContain('removing "Buy running shoes"');
    expect(r.approval?.summary).toContain("live");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("customers/1234567890/ads:mutate");
    expect(calls[0]!.body.validateOnly).toBe(true);
    expect(ads[0]!.headlines.map((x) => x.text)).toContain("Buy running shoes"); // untouched
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    const real = calls.at(-1)!;
    expect(real.body.validateOnly).toBeUndefined();
    expect(real.body.operations[0]).toEqual({ update: { resourceName: `${C}/ads/301`, responsiveSearchAd: { headlines: [{ text: u("Run faster"), pinnedField: "HEADLINE_1" }, { text: "Free shipping" }, { text: "Official store" }] } }, updateMask: "responsive_search_ad.headlines" });
    expect((done.result as any).headlines[0]).toEqual({ text: u("Run faster"), pinned_field: "HEADLINE_1" });
  });

  it("surfaces Google's validation error at request time and queues nothing", async () => {
    const r = await run("update_ad_headlines", { ad_group_id: "21", ad_id: "301", headlines: heads("x".repeat(31), "b", "c") });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid_argument");
    expect(r.error?.message).toContain("Too long");
    expect(r.approval).toBeUndefined();
    expect(calls.every((c) => c.body.validateOnly === true)).toBe(true);
  });

  it("enforces the documented counts and pinning positions locally", async () => {
    const t = (a: number) => heads(...Array.from({ length: a }, (_, i) => `h${i}${n}`));
    for (const headlines of [t(2), t(16), [...t(2), { text: "x", pinned_field: "HEADLINE_4" }], [...t(2), { text: "" }], [...t(2), { text: "a\nb" }], [...t(2), { text: "x", pinned_field: "DESCRIPTION_1" }]]) {
      expect((await run("update_ad_headlines", { ad_group_id: "21", ad_id: "301", headlines })).error?.code).toBe("invalid_argument");
    }
    expect((await run("update_ad_headlines", { ad_group_id: "21", ad_id: "abc", headlines: t(3) })).error?.code).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });

  it("refuses a no-op, and does not warn that a paused ad is live", async () => {
    expect((await run("update_ad_headlines", { ad_group_id: "21", ad_id: "301", headlines: heads("Buy running shoes", "Free shipping", "Official store") })).error?.message).toContain("Nothing would change");
    const r = await run("update_ad_headlines", { ad_group_id: "21", ad_id: "302", headlines: heads(u("A"), u("B"), u("C")) });
    expect(r.approval?.summary).not.toContain("live");
  });

  it("refuses unsupported, removed and unknown ads", async () => {
    const hl = heads(u("A"), u("B"), u("C"));
    expect((await run("update_ad_headlines", { ad_group_id: "21", ad_id: "303", headlines: hl })).error?.code).toBe("unsupported");
    expect((await run("update_ad_headlines", { ad_group_id: "21", ad_id: "304", headlines: hl })).error?.message).toContain("removed");
    expect((await run("update_ad_headlines", { ad_group_id: "21", ad_id: "999", headlines: hl })).error?.code).toBe("not_found");
    expect((await run("update_ad_headlines", { ad_group_id: "99", ad_id: "301", headlines: hl })).error?.code).toBe("not_found");
  });

  it("fails safely when the ad changed after the request", async () => {
    const r = await run("update_ad_headlines", { ad_group_id: "21", ad_id: "302", headlines: heads(u("D1"), u("D2"), u("D3")) });
    ads.find((a) => a.id === "302")!.headlines = h("Someone", "Else", "Edited");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({ error: { code: "conflict" } });
    expect(calls.filter((c) => !c.body.validateOnly)).toHaveLength(0);
  });

  it("does not claim success when the content does not read back", async () => {
    const r = await run("update_ad_headlines", { ad_group_id: "21", ad_id: "302", headlines: heads(u("E1"), u("E2"), u("E3")) });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});

describe("update_ad_descriptions and update_ad_content", () => {
  it("replaces descriptions with the right mask", async () => {
    const r = await run("update_ad_descriptions", { ad_group_id: "21", ad_id: "302", descriptions: [{ text: u("New copy one."), pinned_field: "DESCRIPTION_1" }, { text: u("New copy two.") }] });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls.at(-1)!.body.operations[0].updateMask).toBe("responsive_search_ad.descriptions");
    expect(calls.at(-1)!.body.operations[0].update.responsiveSearchAd.descriptions[0]).toEqual({ text: u("New copy one."), pinnedField: "DESCRIPTION_1" });
    for (const descriptions of [[{ text: "one" }], Array.from({ length: 5 }, (_, i) => ({ text: `d${i}` })), [{ text: "a", pinned_field: "DESCRIPTION_3" }, { text: "b" }]]) expect((await run("update_ad_descriptions", { ad_group_id: "21", ad_id: "302", descriptions })).error?.code).toBe("invalid_argument");
  });

  it("changes final URL and paths together, and clears paths with null", async () => {
    const r = await run("update_ad_content", { ad_group_id: "21", ad_id: "302", final_urls: [`https://example.com/sale-${n}`], path1: "sale", path2: "now" });
    expect((await approve(r.approval!.approval_id)).status).toBe("executed"); // multi-field snapshot survives the JSONB round trip
    expect(calls.at(-1)!.body.operations[0]).toEqual({ update: { resourceName: `${C}/ads/302`, responsiveSearchAd: { path1: "sale", path2: "now" }, finalUrls: [`https://example.com/sale-${n}`] }, updateMask: "responsive_search_ad.path1,responsive_search_ad.path2,final_urls" });
    const clear = await run("update_ad_content", { ad_group_id: "21", ad_id: "302", path1: null, path2: null });
    await approve(clear.approval!.approval_id);
    expect(calls.at(-1)!.body.operations[0]).toEqual({ update: { resourceName: `${C}/ads/302` }, updateMask: "responsive_search_ad.path1,responsive_search_ad.path2" });
    expect(ads.find((a) => a.id === "302")!.path1).toBeUndefined();
  });

  it("enforces path2-needs-path1 against the ad's resulting state, and requires something to change", async () => {
    expect((await run("update_ad_content", { ad_group_id: "21", ad_id: "302", path2: "x" })).error?.message).toContain("path1");
    expect((await run("update_ad_content", { ad_group_id: "21", ad_id: "301", path1: null, path2: "x" })).error?.message).toContain("path1");
    expect((await run("update_ad_content", { ad_group_id: "21", ad_id: "301", path2: "ok" })).ok).toBe(true); // 301 already has path1
    expect((await run("update_ad_content", { ad_group_id: "21", ad_id: "301" })).error?.code).toBe("invalid_argument");
    for (const final_urls of [["ftp://x.com"], ["not a url"], [], ["https://a.com", "https://b.com", "https://c.com", "https://d.com"]]) expect((await run("update_ad_content", { ad_group_id: "21", ad_id: "301", final_urls })).error?.code).toBe("invalid_argument");
  });
});

describe("create_ad", () => {
  const input = () => ({ ad_group_id: "21", final_urls: ["https://example.com/new"], headlines: heads(u("Trail shoes"), u("Free returns"), u("Shop now")), descriptions: heads(u("Built for the trail."), u("Order today.")), path1: "trail" });

  it("validates first, always creates PAUSED, and reads the new ad back", async () => {
    const r = await run("create_ad", input());
    expect(r.approval?.summary).toContain("PAUSED");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.validateOnly).toBe(true);
    expect(ads).toHaveLength(4);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls.at(-1)!.path).toBe("customers/1234567890/adGroupAds:mutate");
    expect(calls.at(-1)!.body.operations[0]).toEqual({ create: { adGroup: `${C}/adGroups/21`, status: "PAUSED", ad: { finalUrls: ["https://example.com/new"], responsiveSearchAd: { headlines: [{ text: u("Trail shoes") }, { text: u("Free returns") }, { text: u("Shop now") }], descriptions: [{ text: u("Built for the trail.") }, { text: u("Order today.") }], path1: "trail" } } } });
    expect(done.result).toEqual({ ad_group_id: "21", ad_id: "7000", status: "PAUSED", headline_count: 3, description_count: 2 });
    expect(ads.find((a) => a.id === "7000")!.status).toBe("PAUSED");
  });

  it("surfaces Google's validation error and queues nothing", async () => {
    const r = await run("create_ad", { ...input(), headlines: heads("y".repeat(40), u("b"), u("c")) });
    expect(r.error?.message).toContain("Too long");
    expect(r.approval).toBeUndefined();
    expect(ads).toHaveLength(4);
  });

  it("refuses an exact copy of an existing ad, a campaign id, a removed ad group and bad input", async () => {
    expect((await run("create_ad", { ...input(), headlines: h("Free shipping", "Buy running shoes", "Official store"), descriptions: baseDescs.map((x) => ({ text: x.text })) })).error?.message).toContain("already exists");
    const camp = await run("create_ad", { ...input(), ad_group_id: "11" });
    expect(camp.error?.message).toContain("campaign id");
    expect((await run("create_ad", { ...input(), ad_group_id: "22" })).error?.message).toContain("removed");
    expect((await run("create_ad", { ...input(), ad_group_id: "99" })).error?.code).toBe("not_found");
    expect((await run("create_ad", { ...input(), path1: undefined, path2: "x" })).error?.code).toBe("invalid_argument");
    expect((await run("create_ad", { ...input(), headlines: heads("a", "b") })).error?.code).toBe("invalid_argument");
    expect((await run("create_ad", { ...input(), final_urls: [] })).error?.code).toBe("invalid_argument");
  });

  it("does not claim success when the ad does not read back", async () => {
    const r = await run("create_ad", { ...input(), headlines: heads(u("Ghost 1"), u("Ghost 2"), u("Ghost 3")) });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});
