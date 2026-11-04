import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { GoogleAdsClient } from "../client";
import { Gaql, fromMicros, lit, num, pick } from "../gaql";
import { Money, accountId, dateClause, dateFields, datesMsg, datesOk, googleRead, googleWrite, idSchema as id, ratio, round, str } from "./common";

// v26 references (checked 2026-11-02): AdGroupAd.ad_group, ad and resource_name are immutable; status is
// ENABLED/PAUSED/REMOVED; resource name customers/{c}/adGroupAds/{ad_group_id}~{ad_id}; AdGroupAdOperation is
// create/update/remove with update_mask, `remove` takes the resource name; policy_summary and ad_strength are output only.

const adKey = (ag: string, ad: string) => `${ag}~${ad}`;

interface AdInfo { adGroupId: string; adId: string; status: string; approval: string | null; resourceName: string }

/** Reads the given ads, including removed ones (so a removal can be confirmed). */
async function readAds(ads: GoogleAdsClient, pairs: { ad_group_id: string; ad_id: string }[]): Promise<Map<string, AdInfo>> {
  const q = new Gaql()
    .select("ad_group.id", "ad_group_ad.ad.id", "ad_group_ad.status", "ad_group_ad.policy_summary.approval_status", "ad_group_ad.resource_name")
    .from("ad_group_ad")
    .where(`ad_group.id IN ${lit.list([...new Set(pairs.map((p) => lit.id(p.ad_group_id)))])}`)
    .where(`ad_group_ad.ad.id IN ${lit.list([...new Set(pairs.map((p) => lit.id(p.ad_id)))])}`)
    .limit(5000);
  const rows = await ads.query(q, { maxRows: 5000 });
  const wanted = new Set(pairs.map((p) => adKey(p.ad_group_id, p.ad_id)));
  const out = new Map<string, AdInfo>();
  for (const r of rows) {
    const ag = String(pick(r, "ad_group.id") ?? ""), ad = String(pick(r, "ad_group_ad.ad.id") ?? "");
    if (!wanted.has(adKey(ag, ad))) continue;
    out.set(adKey(ag, ad), { adGroupId: ag, adId: ad, status: str(r, "ad_group_ad.status") ?? "", approval: str(r, "ad_group_ad.policy_summary.approval_status"), resourceName: str(r, "ad_group_ad.resource_name") ?? `customers/${ads.customerId}/adGroupAds/${ag}~${ad}` });
  }
  return out;
}

async function requireLive(ads: GoogleAdsClient, pairs: { ad_group_id: string; ad_id: string }[]): Promise<AdInfo[]> {
  const found = await readAds(ads, pairs);
  const missing = pairs.filter((p) => !found.has(adKey(p.ad_group_id, p.ad_id)));
  if (missing.length) {
    throw new ToolError("not_found", `Not found (an ad is identified by both its ad group id and ad id): ${missing.slice(0, 10).map((p) => adKey(p.ad_group_id, p.ad_id)).join(", ")}`);
  }
  const all = pairs.map((p) => found.get(adKey(p.ad_group_id, p.ad_id))!);
  const gone = all.filter((a) => a.status === "REMOVED");
  if (gone.length) throw new ToolError("invalid_argument", `Already removed and cannot be changed: ${gone.slice(0, 10).map((a) => adKey(a.adGroupId, a.adId)).join(", ")}`);
  return all;
}

const adRef = z.object({ ad_group_id: id, ad_id: id });
const uniquePairs = <T extends { ad_group_id: string; ad_id: string }>(xs: T[]) => [...new Map(xs.map((x) => [adKey(x.ad_group_id, x.ad_id), x])).values()].sort((a, b) => adKey(a.ad_group_id, a.ad_id).localeCompare(adKey(b.ad_group_id, b.ad_id)));
const policyNote = (a: AdInfo) => (a.approval && a.approval !== "APPROVED" ? ` [policy: ${a.approval}${a.approval === "DISAPPROVED" ? ": it will not serve until approved" : ""}]` : "");

