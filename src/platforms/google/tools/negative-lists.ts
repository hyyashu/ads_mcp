import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { GoogleAdsClient } from "../client";
import { Gaql, lit, num, pick } from "../gaql";
import { accountId, googleRead, googleWrite, idSchema as id, keywordItem as kwItem, keywordKey as keyOf, splitNewKeywords as newOnly, str } from "./common";

// v26 references (checked 2026-11-02): SharedSet.name is unique among active shared sets of the same type and 1-255 UTF-8
// bytes; type is immutable; member_count and reference_count are output only. SharedCriterion supports create and remove
// only (no update); its keyword is immutable. CampaignSharedSet supports create and remove only. Resource names:
// sharedSets/{id}, sharedCriteria/{shared_set_id}~{criterion_id}, campaignSharedSets/{campaign_id}~{shared_set_id}.
// GoogleAdsService.Mutate allows temporary negative ids so a set and its keywords are created atomically.

const listName = z.string().trim().min(1).refine((s) => Buffer.byteLength(s) <= 255, "at most 255 bytes").regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters");

interface ListInfo { id: string; name: string; memberCount: number | null; referenceCount: number | null }

export async function activeLists(ads: GoogleAdsClient): Promise<ListInfo[]> {
  const q = new Gaql().select("shared_set.id", "shared_set.name", "shared_set.member_count", "shared_set.reference_count").from("shared_set").where("shared_set.type = 'NEGATIVE_KEYWORDS'").where("shared_set.status = 'ENABLED'").orderBy("shared_set.id");
  const rows = await ads.query(q, { maxRows: 2000 });
  return rows.map((r) => ({ id: String(pick(r, "shared_set.id") ?? ""), name: str(r, "shared_set.name") ?? "", memberCount: pick(r, "shared_set.member_count") === undefined ? null : num(pick(r, "shared_set.member_count")), referenceCount: pick(r, "shared_set.reference_count") === undefined ? null : num(pick(r, "shared_set.reference_count")) }));
}

export async function requireList(ads: GoogleAdsClient, setId: string): Promise<ListInfo> {
  const l = (await activeLists(ads)).find((x) => x.id === setId);
  if (!l) throw new ToolError("not_found", `No active negative keyword list ${setId} in this account.`);
  return l;
}

interface Member { id: string; text: string; matchType: string }
/** The list's keywords. Complete (refused past `max`) unless `partial`, which returns the first `max` for display. */
export async function members(ads: GoogleAdsClient, setId: string, max = 5000, partial = false): Promise<Member[]> {
  const q = new Gaql().select("shared_criterion.criterion_id", "shared_criterion.keyword.text", "shared_criterion.keyword.match_type").from("shared_criterion").where(`shared_set.id = ${lit.id(setId)}`).where("shared_criterion.type = 'KEYWORD'").orderBy("shared_criterion.criterion_id");
  if (partial) q.limit(max);
  const rows = await ads.query(q, { maxRows: max, partial });
  return rows.map((r) => ({ id: String(pick(r, "shared_criterion.criterion_id") ?? ""), text: str(r, "shared_criterion.keyword.text") ?? "", matchType: str(r, "shared_criterion.keyword.match_type") ?? "" }));
}

export async function attachedCampaigns(ads: GoogleAdsClient, setId: string) {
  const q = new Gaql().select("campaign.id", "campaign.name").from("campaign_shared_set").where(`shared_set.id = ${lit.id(setId)}`).where("campaign_shared_set.status = 'ENABLED'").orderBy("campaign.id");
  return (await ads.query(q, { maxRows: 500 })).map((r) => ({ campaign_id: String(pick(r, "campaign.id") ?? ""), name: str(r, "campaign.name") }));
}

