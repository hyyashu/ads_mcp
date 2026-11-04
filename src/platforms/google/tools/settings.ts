import { moneyChange, textChange } from "../../../policy/change-set";
import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { GoogleAdsClient } from "../client";
import { Gaql, fromMicros, isRealDate, lit, num, pick } from "../gaql";
import { Money, accountId, campaignIds, googleRead, googleWrite, idSchema as id, str, toMicros } from "./common";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").refine(isRealDate, "not a real date");

// Campaign start/end are `start_date_time` / `end_date_time`, "yyyy-MM-dd HH:mm:ss" in the account's time zone
// (Google Ads API v26 Campaign reference). Daily granularity: 00:00:00 for start, 23:59:59 for end.
const startOf = (d: string) => `${d} 00:00:00`;
const endOf = (d: string) => `${d} 23:59:59`;

async function campaign(ads: GoogleAdsClient, campaignId: string) {
  const q = new Gaql()
    .select("campaign.id", "campaign.name", "campaign.status", "campaign.resource_name", "campaign.start_date_time", "campaign.end_date_time", "campaign.campaign_budget", "campaign_budget.amount_micros", "campaign_budget.explicitly_shared", "campaign_budget.resource_name")
    .from("campaign")
    .where(`campaign.id = ${lit.id(campaignId)}`)
    .limit(1);
  const [r] = await ads.query(q, { maxRows: 1 });
  if (!r || pick(r, "campaign.status") === undefined) throw new ToolError("not_found", `No campaign ${campaignId} in this account.`);
  if (pick(r, "campaign.status") === "REMOVED") throw new ToolError("invalid_argument", "The campaign is removed and cannot be changed.");
  return {
    name: str(r, "campaign.name"),
    resourceName: String(pick(r, "campaign.resource_name") ?? `customers/${ads.customerId}/campaigns/${campaignId}`),
    start: str(r, "campaign.start_date_time"),
    end: str(r, "campaign.end_date_time"),
    budgetResource: str(r, "campaign.campaign_budget") ?? str(r, "campaign_budget.resource_name"),
    budget: pick(r, "campaign_budget.amount_micros") === undefined ? null : fromMicros(pick(r, "campaign_budget.amount_micros")),
    budgetShared: pick(r, "campaign_budget.explicitly_shared") === true,
  };
}

// ------------------------------------------------------------------------------------------ get_campaign_dates
export const getCampaignDates = googleRead({
  name: "get_campaign_dates",
  title: "Campaign start and end dates",
  description: "Shows when campaigns start and end. Google stores these as date-times in the account's time zone (yyyy-MM-dd HH:mm:ss); an empty end means the campaign runs indefinitely.",
  input: z.object({ account_id: accountId, campaign_ids: campaignIds.optional(), limit: z.number().int().min(1).max(500).default(200) }),
  output: z.object({ campaigns: z.array(z.object({ campaign_id: z.string().min(1), name: z.string().nullable(), status: z.string().nullable(), start_date_time: z.string().nullable(), end_date_time: z.string().nullable() })), returned: z.number() }),
  handler: async (a, ctx) => {
    const q = new Gaql()
      .select("campaign.id", "campaign.name", "campaign.status", "campaign.start_date_time", "campaign.end_date_time")
      .from("campaign")
      .where("campaign.status != 'REMOVED'")
      .where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined)
      .orderBy("campaign.id")
      .limit(a.limit);
    const rows = await ctx.services.ads.query(q, { maxRows: a.limit });
    return { campaigns: rows.map((r) => ({ campaign_id: String(pick(r, "campaign.id") ?? ""), name: str(r, "campaign.name"), status: str(r, "campaign.status"), start_date_time: str(r, "campaign.start_date_time"), end_date_time: str(r, "campaign.end_date_time") })), returned: rows.length };
  },
});

