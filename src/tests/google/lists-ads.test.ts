import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";
import type { PipelineDeps } from "../../mcp/pipeline";

const C = "customers/1234567890";
interface Set { id: string; name: string; type: string; status: string }
interface Member { id: string; setId: string; text: string; match: string }
interface Link { campaign: string; setId: string }
interface Ad { ag: string; ad: string; status: string; approval: string }
let sets: Set[], members: Member[], links: Link[], campaigns: Record<string, { name: string; status: string }>, adRows: Ad[];
let nextId: number;
let calls: { path: string; body: any }[];
let queries: string[];
let dropWrites = false;
const J = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
const idIn = (q: string, f: string) => new RegExp(`${f} = (\\d+)`).exec(q)?.[1];
const listIn = (q: string, f: string) => (new RegExp(`${f} IN \\(([^)]*)\\)`).exec(q)?.[1] ?? "").split(",").map((x) => x.trim());

const fake: FetchLike = async (url, init) => {
    const path = url.replace("https://googleads.googleapis.com/v99/", "");
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (path.endsWith("googleAds:search")) {
      const q: string = body.query;
      queries.push(q);
      const from = /FROM (\w+)/.exec(q)![1]!;
      if (from === "shared_set") return J({ results: sets.filter((s) => s.type === "NEGATIVE_KEYWORDS" && s.status === "ENABLED").map((s) => ({ sharedSet: { id: s.id, name: s.name, memberCount: String(members.filter((m) => m.setId === s.id).length), referenceCount: String(links.filter((l) => l.setId === s.id).length) } })) });
      if (from === "shared_criterion") return J({ results: members.filter((m) => m.setId === idIn(q, "shared_set.id")).map((m) => ({ sharedCriterion: { criterionId: m.id, keyword: { text: m.text, matchType: m.match } } })) });
      if (from === "campaign_shared_set") return J({ results: links.filter((l) => l.setId === idIn(q, "shared_set.id")).map((l) => ({ campaign: { id: l.campaign, name: campaigns[l.campaign]?.name } })) });
      if (from === "campaign") { const c = campaigns[idIn(q, "campaign.id")!]; return J(c ? { results: [{ campaign: { id: idIn(q, "campaign.id"), name: c.name, status: c.status } }] } : {}); }
      if (from === "ad_group_ad") {
        if (q.includes("policy_summary")) {
          const ags = listIn(q, "ad_group.id"), ids = listIn(q, "ad_group_ad.ad.id");
          return J({ results: adRows.filter((a) => ags.includes(a.ag) && ids.includes(a.ad)).map((a) => ({ adGroup: { id: a.ag }, adGroupAd: { ad: { id: a.ad }, status: a.status, policySummary: { approvalStatus: a.approval }, resourceName: `${C}/adGroupAds/${a.ag}~${a.ad}` } })) });
        }
        if (q.includes("responsive_search_ad")) return J({ results: adRows.filter((a) => a.status !== "REMOVED").map((a) => ({ adGroup: { id: a.ag }, adGroupAd: { status: a.status, adStrength: "GOOD", ad: { id: a.ad, type: "RESPONSIVE_SEARCH_AD", finalUrls: ["https://example.com"], responsiveSearchAd: { headlines: [{ text: "Buy now", pinnedField: "HEADLINE_1" }, { text: "Free shipping" }], descriptions: [{ text: "Great deals" }], path1: "shoes" } } } })) });
        return J({ results: [{ adGroup: { id: "21" }, adGroupAd: { ad: { id: "301" }, status: "ENABLED" }, metrics: { impressions: "1000", clicks: "50", costMicros: "25000000", conversions: 5, conversionsValue: 300 } }, { adGroup: { id: "21" }, adGroupAd: { ad: { id: "302" }, status: "PAUSED" }, metrics: { impressions: "0", clicks: "0", costMicros: "0", conversions: 0, conversionsValue: 0 } }] });
      }
    }
    calls.push({ path, body });
    if (dropWrites) return J({ results: [{}], mutateOperationResponses: [{}] });
    if (path.endsWith("googleAds:mutate")) {
      let created = "";
      for (const op of body.mutateOperations) {
        if (op.sharedSetOperation) { created = String(nextId++); sets.push({ id: created, name: op.sharedSetOperation.create.name, type: op.sharedSetOperation.create.type, status: "ENABLED" }); }
        if (op.sharedCriterionOperation) { const k = op.sharedCriterionOperation.create; if (!k.sharedSet.endsWith("/-1")) throw new Error("expected temp id"); members.push({ id: String(nextId++), setId: created, text: k.keyword.text, match: k.keyword.matchType }); }
      }
    } else if (path.endsWith("sharedCriteria:mutate")) for (const op of body.operations) members.push({ id: String(nextId++), setId: op.create.sharedSet.split("/").pop(), text: op.create.keyword.text, match: op.create.keyword.matchType });
    else if (path.endsWith("campaignSharedSets:mutate")) for (const op of body.operations) links.push({ campaign: op.create.campaign.split("/").pop(), setId: op.create.sharedSet.split("/").pop() });
    else if (path.endsWith("adGroupAds:mutate")) for (const op of body.operations) {
      const [ag, ad] = (op.update?.resourceName ?? op.remove).split("/").pop().split("~");
      const row = adRows.find((a) => a.ag === ag && a.ad === ad)!;
      row.status = op.remove ? "REMOVED" : op.update.status;
    }
    return J({ results: body.operations?.map(() => ({})) ?? [], mutateOperationResponses: [] });
};

