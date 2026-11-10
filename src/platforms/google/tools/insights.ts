import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { AnyTool } from "../../../mcp/tool";
import type { Change, Effect } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, fromMicros, lit, pick } from "../gaql";
import { tailId } from "./campaign-reads";
import { accountId, campaignIds, dateClause, dateFields, datesMsg, datesOk, googleRead, idSchema, str } from "./common";
import { period } from "./keyword-segment-reports";
import { stateWrite } from "./write-kit";

/**
 * Google Ads tools: list_recommendations, apply_recommendations, dismiss_recommendations, get_change_history, get_auction_insights.
 * Approved by the owner on 2026-11-11 (inventory/tool-registry.json); API surfaces in inventory/mapping.ts.
 */

// --------------------------------------------------------------------------------------------------- shared helpers

/**
 * Every id must be a campaign (or ad group) of this account. An id of the other kind is called out, since passing a campaign
 * id where an ad group id belongs (and the reverse) is the common mistake. Removed items count: their history is still useful.
 */
async function requireIds(ads: GoogleAdsClient, level: "campaign" | "ad_group", ids: string[]): Promise<void> {
  const list = lit.list(ids.map(lit.id));
  const read = (l: "campaign" | "ad_group", inList: string) =>
    l === "campaign"
      ? ads.query(new Gaql().select("campaign.id").from("campaign").where(`campaign.id IN ${inList}`), { maxRows: 1000 }).then((rs) => rs.map((r) => String(pick(r, "campaign.id"))))
      : ads.query(new Gaql().select("ad_group.id").from("ad_group").where(`ad_group.id IN ${inList}`), { maxRows: 1000 }).then((rs) => rs.map((r) => String(pick(r, "ad_group.id"))));
  const found = new Set(await read(level, list));
  const missing = ids.filter((id) => !found.has(id));
  if (!missing.length) return;
  const other = level === "campaign" ? "ad_group" : "campaign";
  const wrong = await read(other, lit.list(missing.map(lit.id)));
  if (wrong.length) {
    throw new ToolError("invalid_argument", level === "campaign" ? `${wrong.join(", ")} ${wrong.length === 1 ? "is an ad group id" : "are ad group ids"}, not campaign ids.` : `${wrong.join(", ")} ${wrong.length === 1 ? "is a campaign id" : "are campaign ids"}, not ad group ids.`);
  }
  throw new ToolError("not_found", `No ${level === "campaign" ? "campaign" : "ad group"} ${missing.join(", ")} in this account.`);
}

const campaignRn = (ads: GoogleAdsClient, id: string) => lit.str(`customers/${ads.customerId}/campaigns/${lit.id(id)}`);

// ---------------------------------------------------------------------------------------------------- recommendations

/** Recommendation types in v26 (RecommendationTypeEnum, without UNSPECIFIED and UNKNOWN). */
const RECOMMENDATION_TYPES = [
  "CAMPAIGN_BUDGET", "KEYWORD", "TEXT_AD", "TARGET_CPA_OPT_IN", "MAXIMIZE_CONVERSIONS_OPT_IN", "ENHANCED_CPC_OPT_IN", "SEARCH_PARTNERS_OPT_IN", "MAXIMIZE_CLICKS_OPT_IN",
  "OPTIMIZE_AD_ROTATION", "KEYWORD_MATCH_TYPE", "MOVE_UNUSED_BUDGET", "FORECASTING_CAMPAIGN_BUDGET", "TARGET_ROAS_OPT_IN", "RESPONSIVE_SEARCH_AD", "MARGINAL_ROI_CAMPAIGN_BUDGET",
  "USE_BROAD_MATCH_KEYWORD", "RESPONSIVE_SEARCH_AD_ASSET", "UPGRADE_SMART_SHOPPING_CAMPAIGN_TO_PERFORMANCE_MAX", "RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH", "DISPLAY_EXPANSION_OPT_IN",
  "UPGRADE_LOCAL_CAMPAIGN_TO_PERFORMANCE_MAX", "RAISE_TARGET_CPA_BID_TOO_LOW", "FORECASTING_SET_TARGET_ROAS", "CALLOUT_ASSET", "SITELINK_ASSET", "CALL_ASSET", "SHOPPING_ADD_AGE_GROUP",
  "SHOPPING_ADD_COLOR", "SHOPPING_ADD_GENDER", "SHOPPING_ADD_GTIN", "SHOPPING_ADD_MORE_IDENTIFIERS", "SHOPPING_ADD_SIZE", "SHOPPING_ADD_PRODUCTS_TO_CAMPAIGN", "SHOPPING_FIX_DISAPPROVED_PRODUCTS",
  "SHOPPING_TARGET_ALL_OFFERS", "SHOPPING_FIX_SUSPENDED_MERCHANT_CENTER_ACCOUNT", "SHOPPING_FIX_MERCHANT_CENTER_ACCOUNT_SUSPENSION_WARNING",
  "SHOPPING_MIGRATE_REGULAR_SHOPPING_CAMPAIGN_OFFERS_TO_PERFORMANCE_MAX", "DYNAMIC_IMAGE_EXTENSION_OPT_IN", "RAISE_TARGET_CPA", "LOWER_TARGET_ROAS", "PERFORMANCE_MAX_OPT_IN",
  "IMPROVE_PERFORMANCE_MAX_AD_STRENGTH", "MIGRATE_DYNAMIC_SEARCH_ADS_CAMPAIGN_TO_PERFORMANCE_MAX", "FORECASTING_SET_TARGET_CPA", "SET_TARGET_CPA", "SET_TARGET_ROAS",
  "MAXIMIZE_CONVERSION_VALUE_OPT_IN", "IMPROVE_GOOGLE_TAG_COVERAGE", "PERFORMANCE_MAX_FINAL_URL_OPT_IN", "REFRESH_CUSTOMER_MATCH_LIST", "CUSTOM_AUDIENCE_OPT_IN", "LEAD_FORM_ASSET",
  "IMPROVE_DEMAND_GEN_AD_STRENGTH", "CAMPAIGN_SPECIFIC_APP_GOAL", "RAISE_TARGET_CPA_PERFORMANCE_BID_TOO_LOW", "LOWER_TARGET_ROAS_PERFORMANCE_BID_TOO_LOW", "RAISE_BUDGET_PERFORMANCE_TOO_LOW",
  "OPTIMIZE_FOR_NEW_CUSTOMERS",
] as const;

