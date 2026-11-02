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
interface Crit { id: string; level: "ad_group" | "campaign"; parent: string; negative: boolean; text: string; match: string; status: string; cpc?: string }
let crits: Crit[];
let nextId: number;
let adGroups: Record<string, string>;
let campaigns: Record<string, string>;
let termRows: unknown[];
let calls: { path: string; body: any }[];
let queries: string[];
let dropWrites = false;
const J = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

const http = new GoogleAdsHttp({
  apiVersion: "v99",
  sleep: async () => {},
  fetch: async (url, init) => {
    const path = url.replace("https://googleads.googleapis.com/v99/", "");
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path.endsWith("googleAds:search")) {
      const q: string = body.query;
      queries.push(q);
      const from = /FROM (\w+)/.exec(q)![1]!;
      const idOf = (f: string) => new RegExp(`${f}\\.id = (\\d+)`).exec(q)?.[1];
      if (from === "ad_group_criterion" || from === "campaign_criterion") {
        const level = from === "ad_group_criterion" ? "ad_group" : "campaign";
        const parent = idOf(level)!;
        const neg = /negative = TRUE/.test(q);
        const rows = crits.filter((c) => c.level === level && c.parent === parent && c.negative === neg && c.status !== "REMOVED");
        const key = level === "ad_group" ? "adGroupCriterion" : "campaignCriterion";
        return J({ results: rows.map((c) => ({ [key]: { criterionId: c.id, keyword: { text: c.text, matchType: c.match }, status: c.status, ...(c.cpc ? { cpcBidMicros: c.cpc } : {}) } })) });
      }
      if (from === "ad_group") { const s = adGroups[idOf("ad_group")!]; return J(s ? { results: [{ adGroup: { id: idOf("ad_group"), status: s } }] } : {}); }
      if (from === "campaign") { const s = campaigns[idOf("campaign")!]; return J(s ? { results: [{ campaign: { id: idOf("campaign"), status: s } }] } : {}); }
      if (from === "search_term_view") return J({ results: termRows });
    }
    calls.push({ path, body });
    const level = path.includes("adGroupCriteria") ? "ad_group" : "campaign";
    for (const op of body.operations) {
      if (dropWrites) continue;
      if (op.create) {
        const parent = String(op.create.adGroup ?? op.create.campaign).split("/").pop()!;
        crits.push({ id: String(nextId++), level, parent, negative: !!op.create.negative, text: op.create.keyword.text, match: op.create.keyword.matchType, status: op.create.status ?? "ENABLED", cpc: op.create.cpcBidMicros });
      } else if (op.update) {
        const critId = op.update.resourceName.split("~")[1];
        const c = crits.find((x) => x.id === critId && x.level === level)!;
        for (const f of op.updateMask.split(",")) { if (f === "status") c.status = op.update.status; if (f === "cpc_bid_micros") c.cpc = op.update.cpcBidMicros; }
      } else if (op.remove) {
        const critId = op.remove.split("~")[1];
        crits.find((x) => x.id === critId && x.level === level)!.status = "REMOVED";
      }
    }
    return J({ results: body.operations.map(() => ({})) });
  },
});

let db: Db, tenantId: string, owner: string, second: string, accountId: string, d: PipelineDeps, approvals: ApprovalService;
beforeAll(async () => {
  db = await testDb();
  const t = await seedTenant(db, "KW", "owner");
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
  nextId = 1000;
  adGroups = { "21": "ENABLED", "22": "REMOVED" };
  campaigns = { "11": "ENABLED" };
  crits = [
    { id: "1", level: "ad_group", parent: "21", negative: false, text: "Running Shoes", match: "EXACT", status: "ENABLED", cpc: "1500000" },
    { id: "2", level: "ad_group", parent: "21", negative: false, text: "trail shoes", match: "PHRASE", status: "PAUSED" },
    { id: "3", level: "ad_group", parent: "21", negative: false, text: "sandals", match: "BROAD", status: "ENABLED" },
    { id: "50", level: "campaign", parent: "11", negative: true, text: "free", match: "BROAD", status: "ENABLED" },
    { id: "51", level: "ad_group", parent: "21", negative: true, text: "cheap", match: "PHRASE", status: "ENABLED" },
  ];
  termRows = [];
  calls = [];
  queries = [];
  dropWrites = false;
});