// --------------------------------------------------------------------------------------------- status tools
function statusTool(name: string, title: string, to: "ENABLED" | "PAUSED", risk: "write" | "high_impact") {
  const verb = to === "PAUSED" ? "Pause" : "Resume";
  return googleWrite({
    name,
    title,
    risk,
    description: `${verb}s one ad after human approval.${to === "ENABLED" ? " Resuming can start spend immediately, so it needs a second approver, and an ad that is disapproved still will not serve." : ""} Removed ads cannot be changed. Confirmed by re-reading the ad's status.`,
    input: z.object({ account_id: accountId, ad_group_id: id, ad_id: id }),
    output: z.object({ ad_group_id: z.string(), ad_id: z.string(), status: z.literal(to), previous_status: z.string() }),
    plan: async (a, ctx) => {
      const [ad] = await requireLive(ctx.services.ads, [a]);
      if (ad!.status === to) throw new ToolError("invalid_argument", `The ad is already ${to.toLowerCase()}.`);
      return { summary: `${verb} ad ${a.ad_id} in ad group ${a.ad_group_id}: ${ad!.status} -> ${to}${to === "ENABLED" ? policyNote(ad!) : ""}`, snapshot: { status: ad!.status } };
    },
    verify: async (a, ctx, run) => {
      const cur = (await readAds(ctx.services.ads, [a])).get(adKey(a.ad_group_id, a.ad_id));
      if (!cur) return { outcome: "indeterminate", detail: "ad not found" };
      if (cur.status === to) return { outcome: "applied" };
      return cur.status === (run.snapshot as { status: string }).status ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: `status is ${cur.status}` };
    },
    execute: async (a, ctx, run) => {
      const ads = ctx.services.ads;
      const [cur] = await requireLive(ads, [a]);
      const before = (run.snapshot as { status: string }).status;
      if (cur!.status !== before) throw new ToolError("conflict", `The ad changed since this was requested (now ${cur!.status}).`);
      await ads.mutate("adGroupAds", [{ update: { resourceName: cur!.resourceName, status: to }, updateMask: "status" }]);
      const after = (await readAds(ads, [a])).get(adKey(a.ad_group_id, a.ad_id));
      if (after?.status !== to) throw new ToolError("unknown_outcome", `Google accepted the request but the ad reads ${after?.status ?? "missing"}.`);
      return { ad_group_id: a.ad_group_id, ad_id: a.ad_id, status: to, previous_status: before } as { ad_group_id: string; ad_id: string; status: typeof to; previous_status: string };
    },
  });
}

export const pauseAd = statusTool("pause_ad", "Pause ad", "PAUSED", "write");
export const resumeAd = statusTool("resume_ad", "Resume ad", "ENABLED", "high_impact");

export const removeAd = googleWrite({
  name: "remove_ad",
  title: "Remove ad",
  risk: "destructive",
  description: "Permanently removes one ad after approval from a second person. A removed ad cannot be restored; a new ad would have to be created and loses its history. To stop an ad temporarily, pause it instead.",
  input: z.object({ account_id: accountId, ad_group_id: id, ad_id: id }),
  output: z.object({ ad_group_id: z.string(), ad_id: z.string(), removed: z.literal(true) }),
  plan: async (a, ctx) => {
    const [ad] = await requireLive(ctx.services.ads, [a]);
    return { summary: `Permanently remove ad ${a.ad_id} from ad group ${a.ad_group_id} (currently ${ad!.status}). This cannot be undone.`, snapshot: { status: ad!.status } };
  },
  verify: async (a, ctx, run) => {
    const cur = (await readAds(ctx.services.ads, [a])).get(adKey(a.ad_group_id, a.ad_id));
    if (!cur || cur.status === "REMOVED") return { outcome: "applied" };
    return cur.status === (run.snapshot as { status: string }).status ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: `status is ${cur.status}` };
  },
  execute: async (a, ctx, run) => {
    const ads = ctx.services.ads;
    const [cur] = await requireLive(ads, [a]);
    if (cur!.status !== (run.snapshot as { status: string }).status) throw new ToolError("conflict", "The ad changed since this was requested.");
    await ads.mutate("adGroupAds", [{ remove: cur!.resourceName }]);
    const after = (await readAds(ads, [a])).get(adKey(a.ad_group_id, a.ad_id));
    if (after && after.status !== "REMOVED") throw new ToolError("unknown_outcome", `Google accepted the request but the ad still reads ${after.status}.`);
    return { ad_group_id: a.ad_group_id, ad_id: a.ad_id, removed: true as const };
  },
});