let kit: GoogleHarness;
let owner: string, second: string, d: PipelineDeps;
beforeAll(async () => {
  kit = await googleHarness("LA", fake);
  ({ owner, second } = kit);
  d = kit.deps;
});

let n = 0;
beforeEach(() => {
  n++;
  nextId = 5000;
  sets = [{ id: "900", name: "Brand safety", type: "NEGATIVE_KEYWORDS", status: "ENABLED" }, { id: "901", name: "Placements", type: "NEGATIVE_PLACEMENTS", status: "ENABLED" }, { id: "902", name: "Old", type: "NEGATIVE_KEYWORDS", status: "REMOVED" }];
  members = [{ id: "1", setId: "900", text: "free", match: "BROAD" }, { id: "2", setId: "900", text: "jobs", match: "PHRASE" }];
  links = [{ campaign: "11", setId: "900" }];
  campaigns = { "11": { name: "Brand", status: "ENABLED" }, "12": { name: "Generic", status: "ENABLED" }, "13": { name: "Gone", status: "REMOVED" }, "14": { name: "Spare", status: "ENABLED" } };
  adRows = [{ ag: "21", ad: "301", status: "ENABLED", approval: "APPROVED" }, { ag: "21", ad: "302", status: "PAUSED", approval: "DISAPPROVED" }, { ag: "21", ad: "303", status: "PAUSED", approval: "APPROVED" }, { ag: "22", ad: "304", status: "REMOVED", approval: "APPROVED" }, { ag: "21", ad: "305", status: "ENABLED", approval: "APPROVED" }, { ag: "21", ad: "306", status: "ENABLED", approval: "APPROVED" }];
  calls = [];
  queries = [];
  dropWrites = false;
});

const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const approve = (aid: string, by = owner) => kit.approveAs(aid, by);
const u = (s: string) => `${s} ${n}`;

describe("registration", () => {
  it("registers the ten tools with the inventory's risk tiers", () => {
    const want: Record<string, string> = { create_negative_keyword_list: "write", add_negative_keywords_to_list: "write", attach_negative_keyword_list_to_campaign: "write", pause_ad: "write", resume_ad: "high_impact", remove_ad: "destructive", bulk_update_ad_status: "high_impact" };
    for (const [name, risk] of Object.entries(want)) { const t = d.registry.get(name)!; expect(t.kind === "write" && t.risk).toBe(risk); }
    for (const r of ["get_negative_keyword_list", "get_ad_creative", "get_ad_performance"]) expect(d.registry.get(r)!.kind).toBe("read");
  });
});