/** Types whose default application raises a budget or loosens a bid target: the approval reads as a spend increase. */
const SPEND_TYPES = new Set<string>(["CAMPAIGN_BUDGET", "FORECASTING_CAMPAIGN_BUDGET", "MARGINAL_ROI_CAMPAIGN_BUDGET", "MOVE_UNUSED_BUDGET", "RAISE_BUDGET_PERFORMANCE_TOO_LOW", "RAISE_TARGET_CPA", "RAISE_TARGET_CPA_BID_TOO_LOW", "RAISE_TARGET_CPA_PERFORMANCE_BID_TOO_LOW", "LOWER_TARGET_ROAS", "LOWER_TARGET_ROAS_PERFORMANCE_BID_TOO_LOW"]);
/** Types that add keywords, ads or assets. Every other type switches a feature or strategy on. */
const CONTENT_TYPES = new Set<string>(["KEYWORD", "TEXT_AD", "RESPONSIVE_SEARCH_AD", "RESPONSIVE_SEARCH_AD_ASSET", "RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH", "CALLOUT_ASSET", "SITELINK_ASSET", "CALL_ASSET", "LEAD_FORM_ASSET", "USE_BROAD_MATCH_KEYWORD", "KEYWORD_MATCH_TYPE"]);
const applyEffect = (type: string): Effect => (SPEND_TYPES.has(type) ? "increase_spend" : CONTENT_TYPES.has(type) ? "create" : "enable");

/**
 * The recommendation id is the last part of its resource name (customers/{customer_id}/recommendations/{recommendation_id}).
 * Google does not document its format, so anything that is safe inside a quoted GAQL value and a JSON body is accepted.
 */
const recommendationId = z.string().regex(/^[A-Za-z0-9_~=+.\-]{1,256}$/, "a recommendation id from list_recommendations");
const recRn = (ads: GoogleAdsClient, id: string) => `customers/${ads.customerId}/recommendations/${id}`;
const recId = (ads: GoogleAdsClient, rn: unknown): string => {
  const s = typeof rn === "string" ? rn : "";
  const prefix = `customers/${ads.customerId}/recommendations/`;
  return s.startsWith(prefix) ? s.slice(prefix.length) : (s.split("/").pop() ?? "");
};

const impactMetrics = z.object({
  impressions: z.number().nullable(),
  clicks: z.number().nullable(),
  cost: z.number().nullable().describe("In the account's currency."),
  conversions: z.number().nullable(),
  conversions_value: z.number().nullable(),
  video_views: z.number().nullable(),
});
type ImpactMetrics = z.infer<typeof impactMetrics>;
const impactSchema = z
  .object({ base: impactMetrics.nullable().describe("Estimated weekly metrics without the recommendation."), potential: impactMetrics.nullable().describe("Estimated weekly metrics with the recommendation applied.") })
  .nullable()
  .describe("Google's estimate; null when Google gives none. A metric is null when Google does not estimate it for this type.");

/** Impact metrics as Google sends them (RecommendationMetrics): availability varies by type, so an absent metric is null, not 0. */
function metricsOf(m: unknown): ImpactMetrics | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  const n = (k: string) => (o[k] === undefined || o[k] === null ? null : Number(o[k]));
  return { impressions: n("impressions"), clicks: n("clicks"), cost: o.costMicros === undefined || o.costMicros === null ? null : fromMicros(o.costMicros), conversions: n("conversions"), conversions_value: n("conversionsValue"), video_views: n("videoViews") };
}

const REC_FIELDS = ["recommendation.resource_name", "recommendation.type", "recommendation.dismissed", "recommendation.campaign", "recommendation.ad_group", "recommendation.campaign_budget", "recommendation.campaigns", "recommendation.impact"];