export const bulkUpdateAdStatus = googleWrite({
  name: "bulk_update_ad_status",
  title: "Pause or enable ads in bulk",
  risk: "high_impact",
  description: "Pauses or enables several ads (each identified by ad group id and ad id) after approval from a second person. Ads already in the requested status are left alone. Enabling can start spend. Applied in one atomic request and confirmed by re-reading.",
  input: z.object({ account_id: accountId, ads: z.array(adRef).min(1).max(50), status: z.enum(["ENABLED", "PAUSED"]) }),
  output: z.object({ updated: z.number(), ads: z.array(adRef), status: z.string() }),
  plan: async (a, ctx) => {
    const pairs = uniquePairs(a.ads);
    const live = await requireLive(ctx.services.ads, pairs);
    const changing = live.filter((x) => x.status !== a.status);
    if (!changing.length) throw new ToolError("invalid_argument", `All of these ads are already ${a.status.toLowerCase()}.`);
    const warn = a.status === "ENABLED" ? changing.filter((x) => x.approval && x.approval !== "APPROVED").length : 0;
    return { summary: `Set ${changing.length} ad(s) to ${a.status}${changing.length < pairs.length ? ` (${pairs.length - changing.length} already ${a.status.toLowerCase()})` : ""}: ${changing.slice(0, 10).map((x) => adKey(x.adGroupId, x.adId)).join(", ")}${changing.length > 10 ? ", …" : ""}${warn ? `. ${warn} of them are not policy-approved and will not serve until approved` : ""}`, snapshot: { changing: changing.map((x) => adKey(x.adGroupId, x.adId)).sort() } };
  },
  verify: async (a, ctx, run) => {
    const { changing } = run.snapshot as { changing: string[] };
    const now = await readAds(ctx.services.ads, uniquePairs(a.ads));
    const done = changing.filter((k) => now.get(k)?.status === a.status).length;
    return done === changing.length ? { outcome: "applied" } : done === 0 ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: `${done} of ${changing.length} updated` };
  },
  execute: async (a, ctx, run) => {
    const ads = ctx.services.ads;
    const pairs = uniquePairs(a.ads);
    const live = await requireLive(ads, pairs);
    const changing = live.filter((x) => x.status !== a.status);
    const keys = changing.map((x) => adKey(x.adGroupId, x.adId)).sort();
    if (JSON.stringify(keys) !== JSON.stringify((run.snapshot as { changing: string[] }).changing)) throw new ToolError("conflict", "The ads changed since this was requested.");
    await ads.mutate("adGroupAds", changing.map((x) => ({ update: { resourceName: x.resourceName, status: a.status }, updateMask: "status" })));
    const after = await readAds(ads, pairs);
    if (changing.some((x) => after.get(adKey(x.adGroupId, x.adId))?.status !== a.status)) throw new ToolError("unknown_outcome", "Google accepted the request but some ads do not read back as requested.");
    return { updated: changing.length, ads: changing.map((x) => ({ ad_group_id: x.adGroupId, ad_id: x.adId })), status: a.status };
  },
});

// ------------------------------------------------------------------------------------------------- reads
const scopeFilters = { campaign_id: id.optional(), ad_group_id: id.optional() };