const run = (name: string, args: Record<string, unknown>) => runTool(d, d.registry.get(name)!, { account_id: accountId, ...args }, { tenantId, userId: owner, role: "owner", scopes: ["ads:read", "ads:write"] });
const approve = (aid: string, by = owner) => approvals.decide({ tenantId, approvalId: aid, decider: { userId: by, role: by === owner ? "owner" : "admin" }, decision: "approve", execute: createExecutor(d) });
const u = (s: string) => `${s} ${n}`; // unique per test so identical requests are not deduplicated

describe("registration and risk tiers", () => {
  it("registers the seven tools with the inventory's risk tiers", () => {
    const want: Record<string, string> = { add_keywords: "write", update_keyword: "write", remove_keywords: "destructive", bulk_update_keyword_status: "high_impact", add_negative_keywords: "write", remove_negative_keywords: "destructive" };
    for (const [name, risk] of Object.entries(want)) { const t = d.registry.get(name)!; expect(t.kind === "write" && t.risk).toBe(risk); }
    expect(d.registry.get("analyze_search_terms")!.kind).toBe("read");
  });
});

describe("add_keywords", () => {
  it("queues an approval without changing anything, then adds and reads back", async () => {
    const r = await run("add_keywords", { ad_group_id: "21", keywords: [{ text: u("hiking boots"), match_type: "PHRASE", cpc_bid: 2.5 }] });
    expect(r.approval?.status).toBe("pending_approval");
    expect(calls).toHaveLength(0);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls[0]!.path).toBe("customers/1234567890/adGroupCriteria:mutate");
    expect(calls[0]!.body.operations[0]).toEqual({ create: { adGroup: `${C}/adGroups/21`, negative: false, keyword: { text: u("hiking boots"), matchType: "PHRASE" }, status: "ENABLED", cpcBidMicros: "2500000" } });
    expect(calls[0]!.body.partialFailure).toBeUndefined(); // atomic
    expect((done.result as any).keywords[0]).toMatchObject({ criterion_id: "1000", text: u("hiking boots"), match_type: "PHRASE" });
  });

  it("skips existing keywords case-insensitively and repeats within the request", async () => {
    const r = await run("add_keywords", { ad_group_id: "21", keywords: [{ text: "running shoes", match_type: "EXACT" }, { text: u("socks"), match_type: "EXACT" }, { text: u("SOCKS"), match_type: "EXACT" }, { text: "running shoes", match_type: "BROAD" }] });
    expect(r.approval?.summary).toContain("Add 2");
    expect(r.approval?.summary).toContain("1 already exist");
    const done = await approve(r.approval!.approval_id);
    expect(done.result).toMatchObject({ added: 2, skipped_existing: 1 });
    expect(calls[0]!.body.operations).toHaveLength(2);
  });

  it("refuses when everything already exists", async () => {
    const r = await run("add_keywords", { ad_group_id: "21", keywords: [{ text: "SANDALS", match_type: "BROAD" }] });
    expect(r.error?.code).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });

  it("validates input", async () => {
    const bad: unknown[] = [
      [], [{ text: "", match_type: "EXACT" }], [{ text: "x".repeat(81), match_type: "EXACT" }], [{ text: "one two three four five six seven eight nine ten eleven", match_type: "EXACT" }],
      [{ text: "a\nb", match_type: "EXACT" }], [{ text: "ok", match_type: "EXACT_ISH" }], [{ text: "ok", match_type: "EXACT", cpc_bid: -1 }],
      Array.from({ length: 51 }, (_, i) => ({ text: `k${i}`, match_type: "EXACT" })),
    ];
    for (const keywords of bad) expect((await run("add_keywords", { ad_group_id: "21", keywords })).error?.code).toBe("invalid_argument");
    expect((await run("add_keywords", { ad_group_id: "21; DROP", keywords: [{ text: "ok", match_type: "EXACT" }] })).error?.code).toBe("invalid_argument");
  });

  it("explains when a campaign id is passed as an ad group id", async () => {
    const r = await run("add_keywords", { ad_group_id: "11", keywords: [{ text: u("x"), match_type: "EXACT" }] });
    expect(r.error?.code).toBe("invalid_argument");
    expect(r.error?.message).toContain("campaign id");
    expect(r.error?.message).toContain("get_campaign_structure");
  });

  it("rejects removed and unknown ad groups", async () => {
    expect((await run("add_keywords", { ad_group_id: "22", keywords: [{ text: u("x"), match_type: "EXACT" }] })).error?.message).toContain("removed");
    expect((await run("add_keywords", { ad_group_id: "99", keywords: [{ text: u("x"), match_type: "EXACT" }] })).error?.code).toBe("not_found");
  });

  it("does not claim success when keywords do not read back", async () => {
    const r = await run("add_keywords", { ad_group_id: "21", keywords: [{ text: u("ghost"), match_type: "EXACT" }] });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
  });

  it("fails safely when the ad group gained one of the keywords after the request", async () => {
    const r = await run("add_keywords", { ad_group_id: "21", keywords: [{ text: u("drift"), match_type: "EXACT" }] });
    crits.push({ id: "77", level: "ad_group", parent: "21", negative: false, text: u("drift"), match: "EXACT", status: "ENABLED" });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect(calls).toHaveLength(0);
  });
});

