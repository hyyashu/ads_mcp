import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { GoogleAdsClient } from "../client";
import { Gaql, fromMicros, lit, num, pick } from "../gaql";
import { Money, accountId, dateClause, dateFields, datesMsg, datesOk, googleRead, googleWrite, idSchema as id, keywordItem as kwItem, keywordKey as keyOf, ratio, requireParent as requireParentOf, round, sortedUnique as sortedKeys, splitNewKeywords, str, toMicros } from "./common";

// Verified against the v26 reference (2026-11-02): KeywordInfo.text is at most 80 characters and 10 words; match types are
// BROAD, PHRASE, EXACT; criterion keyword/negative/ad_group/campaign are immutable (change text = remove + re-add);
// resource names are customers/{c}/adGroupCriteria/{ad_group_id}~{criterion_id} and customers/{c}/campaignCriteria/{campaign_id}~{criterion_id};
// `remove` takes the resource name. Atomic by default (partial_failure false).


interface Scope {
  level: "ad_group" | "campaign";
  id: string;
  negative: boolean;
}
interface Crit {
  id: string;
  text: string;
  matchType: string;
  status: string;
  cpcMicros: number | null;
}

/** The parent must exist and not be removed (see requireParent in common.ts). */
const requireParent = async (ads: GoogleAdsClient, s: Scope): Promise<void> => void (await requireParentOf(ads, s.level, s.id, "Keywords"));

async function listCriteria(ads: GoogleAdsClient, s: Scope): Promise<Crit[]> {
  const t = s.level === "ad_group" ? "ad_group_criterion" : "campaign_criterion";
  const q = new Gaql()
    .select(`${t}.criterion_id`, `${t}.keyword.text`, `${t}.keyword.match_type`, `${t}.status`, ...(s.level === "ad_group" ? ["ad_group_criterion.cpc_bid_micros"] : []))
    .from(t)
    .where(`${s.level}.id = ${lit.id(s.id)}`)
    .where(`${t}.type = 'KEYWORD'`)
    .where(`${t}.negative = ${s.negative ? "TRUE" : "FALSE"}`)
    .where(`${t}.status != 'REMOVED'`)
    .orderBy(`${t}.criterion_id`)
    .limit(5000);
  const rows = await ads.query(q, { maxRows: 5000 });
  return rows.map((r) => ({
    id: String(pick(r, `${t}.criterion_id`) ?? ""),
    text: str(r, `${t}.keyword.text`) ?? "",
    matchType: str(r, `${t}.keyword.match_type`) ?? "",
    status: str(r, `${t}.status`) ?? "",
    cpcMicros: pick(r, `${t}.cpc_bid_micros`) === undefined ? null : num(pick(r, `${t}.cpc_bid_micros`)),
  }));
}

const critResource = (cid: string, s: Scope, critId: string) => `customers/${cid}/${s.level === "ad_group" ? "adGroupCriteria" : "campaignCriteria"}/${s.id}~${critId}`;
const service = (s: Scope) => (s.level === "ad_group" ? "adGroupCriteria" : "campaignCriteria");
const parentResource = (cid: string, s: Scope) => `customers/${cid}/${s.level === "ad_group" ? "adGroups" : "campaigns"}/${s.id}`;

// ------------------------------------------------------------------------------------------------ shared add logic
type Item = { text: string; match_type: string; cpc_bid?: number };
const splitNew = splitNewKeywords;

async function planAdd(ads: GoogleAdsClient, s: Scope, items: Item[], label: string) {
  await requireParent(ads, s);
  const { toAdd, skipped } = splitNew(items, await listCriteria(ads, s));
  if (!toAdd.length) throw new ToolError("invalid_argument", "All of these keywords already exist, so nothing would change.");
  const list = toAdd.slice(0, 10).map((k) => `${k.text} [${k.match_type}]`).join(", ");
  return { summary: `Add ${toAdd.length} ${label} to ${s.level === "ad_group" ? "ad group" : "campaign"} ${s.id}: ${list}${toAdd.length > 10 ? `, +${toAdd.length - 10} more` : ""}${skipped.length ? ` (${skipped.length} already exist and are skipped)` : ""}`, snapshot: { scope: s, skipped } };
}