// --------------------------------------------------------------------------------------- update_campaign_dates
export const updateCampaignDates = googleWrite({
  name: "update_campaign_dates",
  title: "Update campaign dates",
  risk: "high_impact",
  description: "Changes a campaign's start and/or end date after approval from a second person. Dates are whole days in the account's time zone. Pass clear_end_date to make the campaign run indefinitely. Confirmed by re-reading the campaign.",
  input: z.object({ account_id: accountId, campaign_id: id, start_date: dateOnly.optional(), end_date: dateOnly.optional(), clear_end_date: z.boolean().default(false) }).refine((v) => v.start_date || v.end_date || v.clear_end_date, "give start_date, end_date or clear_end_date").refine((v) => !(v.end_date && v.clear_end_date), "end_date and clear_end_date conflict").refine((v) => !(v.start_date && v.end_date) || v.start_date <= v.end_date, "start_date must not be after end_date"),
  output: z.object({ campaign_id: z.string(), start_date_time: z.string().nullable(), end_date_time: z.string().nullable() }),
  plan: async (a, ctx) => {
    const c = await campaign(ctx.services.ads, a.campaign_id);
    const newStart = a.start_date ? startOf(a.start_date) : c.start;
    const newEnd = a.clear_end_date ? null : a.end_date ? endOf(a.end_date) : c.end;
    if (newStart && newEnd && newStart > newEnd) throw new ToolError("invalid_argument", "The end would be before the start.");
    if (newStart === c.start && newEnd === c.end) throw new ToolError("invalid_argument", "The campaign already has these dates.");
    return { summary: `Campaign "${c.name ?? a.campaign_id}": start ${c.start ?? "none"} -> ${newStart ?? "none"}; end ${c.end ?? "none (indefinite)"} -> ${newEnd ?? "none (indefinite)"}`, snapshot: { start: c.start, end: c.end } };
  },
  verify: async (a, ctx, run) => {
    const c = await campaign(ctx.services.ads, a.campaign_id);
    const before = run.snapshot as { start: string | null; end: string | null };
    const want = { start: a.start_date ? startOf(a.start_date) : before.start, end: a.clear_end_date ? null : a.end_date ? endOf(a.end_date) : before.end };
    if (c.start === want.start && c.end === want.end) return { outcome: "applied" };
    if (c.start === before.start && c.end === before.end) return { outcome: "not_applied" };
    return { outcome: "indeterminate", detail: "dates match neither the old nor the requested values" };
  },
  execute: async (a, ctx, run) => {
    const c = await campaign(ctx.services.ads, a.campaign_id);
    const before = run.snapshot as { start: string | null; end: string | null };
    if (c.start !== before.start || c.end !== before.end) throw new ToolError("conflict", "The campaign dates changed since this was requested.");
    const update: Record<string, unknown> = { resourceName: c.resourceName };
    const mask: string[] = [];
    if (a.start_date) (update.startDateTime = startOf(a.start_date)), mask.push("start_date_time");
    if (a.end_date) (update.endDateTime = endOf(a.end_date)), mask.push("end_date_time");
    if (a.clear_end_date) mask.push("end_date_time"); // in the mask but absent from the body: cleared
    await ctx.services.ads.mutate("campaigns", [{ update, updateMask: mask.join(",") }]);
    const after = await campaign(ctx.services.ads, a.campaign_id);
    const wantStart = a.start_date ? startOf(a.start_date) : before.start;
    const wantEnd = a.clear_end_date ? null : a.end_date ? endOf(a.end_date) : before.end;
    if (after.start !== wantStart || after.end !== wantEnd) throw new ToolError("unknown_outcome", "Google accepted the request but the campaign dates do not read back as requested.");
    return { campaign_id: a.campaign_id, start_date_time: after.start, end_date_time: after.end };
  },
});

