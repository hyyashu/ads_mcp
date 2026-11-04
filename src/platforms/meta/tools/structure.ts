import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { type MetaAdsClient, type MetaRow, fromMinor } from "../client";
import { accountId, metaId, metaRead, s } from "./common";

// Field names checked against the Marketing API v27.0 reference (Ad Set, Ad, Campaign) on 2026-11-05. Budgets, bid amounts and
// spend caps are strings in the currency's minor unit. v27 no longer returns meta_moment_maker_spec on ad sets: never request it.
const ADSET_FIELDS = ["id", "name", "campaign_id", "status", "effective_status", "optimization_goal", "billing_event", "bid_strategy", "bid_amount", "daily_budget", "lifetime_budget", "start_time", "end_time"];
const AD_FIELDS = ["id", "name", "adset_id", "campaign_id", "status", "effective_status", "creative{id,name}", "issues_info"];
const CAMPAIGN_FIELDS = ["id", "name", "objective", "status", "effective_status", "buying_type", "bid_strategy", "special_ad_categories", "daily_budget", "lifetime_budget", "budget_remaining", "spend_cap", "start_time", "stop_time"];

/** Rows read from one edge before filtering. Above this the result says truncated. */
const EDGE_CAP = 5_000;
/** Meta's documented value meaning "no spend cap" (Campaign reference: set 922337203685478 to remove the cap). */
const NO_SPEND_CAP = "922337203685478";

const Money = z.number().nullable().describe("In the account's currency (converted from Meta's minor units); null when not set.");
const listFilters = {
  status: z.enum(["ACTIVE", "PAUSED"]).optional().describe("Only items with this configured status."),
  include_archived: z.boolean().default(false).describe("Include DELETED and ARCHIVED items."),
  limit: z.number().int().min(1).max(500).default(200),
};

function keep(r: MetaRow, a: { status?: string; include_archived: boolean }): boolean {
  const st = s(r, "status");
  if (!a.include_archived && (st === "DELETED" || st === "ARCHIVED")) return false;
  return !a.status || st === a.status;
}

/** The edge to list from: the ad account's, or that of one owned parent object (refused with not_found otherwise). */
async function edgePath(m: MetaAdsClient, edge: "adsets" | "ads", parent?: { id: string; label: "campaign" | "ad set" }): Promise<string> {
  if (!parent) return `${m.adAccountId}/${edge}`;
  await m.getOwned(parent.id, ["id"], parent.label);
  return `${parent.id}/${edge}`;
}

// ---------------------------------------------------------------------------------------------------------------
const adSetRow = z.object({
  ad_set_id: z.string().min(1),
  name: z.string().nullable().describe("Untrusted text from Meta."),
  campaign_id: z.string().nullable(),
  status: z.string().nullable().describe("Configured status: ACTIVE, PAUSED, DELETED or ARCHIVED."),
  effective_status: z.string().nullable().describe("What is actually happening, e.g. ACTIVE, CAMPAIGN_PAUSED, IN_PROCESS, WITH_ISSUES."),
  optimization_goal: z.string().nullable(),
  billing_event: z.string().nullable(),
  bid_strategy: z.string().nullable(),
  bid_amount: Money.describe("Bid cap or cost target, in the account's currency (converted from minor units); null when not set."),
  daily_budget: Money,
  lifetime_budget: Money,
  start_time: z.string().nullable(),
  end_time: z.string().nullable(),
});