async function execAdd(ads: GoogleAdsClient, s: Scope, items: Item[], snapshot: unknown) {
  const snap = snapshot as { skipped: string[] };
  const { toAdd, skipped } = splitNew(items, await listCriteria(ads, s));
  if (JSON.stringify(skipped) !== JSON.stringify(snap.skipped)) throw new ToolError("conflict", "The keywords in this scope changed since this was requested.");
  const ops = toAdd.map((k) => ({
    create: {
      [s.level === "ad_group" ? "adGroup" : "campaign"]: parentResource(ads.customerId, s),
      negative: s.negative,
      keyword: { text: k.text.trim(), matchType: k.match_type },
      ...(s.level === "ad_group" && !s.negative ? { status: "ENABLED" } : {}),
      ...(k.cpc_bid !== undefined && !s.negative ? { cpcBidMicros: String(toMicros(k.cpc_bid)) } : {}),
    },
  }));
  await ads.mutate(service(s), ops);
  const after = await listCriteria(ads, s);
  const byKey = new Map(after.map((c) => [keyOf(c.text, c.matchType), c]));
  const missing = toAdd.filter((k) => !byKey.has(keyOf(k.text, k.match_type)));
  if (missing.length) throw new ToolError("unknown_outcome", `Google accepted the request but ${missing.length} keyword(s) do not read back.`);
  return {
    added: toAdd.length,
    skipped_existing: skipped.length,
    keywords: toAdd.map((k) => {
      const c = byKey.get(keyOf(k.text, k.match_type))!;
      return { criterion_id: c.id, text: c.text, match_type: c.matchType };
    }),
  };
}

async function verifyAdd(ads: GoogleAdsClient, s: Scope, items: Item[], snapshot: unknown) {
  const snap = snapshot as { skipped: string[] };
  const have = new Set((await listCriteria(ads, s)).map((c) => keyOf(c.text, c.matchType)));
  const want = [...new Set(items.map((i) => keyOf(i.text, i.match_type)))].filter((k) => !snap.skipped.includes(k));
  const present = want.filter((k) => have.has(k)).length;
  if (present === want.length) return { outcome: "applied" as const };
  if (present === 0) return { outcome: "not_applied" as const };
  return { outcome: "indeterminate" as const, detail: `${present} of ${want.length} keywords are present` };
}

// ------------------------------------------------------------------------------------------------ shared remove logic
async function planRemove(ads: GoogleAdsClient, s: Scope, ids: string[], label: string) {
  await requireParent(ads, s);
  const have = new Map((await listCriteria(ads, s)).map((c) => [c.id, c]));
  const unique = sortedKeys(ids);
  const missing = unique.filter((i) => !have.has(i));
  if (missing.length) throw new ToolError("invalid_argument", `Not found in this ${s.level === "ad_group" ? "ad group" : "campaign"} (or not a ${label}): ${missing.slice(0, 10).join(", ")}`);
  const names = unique.slice(0, 10).map((i) => `${have.get(i)!.text} [${have.get(i)!.matchType}]`).join(", ");
  return { summary: `Permanently remove ${unique.length} ${label}${unique.length === 1 ? "" : "s"} from ${s.level === "ad_group" ? "ad group" : "campaign"} ${s.id}: ${names}${unique.length > 10 ? `, +${unique.length - 10} more` : ""}. Removed keywords cannot be restored; they must be added again.`, snapshot: { scope: s, ids: unique } };
}

async function execRemove(ads: GoogleAdsClient, s: Scope, ids: string[], snapshot: unknown) {
  const snap = snapshot as { ids: string[] };
  const unique = sortedKeys(ids);
  const have = new Set((await listCriteria(ads, s)).map((c) => c.id));
  if (JSON.stringify(unique) !== JSON.stringify(snap.ids) || unique.some((i) => !have.has(i))) throw new ToolError("conflict", "The keywords changed since this was requested.");
  await ads.mutate(service(s), unique.map((i) => ({ remove: critResource(ads.customerId, s, i) })));
  const after = new Set((await listCriteria(ads, s)).map((c) => c.id));
  const still = unique.filter((i) => after.has(i));
  if (still.length) throw new ToolError("unknown_outcome", `Google accepted the request but ${still.length} keyword(s) are still present.`);
  return { removed: unique.length, criterion_ids: unique };
}

async function verifyRemove(ads: GoogleAdsClient, s: Scope, ids: string[]) {
  const unique = sortedKeys(ids);
  const have = new Set((await listCriteria(ads, s)).map((c) => c.id));
  const gone = unique.filter((i) => !have.has(i)).length;
  if (gone === unique.length) return { outcome: "applied" as const };
  if (gone === 0) return { outcome: "not_applied" as const };
  return { outcome: "indeterminate" as const, detail: `${gone} of ${unique.length} keywords are gone` };
}

