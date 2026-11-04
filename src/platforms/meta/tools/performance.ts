import { z } from "zod";
import { round } from "../../core/report-math";
import type { MetaRow } from "../client";
import {
  INSIGHTS_ROW_CAP,
  attributionNote,
  baseOf,
  computeMetrics,
  conversionActionInput,
  conversionTypes,
  conversionTypesOutput,
  datesMsg,
  datesOk,
  fetchInsights,
  insightsDateFields,
  insightsPeriod,
  metricsShape,
  metricsOf,
} from "../insights";
import { accountId, metaId, metaRead, s } from "./common";

const COMMON =
  "Dates are in the ad account's time zone. Conversions use the unified attribution setting (each ad set's own attribution window), so numbers match Ads Manager. Conversions count only the action types listed in conversion_types (see conversion_action); clicks, video views and other engagement are never counted as conversions. Money is in the account's currency. CTR, CPC, CPM, cost per conversion and ROAS are calculated from the base figures and are null when the divisor is zero. Fetched live from the Marketing API Insights.";

const header = {
  period: z.string(),
  attribution: z.string(),
  conversion_types: conversionTypesOutput,
};
const dateCols = { date_start: z.string().nullable(), date_stop: z.string().nullable() };
const perfInput = {
  account_id: accountId,
  ...insightsDateFields,
  conversion_action: conversionActionInput,
  daily: z.boolean().default(false).describe("One row per object per day (time_increment=1) instead of one row for the whole period."),
  limit: z.number().int().min(1).max(500).default(100),
};

const bySpend = (x: { spend: number; date_start: string | null }, y: { spend: number; date_start: string | null }) => y.spend - x.spend || String(x.date_start).localeCompare(String(y.date_start));

// ---------------------------------------------------------------------------------------------------------------
const campaignPerfRow = z.object({ campaign_id: z.string().min(1), name: z.string().nullable().describe("Untrusted text from Meta."), ...dateCols, ...metricsShape });

