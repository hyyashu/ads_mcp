import { z } from "zod";
import type { Row } from "../client";
import { Gaql, lit, num, pick } from "../gaql";
import { assetContent, assetFields, tailId } from "./campaign-reads";
import { accountId, campaignIds, dateClause, dateFields, datesMsg, datesOk, googleRead, str } from "./common";
import { add, perf, perfSchema, period, zero, type Totals } from "./keyword-segment-reports";

/**
 * Extension (asset) performance at account, campaign and ad group level. Metrics on a link resource cover every
 * interaction while the asset served, on the asset itself or elsewhere in the ad (v26 field reference for
 * segments.asset_interaction_target.interaction_on_this_asset), so each link reports both.
 */
const REPORT_FIELD_TYPES = ["SITELINK", "CALLOUT", "STRUCTURED_SNIPPET", "CALL", "PRICE", "PROMOTION", "LEAD_FORM", "MOBILE_APP", "HOTEL_CALLOUT", "BUSINESS_MESSAGE", "AD_IMAGE", "BUSINESS_NAME", "BUSINESS_LOGO"] as const;
const LEVELS = { account: "customer_asset", campaign: "campaign_asset", ad_group: "ad_group_asset" } as const;
type Level = keyof typeof LEVELS;
const ON_ASSET = "segments.asset_interaction_target.interaction_on_this_asset";
const METRICS = ["metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value"];
/** Not selectable with the interaction segment (v26 segments reference), so read in a second query for call assets only. */
const PHONE_METRICS = ["metrics.phone_calls", "metrics.phone_impressions"];

interface Acc {
  level: Level;
  campaign_id: string | null;
  ad_group_id: string | null;
  asset_id: string;
  field_type: string | null;
  status: string | null;
  content: ReturnType<typeof assetContent>;
  t: Totals;
  clicks_on_asset: number;
  conversions_on_asset: number;
  phone_calls: number;
  phone_impressions: number;
}