describe("update_keyword", () => {
  it("pauses and changes the bid with the right mask", async () => {
    const r = await run("update_keyword", { ad_group_id: "21", criterion_id: "1", status: "PAUSED", cpc_bid: 3 + n });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls[0]!.body.operations[0]).toEqual({ update: { resourceName: `${C}/adGroupCriteria/21~1`, status: "PAUSED", cpcBidMicros: String((3 + n) * 1e6) }, updateMask: "status,cpc_bid_micros" });
    expect(done.result).toMatchObject({ criterion_id: "1", text: "Running Shoes", status: "PAUSED", cpc_bid: 3 + n });
  });

  it("refuses no-ops, empty requests, unknown keywords and negatives", async () => {
    expect((await run("update_keyword", { ad_group_id: "21", criterion_id: "1", status: "ENABLED" })).error?.message).toContain("Nothing");
    expect((await run("update_keyword", { ad_group_id: "21", criterion_id: "1" })).error?.code).toBe("invalid_argument");
    expect((await run("update_keyword", { ad_group_id: "21", criterion_id: "999", status: "PAUSED" })).error?.code).toBe("not_found");
    expect((await run("update_keyword", { ad_group_id: "21", criterion_id: "51", status: "PAUSED" })).error?.code).toBe("not_found"); // a negative
    expect((await run("update_keyword", { ad_group_id: "21", criterion_id: "1", status: "REMOVED" })).error?.code).toBe("invalid_argument");
  });
});