describe("create_negative_keyword_list", () => {
  it("creates the list and its keywords atomically using a temporary id, then reads back", async () => {
    const r = await run("create_negative_keyword_list", { name: u("Competitors"), keywords: [{ text: "rival shoes", match_type: "PHRASE" }, { text: "RIVAL SHOES", match_type: "PHRASE" }, { text: "other brand", match_type: "BROAD" }] });
    expect(r.approval?.summary).toContain("2 keyword(s)");
    expect(r.approval?.summary).toContain("not attached");
    expect(calls).toHaveLength(0);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("customers/1234567890/googleAds:mutate");
    expect(calls[0]!.body.mutateOperations[0]).toEqual({ sharedSetOperation: { create: { resourceName: `${C}/sharedSets/-1`, name: u("Competitors"), type: "NEGATIVE_KEYWORDS" } } });
    expect(calls[0]!.body.mutateOperations[1]).toEqual({ sharedCriterionOperation: { create: { sharedSet: `${C}/sharedSets/-1`, keyword: { text: "rival shoes", matchType: "PHRASE" } } } });
    expect(done.result).toMatchObject({ name: u("Competitors"), keywords_added: 2 });
  });

  it("rejects duplicate names (case-insensitive) and bad input", async () => {
    expect((await run("create_negative_keyword_list", { name: "brand SAFETY" })).error?.message).toContain("already exists");
    for (const a of [{ name: "" }, { name: "a\nb" }, { name: "x".repeat(256) }, { name: u("ok"), keywords: Array.from({ length: 101 }, (_, i) => ({ text: `k${i}`, match_type: "EXACT" })) }, { name: u("ok"), keywords: [{ text: "x", match_type: "NOPE" }] }]) expect((await run("create_negative_keyword_list", a)).error?.code).toBe("invalid_argument");
    expect(calls).toHaveLength(0);
  });

  it("does not claim success when the list does not read back", async () => {
    const r = await run("create_negative_keyword_list", { name: u("Ghost") });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});

describe("add_negative_keywords_to_list", () => {
  it("adds only new keywords and reports how many campaigns are affected", async () => {
    const r = await run("add_negative_keywords_to_list", { shared_set_id: "900", keywords: [{ text: "FREE", match_type: "BROAD" }, { text: u("cheap"), match_type: "BROAD" }] });
    expect(r.approval?.summary).toContain("used by 1 campaign");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls[0]!.path).toBe("customers/1234567890/sharedCriteria:mutate");
    expect(calls[0]!.body.operations).toEqual([{ create: { sharedSet: `${C}/sharedSets/900`, keyword: { text: u("cheap"), matchType: "BROAD" } } }]);
    expect(done.result).toEqual({ added: 1, skipped_existing: 1, campaigns_affected: 1 });
  });

  it("refuses unknown, removed and non-keyword lists, and no-ops", async () => {
    const kw = [{ text: u("x"), match_type: "EXACT" }];
    for (const sid of ["902", "901", "999"]) expect((await run("add_negative_keywords_to_list", { shared_set_id: sid, keywords: kw })).error?.code).toBe("not_found");
    expect((await run("add_negative_keywords_to_list", { shared_set_id: "900", keywords: [{ text: "jobs", match_type: "PHRASE" }] })).error?.message).toContain("nothing would change");
  });
});

describe("attach_negative_keyword_list_to_campaign", () => {
  it("attaches and confirms the link", async () => {
    const r = await run("attach_negative_keyword_list_to_campaign", { campaign_id: "12", shared_set_id: "900" });
    expect(r.approval?.summary).toContain('Attach negative keyword list "Brand safety" (2 keywords) to campaign "Generic"');
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls[0]!.path).toBe("customers/1234567890/campaignSharedSets:mutate");
    expect(calls[0]!.body.operations[0]).toEqual({ create: { campaign: `${C}/campaigns/12`, sharedSet: `${C}/sharedSets/900` } });
  });

  it("refuses already-attached, removed campaigns and unknown ids", async () => {
    expect((await run("attach_negative_keyword_list_to_campaign", { campaign_id: "11", shared_set_id: "900" })).error?.message).toContain("already attached");
    expect((await run("attach_negative_keyword_list_to_campaign", { campaign_id: "13", shared_set_id: "900" })).error?.message).toContain("removed");
    expect((await run("attach_negative_keyword_list_to_campaign", { campaign_id: "99", shared_set_id: "900" })).error?.code).toBe("not_found");
    expect((await run("attach_negative_keyword_list_to_campaign", { campaign_id: "12", shared_set_id: "999" })).error?.code).toBe("not_found");
  });

  it("fails safely if the list changed after the request", async () => {
    const r = await run("attach_negative_keyword_list_to_campaign", { campaign_id: "14", shared_set_id: "900" });
    members.push({ id: "77", setId: "900", text: "new", match: "EXACT" });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({ error: { code: "conflict" } });
    expect(calls).toHaveLength(0);
  });
});