// ---------------------------------------------------------------------------------------------------- add_keywords
const addOut = z.object({ added: z.number(), skipped_existing: z.number(), keywords: z.array(z.object({ criterion_id: z.string(), text: z.string(), match_type: z.string() })) });

export const addKeywords = googleWrite({
  name: "add_keywords",
  title: "Add keywords",
  risk: "write",
  description: "Adds keywords to an ad group after approval. Keywords are enabled when added. Keywords that already exist (same text, case-insensitive, and match type) are skipped. The request is atomic and each keyword is confirmed by reading it back. Keyword text and match type cannot be edited later: remove and re-add instead.",
  input: z.object({ account_id: accountId, ad_group_id: id.describe("An ad group id (not a campaign id)."), keywords: z.array(kwItem.extend({ cpc_bid: z.number().positive().max(10_000).optional().describe("Max CPC in the account's currency.") })).min(1).max(50) }),
  output: addOut,
  plan: (a, ctx) => planAdd(ctx.services.ads, { level: "ad_group", id: a.ad_group_id, negative: false }, a.keywords, "keyword(s)"),
  verify: (a, ctx, run) => verifyAdd(ctx.services.ads, { level: "ad_group", id: a.ad_group_id, negative: false }, a.keywords, run.snapshot),
  execute: (a, ctx, run) => execAdd(ctx.services.ads, { level: "ad_group", id: a.ad_group_id, negative: false }, a.keywords, run.snapshot),
});

// ---------------------------------------------------------------------------------------------------- update_keyword
export const updateKeyword = googleWrite({
  name: "update_keyword",
  title: "Update keyword",
  risk: "write",
  description: "Pauses or enables a keyword and/or changes its max CPC bid, after approval. Keyword text and match type are immutable in Google Ads: to change them, remove the keyword and add a new one. Confirmed by re-reading the keyword.",
  input: z.object({ account_id: accountId, ad_group_id: id, criterion_id: id, status: z.enum(["ENABLED", "PAUSED"]).optional(), cpc_bid: z.number().positive().max(10_000).optional() }).refine((v) => v.status !== undefined || v.cpc_bid !== undefined, "give status and/or cpc_bid"),
  output: z.object({ criterion_id: z.string(), text: z.string(), match_type: z.string(), status: z.string(), cpc_bid: Money.nullable() }),
  plan: async (a, ctx) => {
    const s: Scope = { level: "ad_group", id: a.ad_group_id, negative: false };
    await requireParent(ctx.services.ads, s);
    const c = (await listCriteria(ctx.services.ads, s)).find((x) => x.id === a.criterion_id);
    if (!c) throw new ToolError("not_found", `No keyword ${a.criterion_id} in ad group ${a.ad_group_id}.`);
    const parts: string[] = [];
    if (a.status !== undefined && a.status !== c.status) parts.push(`status ${c.status} -> ${a.status}`);
    if (a.cpc_bid !== undefined && toMicros(a.cpc_bid) !== c.cpcMicros) parts.push(`max CPC ${c.cpcMicros === null ? "unset" : c.cpcMicros / 1e6} -> ${a.cpc_bid}`);
    if (!parts.length) throw new ToolError("invalid_argument", "Nothing would change.");
    return { summary: `Keyword "${c.text}" [${c.matchType}] in ad group ${a.ad_group_id}: ${parts.join("; ")}`, snapshot: { status: c.status, cpc: c.cpcMicros } };
  },
  verify: async (a, ctx, run) => {
    const c = (await listCriteria(ctx.services.ads, { level: "ad_group", id: a.ad_group_id, negative: false })).find((x) => x.id === a.criterion_id);
    const b = run.snapshot as { status: string; cpc: number | null };
    if (!c) return { outcome: "indeterminate", detail: "keyword not found" };
    if ((a.status === undefined || c.status === a.status) && (a.cpc_bid === undefined || c.cpcMicros === toMicros(a.cpc_bid))) return { outcome: "applied" };
    return c.status === b.status && c.cpcMicros === b.cpc ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: "only part of the change is visible" };
  },
  execute: async (a, ctx, run) => {
    const s: Scope = { level: "ad_group", id: a.ad_group_id, negative: false };
    const cur = (await listCriteria(ctx.services.ads, s)).find((x) => x.id === a.criterion_id);
    const b = run.snapshot as { status: string; cpc: number | null };
    if (!cur || cur.status !== b.status || cur.cpcMicros !== b.cpc) throw new ToolError("conflict", "The keyword changed since this was requested.");
    const update: Record<string, unknown> = { resourceName: critResource(ctx.services.ads.customerId, s, a.criterion_id) };
    const mask: string[] = [];
    if (a.status !== undefined) (update.status = a.status), mask.push("status");
    if (a.cpc_bid !== undefined) (update.cpcBidMicros = String(toMicros(a.cpc_bid))), mask.push("cpc_bid_micros");
    await ctx.services.ads.mutate("adGroupCriteria", [{ update, updateMask: mask.join(",") }]);
    const after = (await listCriteria(ctx.services.ads, s)).find((x) => x.id === a.criterion_id);
    if (!after || (a.status !== undefined && after.status !== a.status) || (a.cpc_bid !== undefined && after.cpcMicros !== toMicros(a.cpc_bid))) throw new ToolError("unknown_outcome", "Google accepted the request but the keyword does not read back as requested.");
    return { criterion_id: after.id, text: after.text, match_type: after.matchType, status: after.status, cpc_bid: after.cpcMicros === null ? null : fromMicros(after.cpcMicros) };
  },
});