describe("remove_keywords", () => {
  it("is destructive: needs a second approver, then removes by resource name and confirms", async () => {
    const r = await run("remove_keywords", { ad_group_id: "21", criterion_ids: ["2", "3"] });
    expect(r.approval?.risk).toBe("destructive");
    expect(r.approval?.summary).toContain("Permanently remove 2");
    await expect(approve(r.approval!.approval_id, owner)).rejects.toMatchObject({ code: "permission_denied" });
    expect(calls).toHaveLength(0);
    const done = await approve(r.approval!.approval_id, second);
    expect(done.status).toBe("executed");
    expect(calls[0]!.body.operations).toEqual([{ remove: `${C}/adGroupCriteria/21~2` }, { remove: `${C}/adGroupCriteria/21~3` }]);
    expect(done.result).toEqual({ removed: 2, criterion_ids: ["2", "3"] });
  });

  it("rejects ids that are not positive keywords in that ad group", async () => {
    const r = await run("remove_keywords", { ad_group_id: "21", criterion_ids: ["1", "51", "404"] });
    expect(r.error?.code).toBe("invalid_argument");
    expect(r.error?.message).toContain("51");
    expect(calls).toHaveLength(0);
    expect((await run("remove_keywords", { ad_group_id: "21", criterion_ids: [] })).error?.code).toBe("invalid_argument");
    expect((await run("remove_keywords", { ad_group_id: "21", criterion_ids: Array.from({ length: 51 }, (_, i) => String(i + 1)) })).error?.code).toBe("invalid_argument");
  });

  it("reports unknown_outcome when the keywords are still there afterwards", async () => {
    const r = await run("remove_keywords", { ad_group_id: "21", criterion_ids: ["3"] });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id, second)).status).toBe("unknown_outcome");
  });
});

describe("bulk_update_keyword_status", () => {
  it("changes only keywords not already in the target status, with a second approver", async () => {
    const r = await run("bulk_update_keyword_status", { ad_group_id: "21", criterion_ids: ["1", "2", "3"], status: "PAUSED" });
    expect(r.approval?.risk).toBe("high_impact");
    expect(r.approval?.summary).toContain("Set 2 keyword(s)");
    await expect(approve(r.approval!.approval_id, owner)).rejects.toMatchObject({ code: "permission_denied" });
    const done = await approve(r.approval!.approval_id, second);
    expect(done.status).toBe("executed");
    expect(calls[0]!.body.operations).toEqual([
      { update: { resourceName: `${C}/adGroupCriteria/21~1`, status: "PAUSED" }, updateMask: "status" },
      { update: { resourceName: `${C}/adGroupCriteria/21~3`, status: "PAUSED" }, updateMask: "status" },
    ]);
    expect(done.result).toEqual({ updated: 2, criterion_ids: ["1", "3"], status: "PAUSED" });
  });

  it("refuses when all are already in that status or an id is unknown", async () => {
    expect((await run("bulk_update_keyword_status", { ad_group_id: "21", criterion_ids: ["2"], status: "PAUSED" })).error?.message).toContain("already");
    expect((await run("bulk_update_keyword_status", { ad_group_id: "21", criterion_ids: ["2", "404"], status: "ENABLED" })).error?.code).toBe("invalid_argument");
  });
});

describe("negative keywords", () => {
  it("adds campaign-level negatives", async () => {
    const r = await run("add_negative_keywords", { campaign_id: "11", keywords: [{ text: u("jobs"), match_type: "BROAD" }, { text: "FREE", match_type: "BROAD" }] });
    expect(r.approval?.summary).toContain("Add 1");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls[0]!.path).toBe("customers/1234567890/campaignCriteria:mutate");
    expect(calls[0]!.body.operations[0]).toEqual({ create: { campaign: `${C}/campaigns/11`, negative: true, keyword: { text: u("jobs"), matchType: "BROAD" } } });
    expect(queries.some((q) => q.includes("FROM campaign_criterion") && q.includes("campaign_criterion.negative = TRUE"))).toBe(true);
  });

  it("adds ad-group-level negatives", async () => {
    const r = await run("add_negative_keywords", { ad_group_id: "21", keywords: [{ text: u("used"), match_type: "EXACT" }] });
    await approve(r.approval!.approval_id);
    expect(calls[0]!.path).toBe("customers/1234567890/adGroupCriteria:mutate");
    expect(calls[0]!.body.operations[0]).toEqual({ create: { adGroup: `${C}/adGroups/21`, negative: true, keyword: { text: u("used"), matchType: "EXACT" } } });
  });

  it("needs exactly one of campaign_id or ad_group_id", async () => {
    const kw = [{ text: u("x"), match_type: "EXACT" }];
    expect((await run("add_negative_keywords", { keywords: kw })).error?.code).toBe("invalid_argument");
    expect((await run("add_negative_keywords", { campaign_id: "11", ad_group_id: "21", keywords: kw })).error?.code).toBe("invalid_argument");
    expect((await run("remove_negative_keywords", { criterion_ids: ["50"] })).error?.code).toBe("invalid_argument");
  });

  it("removes negatives only (never positive keywords) and is destructive", async () => {
    const bad = await run("remove_negative_keywords", { campaign_id: "11", criterion_ids: ["1"] });
    expect(bad.error?.code).toBe("invalid_argument");
    const r = await run("remove_negative_keywords", { campaign_id: "11", criterion_ids: ["50"] });
    expect(r.approval?.risk).toBe("destructive");
    const done = await approve(r.approval!.approval_id, second);
    expect(done.status).toBe("executed");
    expect(calls[0]!.body.operations).toEqual([{ remove: `${C}/campaignCriteria/11~50` }]);
    expect(crits.find((c) => c.id === "1")!.status).toBe("ENABLED");
  });
});