describe("get_negative_keyword_list", () => {
  it("returns the keywords and attached campaigns", async () => {
    const r = await run("get_negative_keyword_list", { shared_set_id: "900" });
    expect(r.data).toMatchObject({ shared_set_id: "900", name: "Brand safety", member_count: 2, campaigns: [{ campaign_id: "11", name: "Brand" }], keywords_truncated: false });
    expect((r.data as any).keywords).toHaveLength(2);
    expect((await run("get_negative_keyword_list", { shared_set_id: "900", keyword_limit: 1 })).data).toMatchObject({ keywords_truncated: true });
    expect((await run("get_negative_keyword_list", { shared_set_id: "999" })).error?.code).toBe("not_found");
    expect(calls).toHaveLength(0);
  });
});

describe("pause_ad / resume_ad", () => {
  it("pauses after approval and confirms", async () => {
    const r = await run("pause_ad", { ad_group_id: "21", ad_id: "301" });
    expect(calls).toHaveLength(0);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls[0]!.path).toBe("customers/1234567890/adGroupAds:mutate");
    expect(calls[0]!.body.operations[0]).toEqual({ update: { resourceName: `${C}/adGroupAds/21~301`, status: "PAUSED" }, updateMask: "status" });
    expect(done.result).toEqual({ ad_group_id: "21", ad_id: "301", status: "PAUSED", previous_status: "ENABLED" });
  });

  it("resume is high impact and warns about a disapproved ad", async () => {
    const r = await run("resume_ad", { ad_group_id: "21", ad_id: "302" });
    expect(r.approval?.risk).toBe("high_impact");
    expect(r.approval?.summary).toContain("DISAPPROVED");
    expect(r.approval?.summary).toContain("will not serve");
    expect((await approve(r.approval!.approval_id, second)).status).toBe("executed");
    expect(adRows.find((a) => a.ad === "302")!.status).toBe("ENABLED");
  });

  it("needs both ids, refuses no-ops, removed and unknown ads", async () => {
    expect((await run("pause_ad", { ad_id: "301" })).error?.code).toBe("invalid_argument");
    expect((await run("pause_ad", { ad_group_id: "21", ad_id: "303" })).error?.message).toContain("already paused");
    expect((await run("pause_ad", { ad_group_id: "22", ad_id: "304" })).error?.message).toContain("Already removed");
    expect((await run("pause_ad", { ad_group_id: "21", ad_id: "999" })).error?.code).toBe("not_found");
    expect((await run("pause_ad", { ad_group_id: "99", ad_id: "301" })).error?.code).toBe("not_found"); // right ad id, wrong ad group
  });

  it("does not call a just-applied duplicate 'pending' (regression)", async () => {
    const first = await run("pause_ad", { ad_group_id: "21", ad_id: "306" });
    await approve(first.approval!.approval_id);
    adRows.find((a) => a.ad === "306")!.status = "ENABLED"; // someone resumed it
    const again = await run("pause_ad", { ad_group_id: "21", ad_id: "306" });
    expect(again.ok).toBe(false);
    expect(again.approval).toBeUndefined();
    expect(again.error?.code).toBe("conflict");
    expect(again.error?.message).toContain("already approved and applied");
    expect(calls).toHaveLength(1);
  });

  it("does not claim success when the status does not read back", async () => {
    const r = await run("pause_ad", { ad_group_id: "21", ad_id: "305" });
    dropWrites = true;
    expect((await approve(r.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});

describe("remove_ad", () => {
  it("is destructive and removes by resource name", async () => {
    const r = await run("remove_ad", { ad_group_id: "21", ad_id: "303" });
    expect(r.approval?.risk).toBe("destructive");
    expect(r.approval?.summary).toContain("cannot be undone");
    const done = await approve(r.approval!.approval_id, second);
    expect(done.status).toBe("executed");
    expect(calls[0]!.body.operations).toEqual([{ remove: `${C}/adGroupAds/21~303` }]);
    expect(done.result).toEqual({ ad_group_id: "21", ad_id: "303", removed: true });
  });

  it("refuses an already removed ad", async () => {
    expect((await run("remove_ad", { ad_group_id: "22", ad_id: "304" })).error?.message).toContain("Already removed");
  });
});

describe("bulk_update_ad_status", () => {
  it("updates only ads not already in the status, and flags unapproved ones", async () => {
    const r = await run("bulk_update_ad_status", { status: "ENABLED", ads: [{ ad_group_id: "21", ad_id: "301" }, { ad_group_id: "21", ad_id: "302" }, { ad_group_id: "21", ad_id: "303" }, { ad_group_id: "21", ad_id: "303" }] });
    expect(r.approval?.summary).toContain("Set 2 ad(s) to ENABLED (1 already enabled)");
    expect(r.approval?.summary).toContain("1 of them are not policy-approved");
    expect((await approve(r.approval!.approval_id, second)).status).toBe("executed");
    expect(calls[0]!.body.operations).toEqual([
      { update: { resourceName: `${C}/adGroupAds/21~302`, status: "ENABLED" }, updateMask: "status" },
      { update: { resourceName: `${C}/adGroupAds/21~303`, status: "ENABLED" }, updateMask: "status" },
    ]);
  });

  it("validates input", async () => {
    expect((await run("bulk_update_ad_status", { status: "PAUSED", ads: [] })).error?.code).toBe("invalid_argument");
    expect((await run("bulk_update_ad_status", { status: "REMOVED", ads: [{ ad_group_id: "21", ad_id: "301" }] })).error?.code).toBe("invalid_argument");
    expect((await run("bulk_update_ad_status", { status: "PAUSED", ads: Array.from({ length: 51 }, (_, i) => ({ ad_group_id: "21", ad_id: String(i + 1) })) })).error?.code).toBe("invalid_argument");
    expect((await run("bulk_update_ad_status", { status: "PAUSED", ads: [{ ad_group_id: "21", ad_id: "301" }, { ad_group_id: "21", ad_id: "999" }] })).error?.code).toBe("not_found");
  });
});

describe("get_ad_creative and get_ad_performance", () => {
  it("returns creative content and never mutates", async () => {
    const r = await run("get_ad_creative", { ad_group_id: "21" });
    const x = r.data as any;
    expect(x.ads).toHaveLength(5);
    expect(x.ads[0]).toMatchObject({ ad_id: "301", type: "RESPONSIVE_SEARCH_AD", ad_strength: "GOOD", final_urls: ["https://example.com"], path1: "shoes", path2: null });
    expect(x.ads[0].headlines).toEqual([{ text: "Buy now", pinned_field: "HEADLINE_1" }, { text: "Free shipping", pinned_field: null }]);
    expect(calls).toHaveLength(0);
    expect(queries.at(-1)).toContain("ad_group_ad.status != 'REMOVED'");
    expect((await run("get_ad_creative", { ad_ids: ["1 OR 1=1"] })).error?.code).toBe("invalid_argument");
  });

  it("computes performance ratios from real metrics and leaves them null when undefined", async () => {
    const r = await run("get_ad_performance", { date_range: "LAST_30_DAYS" });
    const x = r.data as any;
    expect(x.ads[0]).toMatchObject({ ad_id: "301", cost: 25, ctr: 0.05, average_cpc: 0.5, cost_per_conversion: 5, roas: 12 });
    expect(x.ads[1]).toMatchObject({ ad_id: "302", ctr: null, average_cpc: null, cost_per_conversion: null, roas: null });
    expect(x.totals).toMatchObject({ impressions: 1000, clicks: 50, cost: 25, conversions: 5 });
    expect(queries.at(-1)).toContain("segments.date DURING LAST_30_DAYS");
    for (const a of [{ start_date: "2026-01-01" }, { date_range: "X" }, { campaign_id: "1;" }, { limit: 201 }]) expect((await run("get_ad_performance", a)).error?.code).toBe("invalid_argument");
  });
});