// ------------------------------------------------------------------------------------------- update_campaign
export const updateCampaign = googleWrite({
  name: "update_campaign",
  title: "Update campaign",
  risk: "high_impact",
  description: "Renames a campaign and/or changes its daily budget after approval. Raising the budget needs a second approver; lowering it or renaming does not. A budget shared by several campaigns is refused, because changing it would change the other campaigns too. Name and budget are applied in one atomic request and confirmed by re-reading.",
  input: z.object({ account_id: accountId, campaign_id: id, name: z.string().min(1).max(255).regex(/^[^\u0000\n\r]+$/, "no line breaks").optional(), daily_budget: z.number().positive().max(10_000_000).optional().describe("Daily budget in the account's currency.") }).refine((v) => v.name !== undefined || v.daily_budget !== undefined, "give name and/or daily_budget"),
  output: z.object({ campaign_id: z.string(), name: z.string().nullable(), daily_budget: Money.nullable() }),
  plan: async (a, ctx) => {
    const c = await campaign(ctx.services.ads, a.campaign_id);
    if (a.daily_budget !== undefined) {
      if (c.budgetShared) throw new ToolError("invalid_argument", "This campaign uses a shared budget. Changing it would affect other campaigns, so it is not supported here.");
      if (!c.budgetResource || c.budget === null) throw new ToolError("invalid_argument", "The campaign's budget could not be read.");
    }
    const parts: string[] = [];
    if (a.name !== undefined && a.name !== c.name) parts.push(`name "${c.name}" -> "${a.name}"`);
    if (a.daily_budget !== undefined && toMicros(a.daily_budget) !== toMicros(c.budget ?? 0)) parts.push(`daily budget ${c.budget} -> ${a.daily_budget}`);
    if (!parts.length) throw new ToolError("invalid_argument", "Nothing would change.");
    const ref = { resource: "campaign", id: a.campaign_id, name: c.name };
    const changes = [
      ...(a.name !== undefined && a.name !== c.name ? [textChange(ref, "name", c.name, a.name)] : []),
      ...(a.daily_budget !== undefined && toMicros(a.daily_budget) !== toMicros(c.budget ?? 0) ? [moneyChange(ref, "daily_budget", c.budget === null ? null : toMicros(c.budget), toMicros(a.daily_budget))] : []),
    ];
    return { summary: `Campaign ${a.campaign_id}: ${parts.join("; ")}`, snapshot: { name: c.name, budget: c.budget }, changes };
  },
  verify: async (a, ctx, run) => {
    const c = await campaign(ctx.services.ads, a.campaign_id);
    const before = run.snapshot as { name: string | null; budget: number | null };
    const nameDone = a.name === undefined || c.name === a.name;
    const budgetDone = a.daily_budget === undefined || (c.budget !== null && toMicros(c.budget) === toMicros(a.daily_budget));
    if (nameDone && budgetDone) return { outcome: "applied" };
    const nameUntouched = a.name === undefined || c.name === before.name;
    const budgetUntouched = a.daily_budget === undefined || c.budget === before.budget;
    return nameUntouched && budgetUntouched ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: "only part of the change is visible" };
  },
  execute: async (a, ctx, run) => {
    const c = await campaign(ctx.services.ads, a.campaign_id);
    const before = run.snapshot as { name: string | null; budget: number | null };
    if (c.name !== before.name || c.budget !== before.budget) throw new ToolError("conflict", "The campaign changed since this was requested.");
    const ops: Record<string, unknown>[] = [];
    if (a.name !== undefined && a.name !== c.name) ops.push({ campaignOperation: { update: { resourceName: c.resourceName, name: a.name }, updateMask: "name" } });
    if (a.daily_budget !== undefined && c.budgetResource) ops.push({ campaignBudgetOperation: { update: { resourceName: c.budgetResource, amountMicros: String(toMicros(a.daily_budget)) }, updateMask: "amount_micros" } });
    await ctx.services.ads.mutateBatch(ops); // one atomic request: both changes or neither
    const after = await campaign(ctx.services.ads, a.campaign_id);
    const ok = (a.name === undefined || after.name === a.name) && (a.daily_budget === undefined || (after.budget !== null && toMicros(after.budget) === toMicros(a.daily_budget)));
    if (!ok) throw new ToolError("unknown_outcome", "Google accepted the request but the campaign does not read back as requested.");
    return { campaign_id: a.campaign_id, name: after.name, daily_budget: after.budget };
  },
});

// --------------------------------------------------------------------------------------- ad group settings
async function adGroup(ads: GoogleAdsClient, adGroupId: string) {
  const q = new Gaql().select("ad_group.id", "ad_group.name", "ad_group.status", "ad_group.resource_name", "ad_group.cpc_bid_micros", "ad_group.target_cpa_micros").from("ad_group").where(`ad_group.id = ${lit.id(adGroupId)}`).limit(1);
  const [r] = await ads.query(q, { maxRows: 1 });
  if (!r || pick(r, "ad_group.status") === undefined) throw new ToolError("not_found", `No ad group ${adGroupId} in this account.`);
  if (pick(r, "ad_group.status") === "REMOVED") throw new ToolError("invalid_argument", "The ad group is removed and cannot be changed.");
  const micros = (f: string) => (pick(r, f) === undefined ? null : num(pick(r, f)));
  return { name: str(r, "ad_group.name"), resourceName: String(pick(r, "ad_group.resource_name") ?? `customers/${ads.customerId}/adGroups/${adGroupId}`), cpcMicros: micros("ad_group.cpc_bid_micros"), targetCpaMicros: micros("ad_group.target_cpa_micros") };
}