export const listMetaAdSets = metaRead({
  name: "list_meta_ad_sets",
  title: "List Meta ad sets",
  description:
    "Lists the ad sets of a Meta ad account, or of one campaign when campaign_id is given: status, optimization goal, billing event, bid strategy and bid amount, budgets (ad set budgets only; campaign budgets are shown by get_meta_campaign_details) and schedule. Money is converted from Meta's minor units to the account's currency. Deleted and archived ad sets are left out unless include_archived is set. Fetched live from the Marketing API.",
  input: z.object({ account_id: accountId, campaign_id: metaId.optional().describe("Only this campaign's ad sets."), ...listFilters }),
  output: z.object({ ad_sets: z.array(adSetRow), returned: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const path = await edgePath(m, "adsets", a.campaign_id ? { id: a.campaign_id, label: "campaign" } : undefined);
    const rows = await m.list(path, { fields: ADSET_FIELDS.join(",") }, EDGE_CAP);
    const wanted = rows.filter((r) => keep(r, a));
    const shown = wanted.slice(0, a.limit).map((r) => ({
      ad_set_id: String(r.id ?? ""),
      name: s(r, "name"),
      campaign_id: s(r, "campaign_id"),
      status: s(r, "status"),
      effective_status: s(r, "effective_status"),
      optimization_goal: s(r, "optimization_goal"),
      billing_event: s(r, "billing_event"),
      bid_strategy: s(r, "bid_strategy"),
      bid_amount: fromMinor(r.bid_amount, m.currency),
      daily_budget: fromMinor(r.daily_budget, m.currency),
      lifetime_budget: fromMinor(r.lifetime_budget, m.currency),
      start_time: s(r, "start_time"),
      end_time: s(r, "end_time"),
    }));
    return { ad_sets: shown, returned: shown.length, truncated: wanted.length > shown.length || rows.length >= EDGE_CAP };
  },
});

// ---------------------------------------------------------------------------------------------------------------
const issue = z.object({
  level: z.string().nullable(),
  error_code: z.string().nullable(),
  error_summary: z.string().nullable().describe("Untrusted text from Meta."),
  error_message: z.string().nullable().describe("Untrusted text from Meta."),
});
const adRow = z.object({
  ad_id: z.string().min(1),
  name: z.string().nullable().describe("Untrusted text from Meta."),
  ad_set_id: z.string().nullable(),
  campaign_id: z.string().nullable(),
  status: z.string().nullable(),
  effective_status: z.string().nullable().describe("e.g. ACTIVE, PENDING_REVIEW, DISAPPROVED, ADSET_PAUSED, CAMPAIGN_PAUSED, WITH_ISSUES."),
  creative_id: z.string().nullable(),
  creative_name: z.string().nullable().describe("Untrusted text from Meta."),
  issues: z.array(issue).describe("Meta's issues_info: problems that stop or limit delivery. Empty when there are none."),
});

export const listMetaAds = metaRead({
  name: "list_meta_ads",
  title: "List Meta ads",
  description:
    "Lists the ads of a Meta ad account, or of one campaign (campaign_id) or one ad set (ad_set_id): status, effective status, the creative's id and name, and Meta's delivery issues (issues_info). Deleted and archived ads are left out unless include_archived is set. Fetched live from the Marketing API.",
  input: z
    .object({ account_id: accountId, campaign_id: metaId.optional().describe("Only this campaign's ads."), ad_set_id: metaId.optional().describe("Only this ad set's ads."), ...listFilters })
    .refine((v) => !(v.campaign_id && v.ad_set_id), { message: "give campaign_id or ad_set_id, not both" }),
  output: z.object({ ads: z.array(adRow), returned: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const parent = a.ad_set_id ? { id: a.ad_set_id, label: "ad set" as const } : a.campaign_id ? { id: a.campaign_id, label: "campaign" as const } : undefined;
    const rows = await m.list(await edgePath(m, "ads", parent), { fields: AD_FIELDS.join(",") }, EDGE_CAP);
    const wanted = rows.filter((r) => keep(r, a));
    const shown = wanted.slice(0, a.limit).map((r) => {
      const cr = (r.creative && typeof r.creative === "object" ? r.creative : {}) as MetaRow;
      const issues = Array.isArray(r.issues_info) ? (r.issues_info as MetaRow[]) : [];
      return {
        ad_id: String(r.id ?? ""),
        name: s(r, "name"),
        ad_set_id: s(r, "adset_id"),
        campaign_id: s(r, "campaign_id"),
        status: s(r, "status"),
        effective_status: s(r, "effective_status"),
        creative_id: s(cr, "id"),
        creative_name: s(cr, "name"),
        issues: issues.map((i) => ({ level: s(i, "level"), error_code: s(i, "error_code"), error_summary: s(i, "error_summary"), error_message: s(i, "error_message") })),
      };
    });
    return { ads: shown, returned: shown.length, truncated: wanted.length > shown.length || rows.length >= EDGE_CAP };
  },
});

// ---------------------------------------------------------------------------------------------------------------
const countsShape = z.object({
  total: z.number(),
  by_effective_status: z.record(z.string(), z.number()),
  truncated: z.boolean().describe(`True when the campaign has more than ${EDGE_CAP} of these, so the counts are partial.`),
});

async function countByStatus(m: MetaAdsClient, path: string): Promise<z.infer<typeof countsShape>> {
  const rows = await m.list(path, { fields: "effective_status" }, EDGE_CAP);
  const by: Record<string, number> = {};
  for (const r of rows) {
    const k = s(r, "effective_status") ?? "UNKNOWN";
    by[k] = (by[k] ?? 0) + 1;
  }
  return { total: rows.length, by_effective_status: by, truncated: rows.length >= EDGE_CAP };
}

export const getMetaCampaignDetails = metaRead({
  name: "get_meta_campaign_details",
  title: "Meta campaign details",
  description:
    "Shows one Meta campaign: objective, status and effective status, buying type, bid strategy, special ad categories, campaign budget (daily or lifetime) and remaining budget, spend cap, whether the budget is set at campaign level (Advantage campaign budget) or on the ad sets, start and stop times, and how many ad sets and ads it has by effective status. Money is converted from Meta's minor units to the account's currency. Fetched live from the Marketing API.",
  input: z.object({ account_id: accountId, campaign_id: metaId }),
  output: z.object({
    campaign_id: z.string(),
    name: z.string().nullable().describe("Untrusted text from Meta."),
    objective: z.string().nullable(),
    status: z.string().nullable(),
    effective_status: z.string().nullable(),
    buying_type: z.string().nullable(),
    bid_strategy: z.string().nullable().describe("Set on the campaign only with a campaign budget; otherwise see the ad sets."),
    special_ad_categories: z.array(z.string()),
    budget_level: z.enum(["campaign", "ad_set"]).describe("campaign: Advantage campaign budget (daily or lifetime budget on the campaign). ad_set: budgets are on the ad sets."),
    daily_budget: Money,
    lifetime_budget: Money,
    budget_remaining: Money,
    spend_cap: Money.describe("Campaign spend cap; null when there is none."),
    start_time: z.string().nullable(),
    stop_time: z.string().nullable(),
    ad_sets: countsShape,
    ads: countsShape,
  }),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const r = await m.getOwned(a.campaign_id, CAMPAIGN_FIELDS, "campaign");
    if (!s(r, "id")) throw new ToolError("internal", "Meta did not return the campaign.");
    const daily = fromMinor(r.daily_budget, m.currency);
    const lifetime = fromMinor(r.lifetime_budget, m.currency);
    const cap = s(r, "spend_cap");
    const [adSets, ads] = await Promise.all([countByStatus(m, `${a.campaign_id}/adsets`), countByStatus(m, `${a.campaign_id}/ads`)]);
    return {
      campaign_id: a.campaign_id,
      name: s(r, "name"),
      objective: s(r, "objective"),
      status: s(r, "status"),
      effective_status: s(r, "effective_status"),
      buying_type: s(r, "buying_type"),
      bid_strategy: s(r, "bid_strategy"),
      special_ad_categories: Array.isArray(r.special_ad_categories) ? r.special_ad_categories.map(String) : [],
      budget_level: (daily ?? 0) > 0 || (lifetime ?? 0) > 0 ? ("campaign" as const) : ("ad_set" as const),
      daily_budget: daily,
      lifetime_budget: lifetime,
      budget_remaining: fromMinor(r.budget_remaining, m.currency),
      spend_cap: cap === null || cap === "0" || cap === NO_SPEND_CAP ? null : fromMinor(cap, m.currency),
      start_time: s(r, "start_time"),
      stop_time: s(r, "stop_time"),
      ad_sets: adSets,
      ads,
    };
  },
});

export const structureTools = [listMetaAdSets, listMetaAds, getMetaCampaignDetails];