// ---------------------------------------------------------------------------------------------------- remove_keywords
const removeOut = z.object({ removed: z.number(), criterion_ids: z.array(z.string()) });

export const removeKeywords = googleWrite({
  name: "remove_keywords",
  title: "Remove keywords",
  risk: "destructive",
  description: "Permanently removes keywords from an ad group after approval from a second person. Removed keywords cannot be restored; they would have to be added again, losing their history. To stop a keyword temporarily, pause it with update_keyword or bulk_update_keyword_status instead.",
  input: z.object({ account_id: accountId, ad_group_id: id, criterion_ids: z.array(id).min(1).max(50) }),
  output: removeOut,
  plan: (a, ctx) => planRemove(ctx.services.ads, { level: "ad_group", id: a.ad_group_id, negative: false }, a.criterion_ids, "keyword"),
  verify: (a, ctx) => verifyRemove(ctx.services.ads, { level: "ad_group", id: a.ad_group_id, negative: false }, a.criterion_ids),
  execute: (a, ctx, run) => execRemove(ctx.services.ads, { level: "ad_group", id: a.ad_group_id, negative: false }, a.criterion_ids, run.snapshot),
});

// ------------------------------------------------------------------------------------------ bulk_update_keyword_status
export const bulkUpdateKeywordStatus = googleWrite({
  name: "bulk_update_keyword_status",
  title: "Pause or enable keywords in bulk",
  risk: "high_impact",
  description: "Pauses or enables several keywords in one ad group after approval from a second person. Keywords already in the requested status are left alone. Enabling can start spend. Applied in one atomic request and confirmed by re-reading.",
  input: z.object({ account_id: accountId, ad_group_id: id, criterion_ids: z.array(id).min(1).max(50), status: z.enum(["ENABLED", "PAUSED"]) }),
  output: z.object({ updated: z.number(), criterion_ids: z.array(z.string()), status: z.string() }),
  plan: async (a, ctx) => {
    const s: Scope = { level: "ad_group", id: a.ad_group_id, negative: false };
    await requireParent(ctx.services.ads, s);
    const have = new Map((await listCriteria(ctx.services.ads, s)).map((c) => [c.id, c]));
    const ids = sortedKeys(a.criterion_ids);
    const missing = ids.filter((i) => !have.has(i));
    if (missing.length) throw new ToolError("invalid_argument", `Not found in this ad group (or not a keyword): ${missing.slice(0, 10).join(", ")}`);
    const changing = ids.filter((i) => have.get(i)!.status !== a.status);
    if (!changing.length) throw new ToolError("invalid_argument", `All of these keywords are already ${a.status.toLowerCase()}.`);
    return { summary: `Set ${changing.length} keyword(s) in ad group ${a.ad_group_id} to ${a.status}${changing.length < ids.length ? ` (${ids.length - changing.length} already ${a.status.toLowerCase()})` : ""}: ${changing.slice(0, 10).map((i) => have.get(i)!.text).join(", ")}${changing.length > 10 ? ", …" : ""}`, snapshot: { changing } };
  },
  verify: async (a, ctx, run) => {
    const { changing } = run.snapshot as { changing: string[] };
    const now = new Map((await listCriteria(ctx.services.ads, { level: "ad_group", id: a.ad_group_id, negative: false })).map((c) => [c.id, c.status]));
    const done = changing.filter((i) => now.get(i) === a.status).length;
    if (done === changing.length) return { outcome: "applied" };
    return done === 0 ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: `${done} of ${changing.length} updated` };
  },
  execute: async (a, ctx, run) => {
    const s: Scope = { level: "ad_group", id: a.ad_group_id, negative: false };
    const { changing } = run.snapshot as { changing: string[] };
    const now = new Map((await listCriteria(ctx.services.ads, s)).map((c) => [c.id, c.status]));
    const still = sortedKeys(a.criterion_ids).filter((i) => now.get(i) !== a.status);
    if (JSON.stringify(still) !== JSON.stringify(changing)) throw new ToolError("conflict", "The keywords changed since this was requested.");
    await ctx.services.ads.mutate("adGroupCriteria", changing.map((i) => ({ update: { resourceName: critResource(ctx.services.ads.customerId, s, i), status: a.status }, updateMask: "status" })));
    const after = new Map((await listCriteria(ctx.services.ads, s)).map((c) => [c.id, c.status]));
    if (changing.some((i) => after.get(i) !== a.status)) throw new ToolError("unknown_outcome", "Google accepted the request but some keywords do not read back as requested.");
    return { updated: changing.length, criterion_ids: changing, status: a.status };
  },
});