// ---------------------------------------------------------------------------------- create_negative_keyword_list
export const createNegativeKeywordList = googleWrite({
  name: "create_negative_keyword_list",
  title: "Create negative keyword list",
  risk: "write",
  description: "Creates a shared negative keyword list, optionally with starting keywords, after approval. The list and its keywords are created in one atomic request. The name must be unique among your active negative keyword lists. A new list blocks nothing until it is attached to a campaign with attach_negative_keyword_list_to_campaign.",
  input: z.object({ account_id: accountId, name: listName, keywords: z.array(kwItem).max(100).default([]) }),
  output: z.object({ shared_set_id: z.string(), name: z.string(), keywords_added: z.number() }),
  plan: async (a, ctx) => {
    const dup = (await activeLists(ctx.services.ads)).find((l) => l.name.toLowerCase() === a.name.toLowerCase());
    if (dup) throw new ToolError("invalid_argument", `A negative keyword list named "${dup.name}" already exists (id ${dup.id}). Names must be unique.`);
    const kws = newOnly(a.keywords, []).toAdd;
    return { summary: `Create negative keyword list "${a.name}" with ${kws.length} keyword(s)${kws.length ? `: ${kws.slice(0, 10).map((k) => `${k.text} [${k.match_type}]`).join(", ")}${kws.length > 10 ? ", …" : ""}` : ""}. It is not attached to any campaign yet.`, snapshot: { name: a.name } };
  },
  verify: async (a, ctx) => {
    const l = (await activeLists(ctx.services.ads)).find((x) => x.name.toLowerCase() === a.name.toLowerCase());
    if (!l) return { outcome: "not_applied" };
    const want = newOnly(a.keywords, []).toAdd.length;
    return (await members(ctx.services.ads, l.id)).length === want ? { outcome: "applied" } : { outcome: "indeterminate", detail: "the list exists but its keywords do not match" };
  },
  execute: async (a, ctx) => {
    const ads = ctx.services.ads;
    if ((await activeLists(ads)).some((l) => l.name.toLowerCase() === a.name.toLowerCase())) throw new ToolError("conflict", "A list with this name now exists.");
    const kws = newOnly(a.keywords, []).toAdd;
    const temp = `customers/${ads.customerId}/sharedSets/-1`;
    await ads.mutateBatch([
      { sharedSetOperation: { create: { resourceName: temp, name: a.name, type: "NEGATIVE_KEYWORDS" } } },
      ...kws.map((k) => ({ sharedCriterionOperation: { create: { sharedSet: temp, keyword: { text: k.text.trim(), matchType: k.match_type } } } })),
    ]);
    const made = (await activeLists(ads)).find((l) => l.name.toLowerCase() === a.name.toLowerCase());
    if (!made) throw new ToolError("unknown_outcome", "Google accepted the request but the list does not read back.");
    const got = await members(ads, made.id);
    if (got.length !== kws.length) throw new ToolError("unknown_outcome", "The list was created but its keywords do not read back as requested.");
    return { shared_set_id: made.id, name: made.name, keywords_added: got.length };
  },
});

// ------------------------------------------------------------------------------ add_negative_keywords_to_list
export const addNegativeKeywordsToList = googleWrite({
  name: "add_negative_keywords_to_list",
  title: "Add keywords to a negative keyword list",
  risk: "write",
  description: "Adds negative keywords to an existing shared negative keyword list after approval. This affects every campaign the list is attached to. Keywords already in the list (same text, case-insensitive, and match type) are skipped. Confirmed by reading each keyword back.",
  input: z.object({ account_id: accountId, shared_set_id: id, keywords: z.array(kwItem).min(1).max(100) }),
  output: z.object({ added: z.number(), skipped_existing: z.number(), campaigns_affected: z.number() }),
  plan: async (a, ctx) => {
    const l = await requireList(ctx.services.ads, a.shared_set_id);
    const { toAdd, skipped } = newOnly(a.keywords, await members(ctx.services.ads, a.shared_set_id));
    if (!toAdd.length) throw new ToolError("invalid_argument", "All of these keywords are already in the list, so nothing would change.");
    const refs = l.referenceCount ?? 0;
    return { summary: `Add ${toAdd.length} negative keyword(s) to list "${l.name}": ${toAdd.slice(0, 10).map((k) => `${k.text} [${k.match_type}]`).join(", ")}${toAdd.length > 10 ? ", …" : ""}. The list is used by ${refs} campaign(s)${skipped.length ? `; ${skipped.length} already present and skipped` : ""}.`, snapshot: { skipped, refs } };
  },
  verify: async (a, ctx, run) => {
    const have = new Set((await members(ctx.services.ads, a.shared_set_id)).map((m) => keyOf(m.text, m.matchType)));
    const snap = run.snapshot as { skipped: string[] };
    const want = [...new Set(a.keywords.map((k) => keyOf(k.text, k.match_type)))].filter((k) => !snap.skipped.includes(k));
    const present = want.filter((k) => have.has(k)).length;
    return present === want.length ? { outcome: "applied" } : present === 0 ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: `${present} of ${want.length} present` };
  },
  execute: async (a, ctx, run) => {
    const ads = ctx.services.ads;
    const l = await requireList(ads, a.shared_set_id);
    const snap = run.snapshot as { skipped: string[]; refs: number };
    const { toAdd, skipped } = newOnly(a.keywords, await members(ads, a.shared_set_id));
    if (JSON.stringify(skipped) !== JSON.stringify(snap.skipped) || (l.referenceCount ?? 0) !== snap.refs) throw new ToolError("conflict", "The list changed since this was requested.");
    await ads.mutate("sharedCriteria", toAdd.map((k) => ({ create: { sharedSet: `customers/${ads.customerId}/sharedSets/${a.shared_set_id}`, keyword: { text: k.text.trim(), matchType: k.match_type } } })));
    const have = new Set((await members(ads, a.shared_set_id)).map((m) => keyOf(m.text, m.matchType)));
    if (toAdd.some((k) => !have.has(keyOf(k.text, k.match_type)))) throw new ToolError("unknown_outcome", "Google accepted the request but some keywords do not read back.");
    return { added: toAdd.length, skipped_existing: skipped.length, campaigns_affected: snap.refs };
  },
});