interface Rec {
  id: string;
  type: string;
  dismissed: boolean;
  campaign_id: string | null;
  ad_group_id: string | null;
  budget_id: string | null;
  campaign_ids: string[];
  impact: { base: ImpactMetrics | null; potential: ImpactMetrics | null } | null;
}

function toRec(ads: GoogleAdsClient, r: Row): Rec {
  const impact = pick(r, "recommendation.impact");
  const base = metricsOf(pick(r, "recommendation.impact.base_metrics"));
  const potential = metricsOf(pick(r, "recommendation.impact.potential_metrics"));
  const campaigns = pick(r, "recommendation.campaigns");
  return {
    id: recId(ads, pick(r, "recommendation.resource_name")),
    type: str(r, "recommendation.type") ?? "UNKNOWN",
    dismissed: pick(r, "recommendation.dismissed") === true,
    campaign_id: tailId(pick(r, "recommendation.campaign")),
    ad_group_id: tailId(pick(r, "recommendation.ad_group")),
    budget_id: tailId(pick(r, "recommendation.campaign_budget")),
    campaign_ids: Array.isArray(campaigns) ? campaigns.map((c) => tailId(c)).filter((c): c is string => !!c).sort() : [],
    impact: impact && (base || potential) ? { base, potential } : null,
  };
}

const recSchema = z.object({
  id: z.string().describe("Pass this to apply_recommendations or dismiss_recommendations."),
  type: z.string(),
  dismissed: z.boolean(),
  campaign_id: z.string().nullable(),
  ad_group_id: z.string().nullable(),
  budget_id: z.string().nullable().describe("The campaign budget, for budget recommendations."),
  campaign_ids: z.array(z.string()).describe("The campaigns a budget recommendation covers (its shared budget's campaigns)."),
  impact: impactSchema,
});