describe("analyze_search_terms", () => {
  const row = (term: string, cost: string, conv: number, clicks = 10, extra: object = {}) => ({ searchTermView: { searchTerm: term, status: "NONE", ...extra }, campaign: { id: "11" }, adGroup: { id: "21" }, metrics: { impressions: "100", clicks: String(clicks), costMicros: cost, conversions: conv, conversionsValue: conv * 40 } });

  it("groups terms by fixed rules and never changes anything", async () => {
    termRows = [row("buy shoes", "30000000", 3), row("free shoes", "25000000", 0), row("shoe laces", "2000000", 0), row("shoe repair", "15000000", 0), row("good shoes", "9000000", 1)];
    const r = await run("analyze_search_terms", { min_cost: 10 });
    expect(r.ok).toBe(true);
    const x = r.data as any;
    expect(x.terms_analyzed).toBe(5);
    expect(x.summary.converting).toMatchObject({ terms: 2, cost: 39, conversions: 4 });
    expect(x.summary.wasted).toMatchObject({ terms: 2, cost: 40 });
    expect(x.summary.low_data).toMatchObject({ terms: 1, cost: 2 });
    expect(x.wasted.map((t: any) => t.search_term)).toEqual(["free shoes", "shoe repair"]);
    expect(x.converting[0]).toMatchObject({ search_term: "buy shoes", cost_per_conversion: 10, conversion_value: 120, ctr: 0.1 });
    expect(x.rules.wasted).toBe("conversions = 0 and cost >= 10");
    expect(x.covers_all_terms).toBe(true);
    expect(calls).toHaveLength(0);
    expect(queries[0]).toContain("FROM search_term_view");
    expect(queries[0]).toContain("ORDER BY metrics.cost_micros DESC LIMIT 1000");
  });

  it("filters by campaign or ad group, passes the targeting status through, and validates input", async () => {
    termRows = [row("excluded term", "50000000", 0, 5, { status: "EXCLUDED" })];
    const r = await run("analyze_search_terms", { campaign_id: "11", ad_group_id: "21" });
    expect(queries[0]).toContain("campaign.id = 11 AND ad_group.id = 21");
    expect((r.data as any).wasted[0].targeting_status).toBe("EXCLUDED");
    for (const a of [{ campaign_id: "1 OR 1=1" }, { min_cost: -1 }, { limit: 101 }, { start_date: "2026-01-01" }, { date_range: "NEVER" }]) expect((await run("analyze_search_terms", a)).error?.code).toBe("invalid_argument");
  });

  it("reports an empty period honestly", async () => {
    const r = await run("analyze_search_terms", {});
    expect((r.data as any).terms_analyzed).toBe(0);
    expect((r.data as any).summary.wasted.terms).toBe(0);
  });
});