// -------------------------------------------------------------------- attach_negative_keyword_list_to_campaign
async function campaignInfo(ads: GoogleAdsClient, cid: string) {
  const [r] = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status").from("campaign").where(`campaign.id = ${lit.id(cid)}`).limit(1), { maxRows: 1 });
  if (!r) throw new ToolError("not_found", `No campaign ${cid} in this account.`);
  if (pick(r, "campaign.status") === "REMOVED") throw new ToolError("invalid_argument", "The campaign is removed.");
  return { name: str(r, "campaign.name") };
}
const isAttached = async (ads: GoogleAdsClient, cid: string, setId: string) => (await attachedCampaigns(ads, setId)).some((c) => c.campaign_id === cid);

export const attachNegativeKeywordListToCampaign = googleWrite({
  name: "attach_negative_keyword_list_to_campaign",
  title: "Attach negative keyword list to a campaign",
  risk: "write",
  description: "Applies a shared negative keyword list to a campaign after approval, so every keyword in the list becomes a negative there. This can reduce the campaign's traffic. Refuses if the list is already attached. Confirmed by reading the link back.",
  input: z.object({ account_id: accountId, campaign_id: id, shared_set_id: id }),
  output: z.object({ campaign_id: z.string(), shared_set_id: z.string(), attached: z.literal(true) }),
  plan: async (a, ctx) => {
    const ads = ctx.services.ads;
    const c = await campaignInfo(ads, a.campaign_id);
    const l = await requireList(ads, a.shared_set_id);
    if (await isAttached(ads, a.campaign_id, a.shared_set_id)) throw new ToolError("invalid_argument", "This list is already attached to the campaign.");
    return { summary: `Attach negative keyword list "${l.name}" (${l.memberCount ?? "?"} keywords) to campaign "${c.name ?? a.campaign_id}"`, snapshot: { attached: false, members: l.memberCount } };
  },
  verify: async (a, ctx) => ((await isAttached(ctx.services.ads, a.campaign_id, a.shared_set_id)) ? { outcome: "applied" } : { outcome: "not_applied" }),
  execute: async (a, ctx, run) => {
    const ads = ctx.services.ads;
    const l = await requireList(ads, a.shared_set_id);
    if ((await isAttached(ads, a.campaign_id, a.shared_set_id)) || l.memberCount !== (run.snapshot as { members: number | null }).members) throw new ToolError("conflict", "The list or its attachment changed since this was requested.");
    await ads.mutate("campaignSharedSets", [{ create: { campaign: `customers/${ads.customerId}/campaigns/${a.campaign_id}`, sharedSet: `customers/${ads.customerId}/sharedSets/${a.shared_set_id}` } }]);
    if (!(await isAttached(ads, a.campaign_id, a.shared_set_id))) throw new ToolError("unknown_outcome", "Google accepted the request but the link does not read back.");
    return { campaign_id: a.campaign_id, shared_set_id: a.shared_set_id, attached: true as const };
  },
});

// ------------------------------------------------------------------------------------ get_negative_keyword_list
export const getNegativeKeywordList = googleRead({
  name: "get_negative_keyword_list",
  title: "Get a negative keyword list",
  description: "Shows one shared negative keyword list: its keywords and the campaigns it is attached to. Fetched live from Google Ads.",
  input: z.object({ account_id: accountId, shared_set_id: id, keyword_limit: z.number().int().min(1).max(1000).default(200) }),
  output: z.object({
    shared_set_id: z.string(),
    name: z.string(),
    member_count: z.number().nullable(),
    campaigns: z.array(z.object({ campaign_id: z.string(), name: z.string().nullable() })),
    keywords: z.array(z.object({ criterion_id: z.string(), text: z.string(), match_type: z.string() })),
    keywords_truncated: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const l = await requireList(ctx.services.ads, a.shared_set_id);
    const all = await members(ctx.services.ads, a.shared_set_id, a.keyword_limit + 1, true);
    return {
      shared_set_id: l.id,
      name: l.name,
      member_count: l.memberCount,
      campaigns: await attachedCampaigns(ctx.services.ads, a.shared_set_id),
      keywords: all.slice(0, a.keyword_limit).map((m) => ({ criterion_id: m.id, text: m.text, match_type: m.matchType })),
      keywords_truncated: all.length > a.keyword_limit,
    };
  },
});

export const negativeListTools = [createNegativeKeywordList, addNegativeKeywordsToList, attachNegativeKeywordListToCampaign, getNegativeKeywordList];