export const getAdGroupSettings = googleRead({
  name: "get_ad_group_settings",
  title: "Ad group settings",
  description: "Shows ad group name, status, type, bids, tracking template and final URL suffix. Bids apply only under matching bidding strategies (see Google's AdGroup reference).",
  input: z.object({ account_id: accountId, campaign_id: id.optional(), ad_group_ids: z.array(id).max(50).optional(), limit: z.number().int().min(1).max(500).default(200) }),
  output: z.object({ ad_groups: z.array(z.object({ ad_group_id: z.string().min(1), campaign_id: z.string().nullable(), name: z.string().nullable(), status: z.string().nullable(), type: z.string().nullable(), cpc_bid: Money.nullable(), cpv_bid: Money.nullable(), target_cpa: Money.nullable(), tracking_url_template: z.string().nullable(), final_url_suffix: z.string().nullable() })), returned: z.number() }),
  handler: async (a, ctx) => {
    const q = new Gaql()
      .select("ad_group.id", "campaign.id", "ad_group.name", "ad_group.status", "ad_group.type", "ad_group.cpc_bid_micros", "ad_group.cpv_bid_micros", "ad_group.target_cpa_micros", "ad_group.tracking_url_template", "ad_group.final_url_suffix")
      .from("ad_group")
      .where("ad_group.status != 'REMOVED'")
      .where(a.campaign_id && `campaign.id = ${lit.id(a.campaign_id)}`)
      .where(a.ad_group_ids?.length ? `ad_group.id IN ${lit.list(a.ad_group_ids.map(lit.id))}` : undefined)
      .orderBy("ad_group.id")
      .limit(a.limit);
    const rows = await ctx.services.ads.query(q, { maxRows: a.limit });
    const money = (r: Record<string, unknown>, f: string) => (pick(r, f) === undefined ? null : fromMicros(pick(r, f)));
    return { ad_groups: rows.map((r) => ({ ad_group_id: String(pick(r, "ad_group.id") ?? ""), campaign_id: str(r, "campaign.id"), name: str(r, "ad_group.name"), status: str(r, "ad_group.status"), type: str(r, "ad_group.type"), cpc_bid: money(r, "ad_group.cpc_bid_micros"), cpv_bid: money(r, "ad_group.cpv_bid_micros"), target_cpa: money(r, "ad_group.target_cpa_micros"), tracking_url_template: str(r, "ad_group.tracking_url_template"), final_url_suffix: str(r, "ad_group.final_url_suffix") })), returned: rows.length };
  },
});