// ------------------------------------------------------------------------------------------- negative keywords
const negScope = z.object({ campaign_id: id.optional().describe("Campaign-level negatives. Give exactly one of campaign_id or ad_group_id."), ad_group_id: id.optional().describe("Ad-group-level negatives.") });
const oneScope = (v: { campaign_id?: string; ad_group_id?: string }) => (v.campaign_id === undefined) !== (v.ad_group_id === undefined);
const oneScopeMsg = { message: "give exactly one of campaign_id or ad_group_id" };
const scopeOf = (a: { campaign_id?: string; ad_group_id?: string }): Scope => (a.ad_group_id ? { level: "ad_group", id: a.ad_group_id, negative: true } : { level: "campaign", id: a.campaign_id!, negative: true });

export const addNegativeKeywords = googleWrite({
  name: "add_negative_keywords",
  title: "Add negative keywords",
  risk: "write",
  description: "Adds negative keywords to a campaign or to an ad group after approval, so matching searches stop triggering ads there. Existing negatives (same text, case-insensitive, and match type) are skipped. Negative match types follow Google's rules: a negative BROAD keyword blocks searches containing all its words in any order. Confirmed by reading each back.",
  input: negScope.extend({ account_id: accountId, keywords: z.array(kwItem).min(1).max(100) }).refine(oneScope, oneScopeMsg),
  output: addOut,
  plan: (a, ctx) => planAdd(ctx.services.ads, scopeOf(a), a.keywords, "negative keyword(s)"),
  verify: (a, ctx, run) => verifyAdd(ctx.services.ads, scopeOf(a), a.keywords, run.snapshot),
  execute: (a, ctx, run) => execAdd(ctx.services.ads, scopeOf(a), a.keywords, run.snapshot),
});

export const removeNegativeKeywords = googleWrite({
  name: "remove_negative_keywords",
  title: "Remove negative keywords",
  risk: "destructive",
  description: "Permanently removes negative keywords from a campaign or an ad group after approval from a second person. Removing a negative lets matching searches trigger ads again and can increase spend. Removed negatives cannot be restored; add them again if needed.",
  input: negScope.extend({ account_id: accountId, criterion_ids: z.array(id).min(1).max(100) }).refine(oneScope, oneScopeMsg),
  output: removeOut,
  plan: (a, ctx) => planRemove(ctx.services.ads, scopeOf(a), a.criterion_ids, "negative keyword"),
  verify: (a, ctx) => verifyRemove(ctx.services.ads, scopeOf(a), a.criterion_ids),
  execute: (a, ctx, run) => execRemove(ctx.services.ads, scopeOf(a), a.criterion_ids, run.snapshot),
});