export const getAdCreative = googleRead({
  name: "get_ad_creative",
  title: "Get ad creative",
  description: "Shows the content of ads: type, status, ad strength, final URLs and, for responsive search ads, the headlines, descriptions and display paths (with any pinning). Removed ads are excluded. Ad text comes from the account and is returned as data. Fetched live from Google Ads.",
  input: z.object({ account_id: accountId, ...scopeFilters, ad_ids: z.array(id).max(50).optional(), limit: z.number().int().min(1).max(200).default(50) }),
  output: z.object({
    ads: z.array(z.object({ ad_group_id: z.string().nullable(), ad_id: z.string().min(1), status: z.string().nullable(), type: z.string().nullable(), ad_strength: z.string().nullable(), final_urls: z.array(z.string()), headlines: z.array(z.object({ text: z.string(), pinned_field: z.string().nullable() })), descriptions: z.array(z.object({ text: z.string(), pinned_field: z.string().nullable() })), path1: z.string().nullable(), path2: z.string().nullable() })),
    returned: z.number(),
    truncated: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const q = new Gaql()
      .select("ad_group.id", "ad_group_ad.ad.id", "ad_group_ad.status", "ad_group_ad.ad.type", "ad_group_ad.ad_strength", "ad_group_ad.ad.final_urls", "ad_group_ad.ad.responsive_search_ad.headlines", "ad_group_ad.ad.responsive_search_ad.descriptions", "ad_group_ad.ad.responsive_search_ad.path1", "ad_group_ad.ad.responsive_search_ad.path2")
      .from("ad_group_ad")
      .where("ad_group_ad.status != 'REMOVED'")
      .where(a.campaign_id && `campaign.id = ${lit.id(a.campaign_id)}`)
      .where(a.ad_group_id && `ad_group.id = ${lit.id(a.ad_group_id)}`)
      .where(a.ad_ids?.length ? `ad_group_ad.ad.id IN ${lit.list(a.ad_ids.map(lit.id))}` : undefined)
      .orderBy("ad_group_ad.ad.id")
      .limit(a.limit + 1);
    const rows = await ctx.services.ads.query(q, { maxRows: a.limit + 1 });
    const assets = (v: unknown) => ((v as { text?: string; pinnedField?: string }[] | undefined) ?? []).filter((x) => typeof x.text === "string").map((x) => ({ text: String(x.text), pinned_field: x.pinnedField ? String(x.pinnedField) : null }));
    return {
      ads: rows.slice(0, a.limit).map((r) => ({
        ad_group_id: str(r, "ad_group.id"), ad_id: String(pick(r, "ad_group_ad.ad.id") ?? ""), status: str(r, "ad_group_ad.status"), type: str(r, "ad_group_ad.ad.type"), ad_strength: str(r, "ad_group_ad.ad_strength"),
        final_urls: ((pick(r, "ad_group_ad.ad.final_urls") as string[] | undefined) ?? []).map(String),
        headlines: assets(pick(r, "ad_group_ad.ad.responsive_search_ad.headlines")), descriptions: assets(pick(r, "ad_group_ad.ad.responsive_search_ad.descriptions")),
        path1: str(r, "ad_group_ad.ad.responsive_search_ad.path1"), path2: str(r, "ad_group_ad.ad.responsive_search_ad.path2"),
      })),
      returned: Math.min(rows.length, a.limit),
      truncated: rows.length > a.limit,
    };
  },
});

const perf = z.object({ impressions: z.number(), clicks: z.number(), cost: Money, conversions: z.number(), conversion_value: z.number(), ctr: z.number().nullable(), average_cpc: Money.nullable(), cost_per_conversion: Money.nullable(), roas: z.number().nullable() });
const calc = (impressions: number, clicks: number, cost: number, conversions: number, value: number) => ({ impressions, clicks, cost: round(cost, 2)!, conversions, conversion_value: round(value, 2)!, ctr: round(ratio(clicks, impressions)), average_cpc: round(ratio(cost, clicks), 2), cost_per_conversion: round(ratio(cost, conversions), 2), roas: round(ratio(value, cost)) });

export const getAdPerformance = googleRead({
  name: "get_ad_performance",
  title: "Ad performance",
  description: "Ad-level performance for a period: impressions, clicks, cost, conversions, conversion value, and CTR, average CPC, cost per conversion and ROAS calculated from those figures. Fetched live from Google Ads; ratios are null when their denominator is zero.",
  input: z.object({ account_id: accountId, ...dateFields, ...scopeFilters, order_by: z.enum(["cost", "clicks", "conversions", "impressions"]).default("cost"), limit: z.number().int().min(1).max(200).default(50) }).refine(datesOk, datesMsg),
  output: z.object({ period: z.string(), ads: z.array(perf.extend({ ad_group_id: z.string().nullable(), ad_id: z.string().min(1), status: z.string().nullable() })), totals: perf.describe("Over every matching ad, not only the returned ones (see totals_scope)."), totals_scope: z.enum(["all_matching", "first_10000_ads"]), returned: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const order = { cost: "metrics.cost_micros", clicks: "metrics.clicks", conversions: "metrics.conversions", impressions: "metrics.impressions" }[a.order_by];
    const q = new Gaql()
      .select("ad_group.id", "ad_group_ad.ad.id", "ad_group_ad.status", "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value")
      .from("ad_group_ad")
      .where("ad_group_ad.status != 'REMOVED'")
      .where(dateClause(a))
      .where(a.campaign_id && `campaign.id = ${lit.id(a.campaign_id)}`)
      .where(a.ad_group_id && `ad_group.id = ${lit.id(a.ad_group_id)}`)
      .orderBy(order, "DESC")
      .limit(a.limit + 1);
    const rows = await ctx.services.ads.query(q, { maxRows: a.limit + 1 });
    const shown = rows.slice(0, a.limit).map((r) => ({ ad_group_id: str(r, "ad_group.id"), ad_id: String(pick(r, "ad_group_ad.ad.id") ?? ""), status: str(r, "ad_group_ad.status"), ...calc(num(pick(r, "metrics.impressions")), num(pick(r, "metrics.clicks")), fromMicros(pick(r, "metrics.cost_micros")), num(pick(r, "metrics.conversions")), num(pick(r, "metrics.conversions_value"))) }));
    const truncated = rows.length > a.limit;
    // Totals cover every matching ad, not only the page shown (up to the client's 10,000-row cap).
    let all = rows;
    if (truncated) {
      const tq = new Gaql()
        .select("ad_group_ad.ad.id", "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value")
        .from("ad_group_ad")
        .where("ad_group_ad.status != 'REMOVED'")
        .where(dateClause(a))
        .where(a.campaign_id && `campaign.id = ${lit.id(a.campaign_id)}`)
        .where(a.ad_group_id && `ad_group.id = ${lit.id(a.ad_group_id)}`)
        .limit(10_000);
      all = await ctx.services.ads.query(tq, { maxRows: 10_000 });
    }
    const tot = (f: string, micros = false) => all.reduce((s, r) => s + (micros ? fromMicros(pick(r, f)) : num(pick(r, f))), 0);
    return {
      period: a.start_date && a.end_date ? `${a.start_date}..${a.end_date}` : a.date_range,
      ads: shown,
      totals: calc(tot("metrics.impressions"), tot("metrics.clicks"), tot("metrics.cost_micros", true), tot("metrics.conversions"), tot("metrics.conversions_value")),
      totals_scope: all.length >= 10_000 ? ("first_10000_ads" as const) : ("all_matching" as const),
      returned: shown.length,
      truncated,
    };
  },
});

export const adTools = [getAdCreative, getAdPerformance, pauseAd, resumeAd, removeAd, bulkUpdateAdStatus];