export const updateAdGroupSettings = googleWrite({
  name: "update_ad_group_settings",
  title: "Update ad group settings",
  risk: "write",
  description: "Renames an ad group and/or changes its max CPC bid or target CPA after approval. Raising a bid or target CPA needs a second approver. The bid only takes effect under bidding strategies that use it. Confirmed by re-reading the ad group.",
  input: z.object({ account_id: accountId, ad_group_id: id, name: z.string().min(1).max(255).regex(/^[^\u0000\n\r]+$/, "no line breaks").optional(), cpc_bid: z.number().positive().max(10_000).optional().describe("Max CPC in the account's currency."), target_cpa: z.number().positive().max(1_000_000).optional().describe("Target CPA in the account's currency.") }).refine((v) => v.name !== undefined || v.cpc_bid !== undefined || v.target_cpa !== undefined, "give at least one setting"),
  output: z.object({ ad_group_id: z.string(), name: z.string().nullable(), cpc_bid: Money.nullable(), target_cpa: Money.nullable() }),
  plan: async (a, ctx) => {
    const g = await adGroup(ctx.services.ads, a.ad_group_id);
    const parts: string[] = [];
    if (a.name !== undefined && a.name !== g.name) parts.push(`name "${g.name}" -> "${a.name}"`);
    if (a.cpc_bid !== undefined && toMicros(a.cpc_bid) !== g.cpcMicros) parts.push(`max CPC ${g.cpcMicros === null ? "unset" : g.cpcMicros / 1e6} -> ${a.cpc_bid}`);
    if (a.target_cpa !== undefined && toMicros(a.target_cpa) !== g.targetCpaMicros) parts.push(`target CPA ${g.targetCpaMicros === null ? "unset" : g.targetCpaMicros / 1e6} -> ${a.target_cpa}`);
    if (!parts.length) throw new ToolError("invalid_argument", "Nothing would change.");
    const ref = { resource: "ad_group", id: a.ad_group_id, name: g.name };
    const changes = [
      ...(a.name !== undefined && a.name !== g.name ? [textChange(ref, "name", g.name, a.name)] : []),
      ...(a.cpc_bid !== undefined && toMicros(a.cpc_bid) !== g.cpcMicros ? [moneyChange(ref, "cpc_bid", g.cpcMicros, toMicros(a.cpc_bid))] : []),
      // A higher target CPA lets automated bidding pay more per conversion, so it counts as a spend increase.
      ...(a.target_cpa !== undefined && toMicros(a.target_cpa) !== g.targetCpaMicros ? [moneyChange(ref, "target_cpa", g.targetCpaMicros, toMicros(a.target_cpa))] : []),
    ];
    return { summary: `Ad group "${g.name ?? a.ad_group_id}": ${parts.join("; ")}`, snapshot: { name: g.name, cpc: g.cpcMicros, cpa: g.targetCpaMicros }, changes };
  },
  verify: async (a, ctx, run) => {
    const g = await adGroup(ctx.services.ads, a.ad_group_id);
    const b = run.snapshot as { name: string | null; cpc: number | null; cpa: number | null };
    const done = (a.name === undefined || g.name === a.name) && (a.cpc_bid === undefined || g.cpcMicros === toMicros(a.cpc_bid)) && (a.target_cpa === undefined || g.targetCpaMicros === toMicros(a.target_cpa));
    if (done) return { outcome: "applied" };
    return g.name === b.name && g.cpcMicros === b.cpc && g.targetCpaMicros === b.cpa ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: "only part of the change is visible" };
  },
  execute: async (a, ctx, run) => {
    const g = await adGroup(ctx.services.ads, a.ad_group_id);
    const b = run.snapshot as { name: string | null; cpc: number | null; cpa: number | null };
    if (g.name !== b.name || g.cpcMicros !== b.cpc || g.targetCpaMicros !== b.cpa) throw new ToolError("conflict", "The ad group changed since this was requested.");
    const update: Record<string, unknown> = { resourceName: g.resourceName };
    const mask: string[] = [];
    if (a.name !== undefined) (update.name = a.name), mask.push("name");
    if (a.cpc_bid !== undefined) (update.cpcBidMicros = String(toMicros(a.cpc_bid))), mask.push("cpc_bid_micros");
    if (a.target_cpa !== undefined) (update.targetCpaMicros = String(toMicros(a.target_cpa))), mask.push("target_cpa_micros");
    await ctx.services.ads.mutate("adGroups", [{ update, updateMask: mask.join(",") }]);
    const after = await adGroup(ctx.services.ads, a.ad_group_id);
    const ok = (a.name === undefined || after.name === a.name) && (a.cpc_bid === undefined || after.cpcMicros === toMicros(a.cpc_bid)) && (a.target_cpa === undefined || after.targetCpaMicros === toMicros(a.target_cpa));
    if (!ok) throw new ToolError("unknown_outcome", "Google accepted the request but the ad group does not read back as requested.");
    return { ad_group_id: a.ad_group_id, name: after.name, cpc_bid: after.cpcMicros === null ? null : after.cpcMicros / 1e6, target_cpa: after.targetCpaMicros === null ? null : after.targetCpaMicros / 1e6 };
  },
});

export const settingsTools = [getCampaignDates, updateCampaignDates, updateCampaign, getAdGroupSettings, updateAdGroupSettings];