export const getAssetPerformance = googleRead({
  name: "get_asset_performance",
  title: "Asset (extension) performance",
  description:
    "Performance of each sitelink, callout, structured snippet, phone number (call asset) and other extension for a period, at account, campaign and ad group level. For each link: impressions, clicks, cost and conversions of the ads it served with, plus clicks and conversions on the asset itself (for example on that sitelink), and phone calls and phone impressions for call assets. Optionally one level, some field types or some campaigns; with campaigns, account-level assets are split by campaign. by_field_type adds up the measures that do not double count. Removed links are left out. Fetched live.",
  input: z
    .object({
      account_id: accountId,
      ...dateFields,
      level: z.enum(["all", "account", "campaign", "ad_group"]).default("all"),
      field_types: z.array(z.enum(REPORT_FIELD_TYPES)).min(1).max(REPORT_FIELD_TYPES.length).optional().describe("Default: all extension types."),
      campaign_ids: campaignIds.optional(),
      limit: z.number().int().min(1).max(1000).default(200),
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    period: z.string(),
    rows: z.array(
      z.object({
        level: z.string(),
        campaign_id: z.string().nullable(),
        ad_group_id: z.string().nullable(),
        asset_id: z.string(),
        field_type: z.string().nullable(),
        status: z.string().nullable(),
        content: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
        performance: perfSchema.describe("The ads this asset served with, including clicks elsewhere in the ad."),
        clicks_on_asset: z.number(),
        conversions_on_asset: z.number(),
        phone_calls: z.number(),
        phone_impressions: z.number(),
      }),
    ),
    by_field_type: z.array(z.object({ field_type: z.string(), links: z.number().int(), clicks_on_asset: z.number(), conversions_on_asset: z.number(), phone_calls: z.number() })),
    truncated: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const types = a.field_types ?? [...REPORT_FIELD_TYPES];
    const levels: Level[] = a.level === "all" ? ["account", "campaign", "ad_group"] : [a.level];
    const ids = a.campaign_ids?.length ? a.campaign_ids : null;
    const query = (level: Level, phone: boolean) => {
      const res = LEVELS[level];
      // campaign is a segmenting resource of customer_asset and ad_group_asset: filtering on campaign.id requires selecting it.
      const byCampaign = level === "ad_group" || (level === "account" && ids) ? ["campaign.id"] : [];
      const owner = level === "campaign" ? ["campaign_asset.campaign"] : level === "ad_group" ? ["ad_group_asset.ad_group"] : [];
      return ads.query(
        new Gaql()
          .select(...owner, ...byCampaign, `${res}.field_type`, `${res}.status`, ...assetFields, ...(phone ? PHONE_METRICS : [ON_ASSET, ...METRICS]))
          .from(res)
          .where(dateClause(a))
          .where(phone ? `${res}.field_type = 'CALL'` : `${res}.field_type IN ${lit.list(types.map((t) => `'${t}'`))}`)
          .where(`${res}.status != 'REMOVED'`)
          .where(!ids ? undefined : level === "campaign" ? `campaign_asset.campaign IN ${lit.list(ids.map((c) => lit.str(`customers/${ads.customerId}/campaigns/${lit.id(c)}`)))}` : `campaign.id IN ${lit.list(ids.map(lit.id))}`),
        { maxRows: 10_000 },
      );
    };
    const withPhone = types.includes("CALL");
    const results = await Promise.all(levels.flatMap((level) => [query(level, false).then((rows) => ({ level, rows })), ...(withPhone ? [query(level, true).then((rows) => ({ level, rows }))] : [])]));

    const acc = new Map<string, Acc>();
    for (const { level, rows } of results) {
      const res = LEVELS[level];
      for (const r of rows as Row[]) {
        const campaign_id = level === "campaign" ? tailId(pick(r, "campaign_asset.campaign")) : pick(r, "campaign.id") === undefined ? null : String(pick(r, "campaign.id"));
        const ad_group_id = level === "ad_group" ? tailId(pick(r, "ad_group_asset.ad_group")) : null;
        const asset_id = String(pick(r, "asset.id") ?? "");
        const field_type = str(r, `${res}.field_type`);
        const key = [level, campaign_id, ad_group_id, asset_id, field_type].join("|");
        const g = acc.get(key) ?? { level, campaign_id, ad_group_id, asset_id, field_type, status: str(r, `${res}.status`), content: assetContent(r), t: zero(), clicks_on_asset: 0, conversions_on_asset: 0, phone_calls: 0, phone_impressions: 0 };
        // Phone rows carry no other metrics, so adding them changes nothing else.
        add(g.t, r);
        if (pick(r, ON_ASSET) === true) {
          g.clicks_on_asset += num(pick(r, "metrics.clicks"));
          g.conversions_on_asset += num(pick(r, "metrics.conversions"));
        }
        g.phone_calls += num(pick(r, "metrics.phone_calls"));
        g.phone_impressions += num(pick(r, "metrics.phone_impressions"));
        acc.set(key, g);
      }
    }
    const all = [...acc.values()]
      .map((g) => ({ level: g.level, campaign_id: g.campaign_id, ad_group_id: g.ad_group_id, asset_id: g.asset_id, field_type: g.field_type, status: g.status, content: g.content, performance: perf(g.t), clicks_on_asset: g.clicks_on_asset, conversions_on_asset: Math.round(g.conversions_on_asset * 100) / 100, phone_calls: g.phone_calls, phone_impressions: g.phone_impressions }))
      .sort((x, y) => y.performance.cost - x.performance.cost || y.performance.impressions - x.performance.impressions || x.asset_id.localeCompare(y.asset_id));
    // Impressions and cost are shared by every asset that served with the same ad, so only per-asset measures are added up.
    const byType = new Map<string, { field_type: string; links: number; clicks_on_asset: number; conversions_on_asset: number; phone_calls: number }>();
    for (const r of all) {
      const t = r.field_type ?? "UNKNOWN";
      const b = byType.get(t) ?? { field_type: t, links: 0, clicks_on_asset: 0, conversions_on_asset: 0, phone_calls: 0 };
      b.links++;
      b.clicks_on_asset += r.clicks_on_asset;
      b.conversions_on_asset = Math.round((b.conversions_on_asset + r.conversions_on_asset) * 100) / 100;
      b.phone_calls += r.phone_calls;
      byType.set(t, b);
    }
    return { period: period(a), rows: all.slice(0, a.limit), by_field_type: [...byType.values()].sort((x, y) => x.field_type.localeCompare(y.field_type)), truncated: all.length > a.limit };
  },
});

export const assetReportTools = [getAssetPerformance];