export const getMetaCampaignPerformance = metaRead({
  name: "get_meta_campaign_performance",
  title: "Meta campaign performance",
  description: `Campaign-level performance for a period, ordered by spend: spend, impressions, reach, frequency, clicks, link clicks, CTR, CPC, CPM, conversions, cost per conversion, conversion value and ROAS. Optional campaign_ids filter and daily breakdown. ${COMMON}`,
  input: z.object({ ...perfInput, campaign_ids: z.array(metaId).min(1).max(50).optional().describe("Only these campaigns (up to 50).") }).refine(datesOk, datesMsg),
  output: z.object({ ...header, campaigns: z.array(campaignPerfRow), returned: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const { params, period } = insightsPeriod(a, ctx.account?.timeZone ?? null);
    const types = conversionTypes(a.conversion_action);
    // Read from the ad account's own insights edge, so every row belongs to this account; the id filter is applied here.
    const { rows, truncated } = await fetchInsights(m, { objectPath: m.adAccountId, level: "campaign", period: params, daily: a.daily });
    const want = a.campaign_ids ? new Set(a.campaign_ids) : null;
    const all = rows
      .filter((r) => !want || want.has(String(r.campaign_id)))
      .map((r) => ({ campaign_id: String(r.campaign_id ?? ""), name: s(r, "campaign_name"), date_start: s(r, "date_start"), date_stop: s(r, "date_stop"), ...metricsOf(r, types) }))
      .sort(bySpend);
    const shown = all.slice(0, a.limit);
    return { period, attribution: attributionNote, conversion_types: types, campaigns: shown, returned: shown.length, truncated: truncated || all.length > shown.length };
  },
});

// ---------------------------------------------------------------------------------------------------------------
const adsetPerfRow = z.object({
  ad_set_id: z.string().min(1),
  name: z.string().nullable().describe("Untrusted text from Meta."),
  campaign_id: z.string().nullable(),
  campaign_name: z.string().nullable().describe("Untrusted text from Meta."),
  ...dateCols,
  ...metricsShape,
});

export const getMetaAdsetPerformance = metaRead({
  name: "get_meta_adset_performance",
  title: "Meta ad set performance",
  description: `Ad set-level performance for a period, ordered by spend, with the same metrics as get_meta_campaign_performance. Optional campaign_id (only that campaign's ad sets) and daily breakdown. ${COMMON}`,
  input: z.object({ ...perfInput, campaign_id: metaId.optional().describe("Only this campaign's ad sets.") }).refine(datesOk, datesMsg),
  output: z.object({ ...header, ad_sets: z.array(adsetPerfRow), returned: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const { params, period } = insightsPeriod(a, ctx.account?.timeZone ?? null);
    const types = conversionTypes(a.conversion_action);
    if (a.campaign_id) await m.getOwned(a.campaign_id, ["id"], "campaign");
    const { rows, truncated } = await fetchInsights(m, { objectPath: a.campaign_id ?? m.adAccountId, level: "adset", period: params, daily: a.daily });
    const all = rows
      .map((r) => ({ ad_set_id: String(r.adset_id ?? ""), name: s(r, "adset_name"), campaign_id: s(r, "campaign_id"), campaign_name: s(r, "campaign_name"), date_start: s(r, "date_start"), date_stop: s(r, "date_stop"), ...metricsOf(r, types) }))
      .sort(bySpend);
    const shown = all.slice(0, a.limit);
    return { period, attribution: attributionNote, conversion_types: types, ad_sets: shown, returned: shown.length, truncated: truncated || all.length > shown.length };
  },
});

// ---------------------------------------------------------------------------------------------------------------
/** An ad is flagged when its CTR is below this fraction of its campaign's average CTR. */
export const CTR_RATIO = 0.5;

const adPerfRow = z.object({
  ad_id: z.string().min(1),
  name: z.string().nullable().describe("Untrusted text from Meta."),
  ad_set_id: z.string().nullable(),
  campaign_id: z.string().nullable(),
  campaign_name: z.string().nullable().describe("Untrusted text from Meta."),
  ...metricsShape,
  campaign_ctr: z.number().nullable().describe("The campaign's average CTR used by the CTR rule (null when it has no impressions)."),
  flags: z.array(z.enum(["spend_without_conversions", "ctr_far_below_campaign"])),
});

export const analyzeMetaAdPerformance = metaRead({
  name: "analyze_meta_ad_performance",
  title: "Analyze Meta ad performance",
  description:
    `Ranks the ads of a Meta ad account by spend for a period and marks ads that match two fixed rules over real metrics. These are rules to review, not recommendations or predictions: check each ad before changing it. ` +
    `Rule spend_without_conversions: spend >= min_spend and conversions = 0. ` +
    `Rule ctr_far_below_campaign: the ad has at least min_impressions impressions, its campaign has at least 2 ads with impressions in the report, and the ad's CTR (clicks / impressions) is strictly below ${CTR_RATIO} x its campaign's average CTR, where the campaign average is the campaign's total clicks / total impressions over all of its ads in this report (including the ad itself). ` +
    `Covers up to ${INSIGHTS_ROW_CAP} ads; covers_all_ads says whether that was all of them. ${COMMON}`,
  input: z
    .object({
      account_id: accountId,
      ...insightsDateFields,
      conversion_action: conversionActionInput,
      campaign_id: metaId.optional().describe("Only this campaign's ads."),
      min_spend: z.number().min(0).max(1_000_000).default(10).describe("Minimum spend, in the account's currency, for the spend_without_conversions rule."),
      min_impressions: z.number().int().min(1).max(10_000_000).default(1000).describe("Minimum impressions for the ctr_far_below_campaign rule."),
      flagged_only: z.boolean().default(false).describe("Return only ads that match a rule."),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    ...header,
    rules: z.array(z.string()),
    ads_analyzed: z.number(),
    covers_all_ads: z.boolean(),
    analyzed_spend: z.number(),
    flagged_counts: z.object({ spend_without_conversions: z.number(), ctr_far_below_campaign: z.number() }),
    flagged_spend_without_conversions: z.number().describe("Spend of the ads flagged spend_without_conversions."),
    ads: z.array(adPerfRow).describe("Ordered by spend, highest first."),
    returned: z.number(),
  }),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const { params, period } = insightsPeriod(a, ctx.account?.timeZone ?? null);
    const types = conversionTypes(a.conversion_action);
    if (a.campaign_id) await m.getOwned(a.campaign_id, ["id"], "campaign");
    const { rows, truncated } = await fetchInsights(m, { objectPath: a.campaign_id ?? m.adAccountId, level: "ad", period: params });

    const ads = rows.map((r: MetaRow) => ({ r, b: baseOf(r, types), campaign: String(r.campaign_id ?? "") }));
    const camp = new Map<string, { clicks: number; impressions: number; ads: number }>();
    for (const x of ads) {
      const c = camp.get(x.campaign) ?? { clicks: 0, impressions: 0, ads: 0 };
      c.clicks += x.b.clicks;
      c.impressions += x.b.impressions;
      if (x.b.impressions > 0) c.ads += 1;
      camp.set(x.campaign, c);
    }
    // Rules use the unrounded figures, so the boundaries are exact.
    const evaluated = ads.map((x) => {
      const c = camp.get(x.campaign)!;
      const flags: ("spend_without_conversions" | "ctr_far_below_campaign")[] = [];
      if (x.b.spend >= a.min_spend && x.b.conversions === 0) flags.push("spend_without_conversions");
      if (x.b.impressions >= a.min_impressions && c.ads >= 2 && c.impressions > 0 && x.b.clicks * c.impressions < CTR_RATIO * c.clicks * x.b.impressions) flags.push("ctr_far_below_campaign");
      return {
        ad_id: String(x.r.ad_id ?? ""),
        name: s(x.r, "ad_name"),
        ad_set_id: s(x.r, "adset_id"),
        campaign_id: s(x.r, "campaign_id"),
        campaign_name: s(x.r, "campaign_name"),
        ...computeMetrics(x.b),
        campaign_ctr: c.impressions > 0 ? round(c.clicks / c.impressions) : null,
        flags,
        _spend: x.b.spend,
      };
    });
    evaluated.sort((x, y) => y._spend - x._spend);
    const count = (f: string) => evaluated.filter((e) => e.flags.includes(f as never)).length;
    const shown = evaluated.filter((e) => !a.flagged_only || e.flags.length > 0).slice(0, a.limit).map(({ _spend, ...rest }) => rest);
    return {
      period,
      attribution: attributionNote,
      conversion_types: types,
      rules: [
        `spend_without_conversions: spend >= ${a.min_spend} and conversions = 0`,
        `ctr_far_below_campaign: impressions >= ${a.min_impressions}, campaign has >= 2 ads with impressions, and ctr < ${CTR_RATIO} x campaign average ctr`,
      ],
      ads_analyzed: evaluated.length,
      covers_all_ads: !truncated,
      analyzed_spend: round(evaluated.reduce((t, e) => t + e._spend, 0), 2)!,
      flagged_counts: { spend_without_conversions: count("spend_without_conversions"), ctr_far_below_campaign: count("ctr_far_below_campaign") },
      flagged_spend_without_conversions: round(evaluated.filter((e) => e.flags.includes("spend_without_conversions")).reduce((t, e) => t + e._spend, 0), 2)!,
      ads: shown,
      returned: shown.length,
    };
  },
});

export const performanceTools = [getMetaCampaignPerformance, getMetaAdsetPerformance, analyzeMetaAdPerformance];