export const listRecommendations = googleRead({
  name: "list_recommendations",
  title: "List recommendations",
  description:
    "Google's recommendations for the account (the optimization score suggestions): id, type, campaign, ad group or budget, whether dismissed, and Google's estimated impact (weekly impressions, clicks, cost, conversions and video views without and with the recommendation, where Google provides them). Pass an id to apply_recommendations or dismiss_recommendations. Recommendations change daily and an id can stop working, so act on a fresh list. Dismissed ones are left out unless include_dismissed. Fetched live.",
  input: z.object({
    account_id: accountId,
    types: z.array(z.enum(RECOMMENDATION_TYPES)).min(1).max(RECOMMENDATION_TYPES.length).optional().describe("Default: every type."),
    campaign_ids: campaignIds.optional().describe("Only recommendations for these campaigns (up to 50), including budget recommendations covering them."),
    include_dismissed: z.boolean().default(false),
    limit: z.number().int().min(1).max(1000).default(100),
  }),
  output: z.object({ recommendations: z.array(recSchema), by_type: z.array(z.object({ type: z.string(), count: z.number().int() })), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    if (a.campaign_ids?.length) await requireIds(ads, "campaign", a.campaign_ids);
    const typeClause = a.types ? `recommendation.type IN ${lit.list(a.types.map((t) => lit.enumLit(t, RECOMMENDATION_TYPES)))}` : undefined;
    const dismissedClause = a.include_dismissed ? undefined : "recommendation.dismissed = FALSE";
    // Budget recommendations name their campaigns in the repeated `campaigns` field, the others in `campaign`. GAQL has no OR,
    // so with a campaign filter both are read and merged.
    const rows = a.campaign_ids?.length
      ? (
          await Promise.all([
            ads.query(new Gaql().select(...REC_FIELDS).from("recommendation").where(typeClause).where(dismissedClause).where(`recommendation.campaign IN ${lit.list(a.campaign_ids.map((c) => campaignRn(ads, c)))}`), { maxRows: 10_000 }),
            ads.query(new Gaql().select(...REC_FIELDS).from("recommendation").where(typeClause).where(dismissedClause).where(`recommendation.campaigns CONTAINS ANY ${lit.list(a.campaign_ids.map((c) => campaignRn(ads, c)))}`), { maxRows: 10_000 }),
          ])
        ).flat()
      : await ads.query(new Gaql().select(...REC_FIELDS).from("recommendation").where(typeClause).where(dismissedClause), { maxRows: 10_000 });
    const byId = new Map<string, Rec>();
    for (const r of rows) {
      const rec = toRec(ads, r);
      byId.set(rec.id, rec);
    }
    const all = [...byId.values()].sort((x, y) => x.type.localeCompare(y.type) || (x.campaign_id ?? "").localeCompare(y.campaign_id ?? "") || x.id.localeCompare(y.id));
    const counts = new Map<string, number>();
    for (const r of all) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
    return { recommendations: all.slice(0, a.limit), by_type: [...counts].map(([type, count]) => ({ type, count })).sort((x, y) => y.count - x.count || x.type.localeCompare(y.type)), truncated: all.length > a.limit };
  },
});

/** The requested recommendations as they are now. Unknown ids are listed, not thrown: the re-read after applying expects them gone. */
async function readRecs(ads: GoogleAdsClient, ids: string[]) {
  const wanted = [...new Set(ids)].sort();
  const rows = await ads.query(new Gaql().select(...REC_FIELDS).from("recommendation").where(`recommendation.resource_name IN ${lit.list(wanted.map((id) => lit.str(recRn(ads, id))))}`), { maxRows: 1000 });
  const found = rows.map((r) => toRec(ads, r)).filter((r) => wanted.includes(r.id)).sort((x, y) => x.id.localeCompare(y.id));
  return { found, missing: wanted.filter((id) => !found.some((f) => f.id === id)) };
}
type RecState = Awaited<ReturnType<typeof readRecs>>;

function requireAll(s: RecState) {
  if (s.missing.length)
    throw new ToolError("not_found", `No recommendation ${s.missing.join(", ")} in this account. Recommendations change daily: an id can be replaced, or the recommendation applied or no longer relevant. Run list_recommendations again.`);
}
function oneType(recs: Rec[], verb: string) {
  const types = [...new Set(recs.map((r) => r.type))].sort();
  if (types.length > 1) throw new ToolError("invalid_argument", `Google ${verb} recommendations of one type per request, and these are of types ${types.join(", ")}. Send one call per type.`);
  return types[0]!;
}
const fmt = (n: number | null) => (n === null ? "?" : String(Math.round(n * 100) / 100));
function impactText(r: Rec): string {
  const b = r.impact?.base;
  const p = r.impact?.potential;
  if (!b && !p) return "no impact estimate from Google";
  const parts = (["clicks", "impressions", "conversions", "cost"] as const).filter((k) => b?.[k] != null || p?.[k] != null).map((k) => `${k} ${fmt(b?.[k] ?? null)} → ${fmt(p?.[k] ?? null)}`);
  return parts.length ? `estimated weekly ${parts.join(", ")}` : "no impact estimate from Google";
}
const where = (r: Rec) => (r.ad_group_id ? `ad group ${r.ad_group_id}` : r.campaign_id ? `campaign ${r.campaign_id}` : r.campaign_ids.length ? `campaigns ${r.campaign_ids.join(", ")}` : "account");

const recIds = z.array(recommendationId).min(1).max(20).describe("Recommendation ids from list_recommendations (up to 20, all of one type).");

export const applyRecommendations = stateWrite({
  name: "apply_recommendations",
  title: "Apply recommendations",
  risk: "high_impact",
  description:
    "Applies up to 20 of Google's recommendations (ids from list_recommendations) with Google's own recommended values, after a person approves it. Applying can raise budgets, change bidding, add keywords, ads or assets, or opt campaigns into features, depending on the type. The approval lists each recommendation's type, campaign and Google's estimated impact. Google applies one recommendation type per request, so the ids must share a type. Unknown and dismissed ids are refused. Confirmed by re-reading: an applied recommendation no longer appears. Custom values (for example a different budget) are not supported here.",
  // Strict: a caller passing custom values (which this version does not support) is refused, not applied with Google's defaults.
  input: z.strictObject({ account_id: accountId, recommendation_ids: recIds }),
  output: z.object({ applied: z.array(z.object({ id: z.string(), type: z.string(), campaign_id: z.string().nullable() })), resource_names: z.array(z.string()) }),
  read: (a, ads) => readRecs(ads, a.recommendation_ids),
  build: (_a, s, ads) => {
    requireAll(s);
    const dismissed = s.found.filter((r) => r.dismissed);
    if (dismissed.length) throw new ToolError("invalid_argument", `Recommendation ${dismissed.map((r) => r.id).join(", ")} ${dismissed.length === 1 ? "is" : "are"} dismissed. This tool applies only active recommendations.`);
    const type = oneType(s.found, "applies");
    const changes: Change[] = s.found.map((r) => ({ resource: "recommendation", id: r.id, name: `${r.type} (${where(r)})`, field: "applied", before: false, after: true, unit: "text", effect: applyEffect(r.type) }));
    const lines = s.found.map((r) => `- ${r.id}: ${where(r)}; ${impactText(r)}`);
    return {
      summary: `Apply ${s.found.length} ${type} recommendation${s.found.length === 1 ? "" : "s"} with Google's recommended values:\n${lines.join("\n")}`,
      changes,
      ops: [],
      rpc: { path: `customers/${ads.customerId}/recommendations:apply`, body: { operations: s.found.map((r) => ({ resourceName: recRn(ads, r.id) })) } },
    };
  },
  landed: (_a, _before, after) => after.found.length === 0,
  result: (_a, _after, responses, before) => ({
    applied: before.found.map((r) => ({ id: r.id, type: r.type, campaign_id: r.campaign_id })),
    resource_names: responses.flatMap((x) => ((x as { results?: { resourceName?: string }[] }).results ?? []).map((y) => y.resourceName ?? "")).filter(Boolean),
  }),
});

export const dismissRecommendations = stateWrite({
  name: "dismiss_recommendations",
  title: "Dismiss recommendations",
  risk: "write",
  description:
    "Dismisses up to 20 of Google's recommendations (ids from list_recommendations) after a person approves it, so they stop counting against the optimization score. Nothing in the campaigns changes. Ids that are already dismissed are skipped; the rest must share a type, because Google dismisses one recommendation type per request. Confirmed by re-reading with dismissed recommendations included.",
  input: z.object({ account_id: accountId, recommendation_ids: recIds }),
  output: z.object({ dismissed: z.array(z.string()), already_dismissed: z.array(z.string()) }),
  read: (a, ads) => readRecs(ads, a.recommendation_ids),
  build: (_a, s, ads) => {
    requireAll(s);
    const todo = s.found.filter((r) => !r.dismissed);
    if (!todo.length) throw new ToolError("invalid_argument", "Nothing would change: every one of these recommendations is already dismissed.");
    const type = oneType(todo, "dismisses");
    const changes: Change[] = todo.map((r) => ({ resource: "recommendation", id: r.id, name: `${r.type} (${where(r)})`, field: "dismissed", before: false, after: true, unit: "text", effect: "neutral" }));
    const skipped = s.found.filter((r) => r.dismissed).map((r) => r.id);
    return {
      summary: `Dismiss ${todo.length} ${type} recommendation${todo.length === 1 ? "" : "s"}: ${todo.map((r) => `${r.id} (${where(r)})`).join(", ")}${skipped.length ? `. Already dismissed: ${skipped.join(", ")}` : ""}`,
      changes,
      ops: [],
      rpc: { path: `customers/${ads.customerId}/recommendations:dismiss`, body: { operations: todo.map((r) => ({ resourceName: recRn(ads, r.id) })) } },
    };
  },
  landed: (_a, before, after) => before.found.filter((r) => !r.dismissed).every((r) => after.found.some((x) => x.id === r.id && x.dismissed)),
  result: (_a, _after, _r, before) => ({ dismissed: before.found.filter((r) => !r.dismissed).map((r) => r.id), already_dismissed: before.found.filter((r) => r.dismissed).map((r) => r.id) }),
});

// ----------------------------------------------------------------------------------------------------- change history

/** ChangeEventResourceType values in v26, without UNSPECIFIED, UNKNOWN and the sunset feed types. */
const EVENT_TYPES = ["AD", "AD_GROUP", "AD_GROUP_AD", "AD_GROUP_ASSET", "AD_GROUP_BID_MODIFIER", "AD_GROUP_CRITERION", "ASSET", "ASSET_SET", "ASSET_SET_ASSET", "CAMPAIGN", "CAMPAIGN_ASSET", "CAMPAIGN_ASSET_SET", "CAMPAIGN_BUDGET", "CAMPAIGN_CRITERION", "CUSTOMER_ASSET"] as const;
/**
 * ChangeStatusResourceType values in v26 (without UNSPECIFIED, UNKNOWN and feeds), each with the change_status field that names the
 * changed resource. change_status also covers types change_event does not (asset groups, shared sets, audiences).
 */
const STATUS_TYPES = {
  AD_GROUP: "change_status.ad_group",
  AD_GROUP_AD: "change_status.ad_group_ad",
  AD_GROUP_ASSET: "change_status.ad_group_asset",
  AD_GROUP_BID_MODIFIER: "change_status.ad_group_bid_modifier",
  AD_GROUP_CRITERION: "change_status.ad_group_criterion",
  ASSET: "change_status.asset",
  ASSET_GROUP: "change_status.asset_group",
  ASSET_SET: "change_status.asset_set",
  CAMPAIGN: "change_status.campaign",
  CAMPAIGN_ASSET: "change_status.campaign_asset",
  CAMPAIGN_ASSET_SET: "change_status.campaign_asset_set",
  CAMPAIGN_BUDGET: "change_status.campaign_budget",
  CAMPAIGN_CRITERION: "change_status.campaign_criterion",
  CAMPAIGN_SHARED_SET: "change_status.campaign_shared_set",
  COMBINED_AUDIENCE: "change_status.combined_audience",
  CUSTOMER_ASSET: "change_status.customer_asset",
  SHARED_SET: "change_status.shared_set",
} as const;
type StatusType = keyof typeof STATUS_TYPES;
const STATUS_TYPE_NAMES = Object.keys(STATUS_TYPES) as StatusType[];
const ALL_TYPES = [...new Set<string>([...EVENT_TYPES, ...STATUS_TYPE_NAMES])].sort() as [string, ...string[]];

/** The account's calendar date, `offsetDays` from today, as YYYY-MM-DD. Unknown time zones fall back to UTC. */
export function localDate(now: Date, timeZone: string | null, offsetDays = 0): string {
  let today: string;
  try {
    today = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    today = now.toISOString().slice(0, 10);
  }
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** A changed value, kept short: long text and nested messages are cut to 200 characters. */
type Compact = string | number | boolean | null;
function compact(v: unknown): Compact {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** The changed resource inside ChangeEvent.ChangedResource: the field named after the resource type (CAMPAIGN_BUDGET -> campaignBudget). */
function inner(changed: unknown, type: string | null): Record<string, unknown> | null {
  if (!changed || typeof changed !== "object") return null;
  const o = changed as Record<string, unknown>;
  const key = type ? camel(type.toLowerCase()) : "";
  const v = o[key] ?? Object.values(o)[0];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}
function at(obj: Record<string, unknown> | null, path: string): unknown {
  let cur: unknown = obj;
  for (const p of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[camel(p)];
  }
  return cur;
}
/** changed_fields is a google.protobuf.FieldMask: a comma-separated string in JSON. */
const maskPaths = (m: unknown): string[] => (typeof m === "string" ? m.split(",").map((p) => p.trim()).filter(Boolean) : Array.isArray((m as { paths?: unknown })?.paths) ? ((m as { paths: string[] }).paths) : []);
const MAX_FIELDS = 30;

const changeSchema = z.object({
  time: z.string().nullable().describe("In the account's time zone."),
  user_email: z.string().nullable(),
  client_type: z.string().nullable().describe("Where the change was made: GOOGLE_ADS_WEB_CLIENT, GOOGLE_ADS_API, GOOGLE_ADS_SCRIPTS, GOOGLE_ADS_RECOMMENDATIONS, ..."),
  resource_type: z.string().nullable(),
  resource_id: z.string().nullable().describe("The id part of the changed resource's name (for criteria and links, parent~child)."),
  campaign_id: z.string().nullable(),
  ad_group_id: z.string().nullable(),
  operation: z.string().nullable().describe("CREATE, UPDATE or REMOVE."),
  fields: z.array(z.object({ field: z.string(), old: z.union([z.string(), z.number(), z.boolean(), z.null()]), new: z.union([z.string(), z.number(), z.boolean(), z.null()]) })).describe("Only the changed fields. null means unset or at its default value."),
  more_fields: z.number().int().describe("Changed fields left out after the first 30."),
});
const statusSchema = z.object({ time: z.string().nullable(), resource_type: z.string().nullable(), resource_id: z.string().nullable(), campaign_id: z.string().nullable(), ad_group_id: z.string().nullable(), status: z.string().nullable().describe("ADDED, CHANGED or REMOVED (the latest change in the window).") });

export const getChangeHistory = googleRead({
  name: "get_change_history",
  title: "Change history",
  description:
    "Who changed what in the account and when, over the last 1 to 30 days (Google keeps 30 days): time, user email, where the change was made (web interface, API, scripts, recommendations, ...), the resource type and id, campaign and ad group, the operation, and the old and new value of each changed field. Returns personal data: the email addresses of the people who made changes. Google does not record every change here; Google Ads Editor changes and some criterion-level changes are missing. include_status_only adds a list of other resources that changed in the window (from Google's change status, which includes Editor changes, asset groups, shared sets and audiences) with only the time and whether they were added, changed or removed. Changed values are text from the account and may be shortened. Newest first. Fetched live.",
  input: z.object({
    account_id: accountId,
    days: z.number().int().min(1).max(30).default(7).describe("Today and the days before it, in the account's time zone."),
    resource_types: z.array(z.enum(ALL_TYPES)).min(1).max(ALL_TYPES.length).optional().describe("Default: every type. ASSET_GROUP, SHARED_SET, CAMPAIGN_SHARED_SET and COMBINED_AUDIENCE only appear with include_status_only."),
    campaign_ids: campaignIds.optional(),
    include_status_only: z.boolean().default(false).describe("Also list resources that changed without a detailed change record."),
    limit: z.number().int().min(1).max(1000).default(100),
  }),
  output: z.object({
    start_date: z.string(),
    end_date: z.string().describe("Exclusive: changes before this date."),
    time_zone: z.string().nullable(),
    changes: z.array(changeSchema),
    truncated: z.boolean().describe("More changes exist in the window: narrow it or raise limit."),
    status_only: z.array(statusSchema).optional(),
    status_only_truncated: z.boolean().optional(),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const eventTypes = a.resource_types ? a.resource_types.filter((t): t is (typeof EVENT_TYPES)[number] => (EVENT_TYPES as readonly string[]).includes(t)) : [...EVENT_TYPES];
    const statusTypes = a.resource_types ? a.resource_types.filter((t): t is StatusType => t in STATUS_TYPES) : STATUS_TYPE_NAMES;
    if (!eventTypes.length && !a.include_status_only) throw new ToolError("invalid_argument", `${a.resource_types!.join(", ")} ${a.resource_types!.length === 1 ? "has" : "have"} no detailed change records: set include_status_only to list when they changed.`);
    if (a.campaign_ids?.length) await requireIds(ads, "campaign", a.campaign_ids);
    const [tz] = await ads.query(new Gaql().select("customer.time_zone").from("customer").limit(1), { maxRows: 1 });
    const timeZone = tz ? str(tz, "customer.time_zone") : null;
    // Google requires a window within the last 30 days and a LIMIT of at most 10,000. The end bound is tomorrow so changes made
    // today are included (a date compares as its midnight).
    const now = new Date();
    const start = localDate(now, timeZone, -(a.days - 1));
    const end = localDate(now, timeZone, 1);
    const campaignsIn = a.campaign_ids?.length ? lit.list(a.campaign_ids.map((c) => campaignRn(ads, c))) : null;

    const eventRows = eventTypes.length
      ? await ads.query(
          new Gaql()
            .select("change_event.change_date_time", "change_event.change_resource_name", "change_event.user_email", "change_event.client_type", "change_event.change_resource_type", "change_event.resource_change_operation", "change_event.changed_fields", "change_event.old_resource", "change_event.new_resource", "change_event.campaign", "change_event.ad_group")
            .from("change_event")
            .where(`change_event.change_date_time >= ${lit.date(start)}`)
            .where(`change_event.change_date_time < ${lit.date(end)}`)
            .where(a.resource_types ? `change_event.change_resource_type IN ${lit.list(eventTypes.map((t) => lit.enumLit(t, EVENT_TYPES)))}` : undefined)
            .where(campaignsIn && `change_event.campaign IN ${campaignsIn}`)
            .orderBy("change_event.change_date_time", "DESC")
            .limit(a.limit + 1),
          { maxRows: a.limit + 1 },
        )
      : [];
    const changes = eventRows.slice(0, a.limit).map((r) => {
      const type = str(r, "change_event.change_resource_type");
      const oldR = inner(pick(r, "change_event.old_resource"), type);
      const newR = inner(pick(r, "change_event.new_resource"), type);
      const paths = maskPaths(pick(r, "change_event.changed_fields"));
      return {
        time: str(r, "change_event.change_date_time"),
        user_email: str(r, "change_event.user_email"),
        client_type: str(r, "change_event.client_type"),
        resource_type: type,
        resource_id: tailId(pick(r, "change_event.change_resource_name")),
        campaign_id: tailId(pick(r, "change_event.campaign")),
        ad_group_id: tailId(pick(r, "change_event.ad_group")),
        operation: str(r, "change_event.resource_change_operation"),
        fields: paths.slice(0, MAX_FIELDS).map((p) => ({ field: p, old: compact(at(oldR, p)), new: compact(at(newR, p)) })),
        more_fields: Math.max(0, paths.length - MAX_FIELDS),
      };
    });
    const out = { start_date: start, end_date: end, time_zone: timeZone, changes, truncated: eventRows.length > a.limit };
    if (!a.include_status_only || !statusTypes.length) return a.include_status_only ? { ...out, status_only: [], status_only_truncated: false } : out;

    // change_status keeps the latest change per resource (up to 90 days back). Resources already in the detailed list are dropped.
    const statusLimit = Math.min(10_000, a.limit + 1 + eventRows.length);
    const statusRows = await ads.query(
      new Gaql()
        .select("change_status.last_change_date_time", "change_status.resource_type", "change_status.resource_status", ...Object.values(STATUS_TYPES))
        .from("change_status")
        .where(`change_status.last_change_date_time >= ${lit.date(start)}`)
        .where(`change_status.last_change_date_time < ${lit.date(end)}`)
        .where(a.resource_types ? `change_status.resource_type IN ${lit.list(statusTypes.map((t) => lit.enumLit(t, STATUS_TYPE_NAMES)))}` : undefined)
        .where(campaignsIn && `change_status.campaign IN ${campaignsIn}`)
        .orderBy("change_status.last_change_date_time", "DESC")
        .limit(statusLimit),
      { maxRows: statusLimit },
    );
    const detailed = new Set(eventRows.map((r) => str(r, "change_event.change_resource_name")));
    const other = statusRows
      .map((r) => {
        const type = str(r, "change_status.resource_type");
        const rn = type && type in STATUS_TYPES ? str(r, STATUS_TYPES[type as StatusType]) : null;
        return { rn, row: { time: str(r, "change_status.last_change_date_time"), resource_type: type, resource_id: tailId(rn), campaign_id: tailId(pick(r, "change_status.campaign")), ad_group_id: tailId(pick(r, "change_status.ad_group")), status: str(r, "change_status.resource_status") } };
      })
      .filter((x) => !x.rn || !detailed.has(x.rn))
      .map((x) => x.row);
    return { ...out, status_only: other.slice(0, a.limit), status_only_truncated: other.length > a.limit || statusRows.length === statusLimit };
  },
});

// --------------------------------------------------------------------------------------------------- auction insights

const AI_METRICS = {
  impression_share: "metrics.auction_insight_search_impression_share",
  overlap_rate: "metrics.auction_insight_search_overlap_rate",
  position_above_rate: "metrics.auction_insight_search_position_above_rate",
  top_impression_rate: "metrics.auction_insight_search_top_impression_percentage",
  absolute_top_impression_rate: "metrics.auction_insight_search_absolute_top_impression_percentage",
  outranking_share: "metrics.auction_insight_search_outranking_share",
} as const;
const DOMAIN = "segments.auction_insight_domain";
const ratio = z.number().nullable();

export const getAuctionInsights = googleRead({
  name: "get_auction_insights",
  title: "Auction insights",
  description:
    "Search auction insights for a period: the other advertisers (by display domain) competing in the same auctions, with their impression share, overlap rate, position-above rate, top and absolute-top impression rates, and your outranking share against each. For the whole account, or per campaign or per ad group. Rates are fractions (0.25 = 25%); Google reports impression share and outranking share below 10% as 0.0999. Google marks these metrics as not publicly available in the Google Ads API: unless Google has granted access to the Cloud project, the call fails with a permission error. Fetched live.",
  input: z
    .object({
      account_id: accountId,
      ...dateFields,
      campaign_ids: campaignIds.optional().describe("One row per campaign and competitor for these campaigns (up to 50)."),
      ad_group_ids: z.array(idSchema).min(1).max(50).optional().describe("One row per ad group and competitor for these ad groups (up to 50). Not with campaign_ids."),
      limit: z.number().int().min(1).max(1000).default(100),
    })
    .refine(datesOk, datesMsg)
    .refine((v) => !(v.campaign_ids?.length && v.ad_group_ids?.length), { message: "give campaign_ids or ad_group_ids, not both" }),
  output: z.object({
    period: z.string(),
    level: z.enum(["account", "campaign", "ad_group"]),
    rows: z.array(
      z.object({
        campaign_id: z.string().nullable(),
        ad_group_id: z.string().nullable(),
        domain: z.string().nullable().describe("The competitor's display domain. Text from Google."),
        impression_share: ratio,
        overlap_rate: ratio,
        position_above_rate: ratio,
        top_impression_rate: ratio,
        absolute_top_impression_rate: ratio,
        outranking_share: ratio,
      }),
    ),
    truncated: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const level: "account" | "campaign" | "ad_group" = a.ad_group_ids?.length ? "ad_group" : a.campaign_ids?.length ? "campaign" : "account";
    if (level === "campaign") await requireIds(ads, "campaign", a.campaign_ids!);
    if (level === "ad_group") await requireIds(ads, "ad_group", a.ad_group_ids!);
    const metrics = Object.values(AI_METRICS);
    // The metrics can be selected with the domain segment and date segments only (v26 metrics reference).
    const q =
      level === "account"
        ? new Gaql().select(DOMAIN, ...metrics).from("customer").where(dateClause(a))
        : level === "campaign"
          ? new Gaql().select("campaign.id", DOMAIN, ...metrics).from("campaign").where(dateClause(a)).where(`campaign.id IN ${lit.list(a.campaign_ids!.map(lit.id))}`)
          : new Gaql().select("campaign.id", "ad_group.id", DOMAIN, ...metrics).from("ad_group").where(dateClause(a)).where(`ad_group.id IN ${lit.list(a.ad_group_ids!.map(lit.id))}`);
    let rows: Row[];
    try {
      rows = await ads.query(q, { maxRows: 10_000 });
    } catch (e) {
      if (e instanceof ToolError && (e.code === "platform_permission_denied" || (e.code === "invalid_argument" && /auction_insight/i.test(e.message)))) {
        throw new ToolError("platform_permission_denied", `Google did not return auction insights: these metrics are not publicly available in the Google Ads API, and Google must grant access to the Cloud project behind this connection. The Auction insights report in the Google Ads web interface shows the same data. Google said: ${e.message}`);
      }
      throw e;
    }
    const v = (r: Row, f: string) => (pick(r, f) === undefined || pick(r, f) === null ? null : Number(pick(r, f)));
    const all = rows
      .map((r) => ({
        campaign_id: level === "account" ? null : pick(r, "campaign.id") === undefined ? null : String(pick(r, "campaign.id")),
        ad_group_id: level === "ad_group" && pick(r, "ad_group.id") !== undefined ? String(pick(r, "ad_group.id")) : null,
        domain: str(r, DOMAIN),
        impression_share: v(r, AI_METRICS.impression_share),
        overlap_rate: v(r, AI_METRICS.overlap_rate),
        position_above_rate: v(r, AI_METRICS.position_above_rate),
        top_impression_rate: v(r, AI_METRICS.top_impression_rate),
        absolute_top_impression_rate: v(r, AI_METRICS.absolute_top_impression_rate),
        outranking_share: v(r, AI_METRICS.outranking_share),
      }))
      .sort((x, y) => (x.campaign_id ?? "").localeCompare(y.campaign_id ?? "") || (x.ad_group_id ?? "").localeCompare(y.ad_group_id ?? "") || (y.impression_share ?? -1) - (x.impression_share ?? -1) || (x.domain ?? "").localeCompare(y.domain ?? ""));
    return { period: period(a), level, rows: all.slice(0, a.limit), truncated: all.length > a.limit };
  },
});

export const insightTools: AnyTool[] = [listRecommendations, applyRecommendations, dismissRecommendations, getChangeHistory, getAuctionInsights] as AnyTool[];