// ----------------------------------------------------------------------------------------- analyze_search_terms
const MAX_TERMS = 1000;
const termRow = z.object({ search_term: z.string().nullable(), campaign_id: z.string().nullable(), ad_group_id: z.string().nullable(), targeting_status: z.string().nullable().describe("Google's own status for this term (added/excluded as a keyword), passed through unchanged."), impressions: z.number(), clicks: z.number(), cost: Money, conversions: z.number(), conversion_value: z.number(), ctr: z.number().nullable(), cost_per_conversion: Money.nullable() });
const bucket = z.object({ terms: z.number(), cost: Money, clicks: z.number(), conversions: z.number() });

export const analyzeSearchTerms = googleRead({
  name: "analyze_search_terms",
  title: "Analyze search terms",
  description:
    "Sorts the search terms that triggered ads into fixed groups using real metrics: converting (conversions > 0), wasted (conversions = 0 and cost >= min_cost) and low-data (everything else). Lists the top terms of the first two groups. These are rules, not predictions or recommendations: review each term before excluding it, since a brand or relevant term can look wasted over a short period. Covers the top 1,000 terms by cost. Performance Max search terms are not included in this view.",
  input: z.object({ account_id: accountId, ...dateFields, campaign_id: id.optional(), ad_group_id: id.optional(), min_cost: z.number().min(0).max(1_000_000).default(10), limit: z.number().int().min(1).max(100).default(25) }).refine(datesOk, datesMsg),
  output: z.object({
    period: z.string(),
    rules: z.object({ converting: z.string(), wasted: z.string(), low_data: z.string() }),
    terms_analyzed: z.number(),
    covers_all_terms: z.boolean(),
    summary: z.object({ converting: bucket, wasted: bucket, low_data: bucket }),
    converting: z.array(termRow),
    wasted: z.array(termRow),
  }),
  handler: async (a, ctx) => {
    const q = new Gaql()
      .select("search_term_view.search_term", "search_term_view.status", "campaign.id", "ad_group.id", "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value")
      .from("search_term_view")
      .where(dateClause(a))
      .where(a.campaign_id && `campaign.id = ${lit.id(a.campaign_id)}`)
      .where(a.ad_group_id && `ad_group.id = ${lit.id(a.ad_group_id)}`)
      .orderBy("metrics.cost_micros", "DESC")
      .limit(MAX_TERMS);
    const rows = await ctx.services.ads.query(q, { maxRows: MAX_TERMS });
    const terms = rows.map((r) => {
      const impressions = num(pick(r, "metrics.impressions")), clicks = num(pick(r, "metrics.clicks")), cost = fromMicros(pick(r, "metrics.cost_micros")), conversions = num(pick(r, "metrics.conversions"));
      return { search_term: str(r, "search_term_view.search_term"), campaign_id: str(r, "campaign.id"), ad_group_id: str(r, "ad_group.id"), targeting_status: str(r, "search_term_view.status"), impressions, clicks, cost: round(cost, 2)!, conversions, conversion_value: round(num(pick(r, "metrics.conversions_value")), 2)!, ctr: round(ratio(clicks, impressions)), cost_per_conversion: round(ratio(cost, conversions), 2) };
    });
    const converting = terms.filter((t) => t.conversions > 0);
    const wasted = terms.filter((t) => t.conversions === 0 && t.cost >= a.min_cost);
    const low = terms.filter((t) => !(t.conversions > 0) && !(t.conversions === 0 && t.cost >= a.min_cost));
    const sum = (xs: typeof terms) => ({ terms: xs.length, cost: round(xs.reduce((s, t) => s + t.cost, 0), 2)!, clicks: xs.reduce((s, t) => s + t.clicks, 0), conversions: xs.reduce((s, t) => s + t.conversions, 0) });
    return {
      period: a.start_date && a.end_date ? `${a.start_date}..${a.end_date}` : a.date_range,
      rules: { converting: "conversions > 0", wasted: `conversions = 0 and cost >= ${a.min_cost}`, low_data: "all other terms" },
      terms_analyzed: terms.length,
      covers_all_terms: rows.length < MAX_TERMS,
      summary: { converting: sum(converting), wasted: sum(wasted), low_data: sum(low) },
      converting: converting.slice(0, a.limit),
      wasted: wasted.slice(0, a.limit),
    };
  },
});

export const keywordTools = [addKeywords, updateKeyword, removeKeywords, bulkUpdateKeywordStatus, addNegativeKeywords, removeNegativeKeywords, analyzeSearchTerms];
