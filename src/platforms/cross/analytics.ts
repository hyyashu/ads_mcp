import { z } from "zod";
import { ToolError } from "../../mcp/errors";
import type { OtherAccount } from "../../mcp/tool";
import { type CampaignRow, type CampaignTraffic, fetchCampaignTraffic, fetchChannelTraffic, fetchGoogleAdsTraffic, type Ga4Client, type Ga4Services } from "../ga4/api";
import type { GoogleServices } from "../google/services";
import { Gaql, fromMicros, num, pick } from "../google/gaql";
import { str } from "../google/tools/common";
import type { MetaServices } from "../meta/services";
import {
  ADWORDS,
  AccountOut,
  type Coverage,
  CoverageOut,
  GA4_READ,
  META_AD_CAP,
  META_READ,
  type MetaAd,
  type MetaCampaign,
  PeriodOut,
  UTM_RULE,
  type ZoneOf,
  accountInfo,
  accountList,
  adsBetween,
  capList,
  crossRead,
  datesMsg,
  datesOk,
  idArg,
  idsArg,
  isDynamic,
  limitField,
  listOf,
  metaAds,
  metaCampaigns,
  metaDailySpend,
  newCoverage,
  periodFields,
  r2,
  ratio,
  requiredAccount,
  resolveCrossPeriod,
  round,
  utmKey,
} from "./common";
import { META_CONVERSIONS } from "./common";

// Combined tools built on GA4 (design §5.5): Meta traffic quality, conversion tracking comparison, channel mix, UTM tagging
// and paid search queries on site. Rules and caps: docs/superpowers/plans/2026-11-10-cross-plan.md.

const ga4Cross = crossRead<Ga4Services>();
const metaCross = crossRead<MetaServices>();
const frame = { period: PeriodOut, accounts: z.array(AccountOut), rules: z.array(z.string()), coverage: CoverageOut };
const GA4_CAP = 10_000;
const ga4Period = (p: { start_date: string; end_date: string }) => ({ date_range: "LAST_28_DAYS" as const, start_date: p.start_date, end_date: p.end_date });
const ga4Zone = (ga4: Ga4Client, fallback: string | null) => ga4.timeZone ?? fallback;
const zoneOf = (x: OtherAccount<unknown>): ZoneOf => ({ source: x.account.platform, account: x.account.externalId, time_zone: x.account.timeZone });
const ga4Source = (label: string, r: { returned: number; row_count: number; truncated: boolean }) => ({ source: label, rows_read: r.returned, complete: !r.truncated, note: r.truncated ? `GA4 has ${r.row_count} rows; the ${r.returned} with the most sessions were read.` : null });

// ------------------------------------------------------------------------------------------------ Meta ↔ GA4 by UTM
interface CampaignUtm {
  ads: number;
  pairs: Map<string, { source: string; campaign: string }>;
  dynamic: Set<string>;
  missing: number;
}
/** UTM source/campaign pairs per Meta campaign, from its ads. Dynamic parameters and missing values are counted, not guessed. */
export function utmsByCampaign(ads: MetaAd[]): Map<string, CampaignUtm> {
  const out = new Map<string, CampaignUtm>();
  for (const ad of ads) {
    const c = out.get(ad.campaign_id) ?? { ads: 0, pairs: new Map(), dynamic: new Set<string>(), missing: 0 };
    c.ads++;
    const { utm_source: src, utm_campaign: camp } = ad.utm;
    if (isDynamic(src) || isDynamic(camp)) c.dynamic.add(`utm_source=${src ?? ""}&utm_campaign=${camp ?? ""}`.slice(0, 300));
    else if (!src || !camp) c.missing++;
    else {
      const k = `${utmKey(src)}|${utmKey(camp)}`;
      if (!c.pairs.has(k)) c.pairs.set(k, { source: src, campaign: camp }); // spellings that differ only by case are one pair, shown as first seen
    }
    out.set(ad.campaign_id, c);
  }
  return out;
}

interface Ga4Agg {
  sessions: number;
  engaged_sessions: number;
  key_events: number;
  total_revenue: number;
  rows: number;
}
const emptyAgg = (): Ga4Agg => ({ sessions: 0, engaged_sessions: 0, key_events: 0, total_revenue: 0, rows: 0 });
const addRow = (a: Ga4Agg, r: CampaignRow) => {
  a.sessions += r.sessions ?? 0;
  a.engaged_sessions += r.engaged_sessions ?? 0;
  a.key_events += r.key_events ?? 0;
  a.total_revenue += r.total_revenue ?? 0;
  a.rows++;
};
const Ga4AggOut = z.object({ sessions: z.number(), engaged_sessions: z.number(), engagement_rate: z.number().nullable().describe("engaged_sessions / sessions over the matched rows."), key_events: z.number(), total_revenue: z.number(), ga4_rows: z.number().int() });
const aggOut = (a: Ga4Agg) => ({ sessions: a.sessions, engaged_sessions: a.engaged_sessions, engagement_rate: round(ratio(a.engaged_sessions, a.sessions)), key_events: round(a.key_events, 2)!, total_revenue: r2(a.total_revenue), ga4_rows: a.rows });

const META_LIKE = /(facebook|^fb$|^fb\.|instagram|^ig$|^meta$|^an$|audience.?network)/i;
const UnmatchedCampaign = z.object({ campaign_id: z.string(), name: z.string().nullable(), spend: z.number(), reason: z.enum(["no_ads_read", "no_utm_source_or_campaign", "dynamic_parameter", "no_ga4_sessions"]), detail: z.string() });
type Unmatched = z.infer<typeof UnmatchedCampaign>;

/** Joins Meta campaigns to GA4 manual-UTM rows. Returns per-campaign aggregates, the unmatched campaigns and GA4 rows not claimed. */
function joinMetaGa4(campaigns: MetaCampaign[], ads: { ads: MetaAd[]; truncated: boolean }, ga4: CampaignTraffic) {
  const utms = utmsByCampaign(ads.ads);
  const rowsByKey = new Map<string, CampaignRow[]>();
  for (const r of ga4.rows) {
    const k = `${utmKey(r.source)}|${utmKey(r.campaign)}`;
    rowsByKey.set(k, [...(rowsByKey.get(k) ?? []), r]);
  }
  const claimed = new Set<string>();
  const matched: { c: MetaCampaign; agg: Ga4Agg; utm: { source: string; campaign: string }[]; ads: number; dynamic: number; missing: number }[] = [];
  const unmatched: Unmatched[] = [];
  for (const c of campaigns) {
    const u = utms.get(c.campaign_id);
    const base = { campaign_id: c.campaign_id, name: c.name, spend: r2(c.spend) };
    if (!u) {
      unmatched.push({ ...base, reason: "no_ads_read", detail: ads.truncated ? `None of its ads were among the ${META_AD_CAP} ads read.` : "No ads of this campaign were returned." });
      continue;
    }
    if (!u.pairs.size) {
      if (u.dynamic.size) unmatched.push({ ...base, reason: "dynamic_parameter", detail: `UTM values use Meta dynamic parameters, which are not resolved here: ${[...u.dynamic].slice(0, 3).join("; ")}` });
      else unmatched.push({ ...base, reason: "no_utm_source_or_campaign", detail: `${u.missing} of ${u.ads} ads have no utm_source or no utm_campaign in their link or url_tags.` });
      continue;
    }
    const agg = emptyAgg();
    for (const k of u.pairs.keys()) {
      for (const r of rowsByKey.get(k) ?? []) addRow(agg, r);
      if (rowsByKey.has(k)) claimed.add(k);
    }
    if (!agg.rows) {
      unmatched.push({ ...base, reason: "no_ga4_sessions", detail: `GA4 has no sessions with ${[...u.pairs.values()].map((p) => `utm_source=${p.source}, utm_campaign=${p.campaign}`).slice(0, 3).join("; ")} in the period${ga4.truncated ? " among the rows read" : ""}.` });
      continue;
    }
    matched.push({ c, agg, utm: [...u.pairs.values()], ads: u.ads, dynamic: u.dynamic.size, missing: u.missing });
  }
  const unclaimed = ga4.rows.filter((r) => META_LIKE.test(r.source.trim()) && !claimed.has(`${utmKey(r.source)}|${utmKey(r.campaign)}`));
  return { matched, unmatched, unclaimed };
}
const UnclaimedRow = z.object({ source: z.string(), medium: z.string(), campaign: z.string(), sessions: z.number().nullable(), key_events: z.number().nullable() });
const unclaimedOut = (r: CampaignRow) => ({ source: r.source, medium: r.medium, campaign: r.campaign, sessions: r.sessions, key_events: r.key_events });

// ------------------------------------------------------------------------------------- analyze_meta_traffic_quality
const MetaQualityRow = z.object({
  campaign_id: z.string(),
  name: z.string().nullable(),
  meta: z.object({ spend: z.number(), clicks: z.number(), link_clicks: z.number(), conversions: z.number() }),
  utm: z.array(z.object({ source: z.string(), campaign: z.string() })),
  ga4: Ga4AggOut,
  sessions_per_link_click: z.number().nullable().describe("GA4 sessions / Meta link clicks; below 1 is normal (not every click starts a tracked session)."),
  ads_without_usable_utm: z.number().int(),
});

export const analyzeMetaTrafficQuality = metaCross("meta_ads", [META_READ, GA4_READ], {
  name: "analyze_meta_traffic_quality",
  title: "What Meta clicks do on the site",
  description:
    "Per Meta campaign: spend, link clicks and Meta conversions next to what GA4 records for its UTM-tagged sessions (sessions, engagement rate, key events, revenue). GA4 has no Meta dimensions, so campaigns are matched only through utm_source and utm_campaign in their ads' links and url_tags; campaigns that cannot be matched are listed with the reason, and Meta-looking GA4 traffic no campaign claims is listed too. States period, time zones and rules.",
  input: z.object({ account_id: z.string().min(1), property_account_id: idArg("GA4 property"), ...periodFields, limit: limitField }).refine(datesOk, datesMsg),
  output: z.object({
    ...frame,
    currency_code: z.string().nullable().describe("Meta spend currency."),
    ga4_currency_code: z.string().nullable().describe("GA4 revenue currency."),
    summary: z.object({ campaigns: z.number().int(), matched: z.number().int(), unmatched: z.number().int(), matched_spend_share: z.number().nullable() }),
    campaigns: listOf(MetaQualityRow),
    unmatched: z.object({ campaigns: listOf(UnmatchedCampaign), ga4_meta_like_rows_not_claimed: listOf(UnclaimedRow) }),
  }),
  handler: async (a, ctx) => {
    const own = ctx.account!;
    const prop = await requiredAccount<Ga4Services>(ctx, "google_analytics", a.property_account_id, "property_account_id");
    const ga4c = prop.services.ga4;
    const period = await resolveCrossPeriod(a, [{ source: "meta_ads", account: own.externalId, time_zone: own.timeZone }, { source: "google_analytics", account: prop.account.externalId, time_zone: ga4Zone(ga4c, prop.account.timeZone) }]);
    const m = ctx.services.meta;
    const [camps, ads, ga4] = await Promise.all([metaCampaigns(m, period, own.timeZone), metaAds(m), fetchCampaignTraffic(ga4c, { period: ga4Period(period), utm_only: true, limit: GA4_CAP })]);
    const { matched, unmatched, unclaimed } = joinMetaGa4(camps.campaigns, ads, ga4);
    const rows = matched
      .map((x) => ({ campaign_id: x.c.campaign_id, name: x.c.name, meta: { spend: r2(x.c.spend), clicks: x.c.clicks, link_clicks: x.c.link_clicks, conversions: round(x.c.conversions, 2)! }, utm: x.utm, ga4: aggOut(x.agg), sessions_per_link_click: round(ratio(x.agg.sessions, x.c.link_clicks)), ads_without_usable_utm: x.dynamic + x.missing }))
      .sort((p, q) => q.meta.spend - p.meta.spend || p.campaign_id.localeCompare(q.campaign_id));
    unmatched.sort((p, q) => q.spend - p.spend || p.campaign_id.localeCompare(q.campaign_id));
    const spend = camps.campaigns.reduce((s, c) => s + c.spend, 0);
    const coverage = newCoverage();
    coverage.sources.push(
      { source: "meta_ads campaign insights", rows_read: camps.campaigns.length, complete: !camps.truncated, note: camps.truncated ? "Insights rows were capped at 2,000 campaigns." : null },
      { source: "meta_ads ads (links, url_tags)", rows_read: ads.ads.length, complete: !ads.truncated, note: ads.truncated ? `Only the first ${META_AD_CAP} ads were read.` : null },
      ga4Source("google_analytics manual UTM traffic", ga4),
    );
    coverage.notes.push(...ga4.data_quality.notes, "Meta conversions use Meta's unified attribution setting; GA4 key events use GA4's attribution, so the two are not expected to be equal.");
    return {
      period,
      accounts: [accountInfo("meta_ads", own), accountInfo("ga4_property", prop.account)],
      rules: [UTM_RULE, "Campaigns are those with insights (spend or delivery) in the period. A campaign whose ads carry several UTM pairs is matched to all of them.", `Meta conversions count: ${META_CONVERSIONS.join(", ")}.`, "Meta-like GA4 sources: facebook, fb, instagram, ig, meta, an, audience network (case-insensitive)."],
      coverage,
      currency_code: own.currencyCode,
      ga4_currency_code: ga4.currency_code,
      summary: { campaigns: camps.campaigns.length, matched: rows.length, unmatched: unmatched.length, matched_spend_share: round(ratio(rows.reduce((s, r) => s + r.meta.spend, 0), spend)) },
      campaigns: capList(rows, a.limit),
      unmatched: { campaigns: capList(unmatched, a.limit), ga4_meta_like_rows_not_claimed: capList(unclaimed.map(unclaimedOut), a.limit) },
    };
  },
});

// ------------------------------------------------------------------------------------- compare_conversion_tracking
const ADS_CAMPAIGN_CAP = 10_000;
const CompareRow = z.object({
  platform: z.enum(["google_ads", "meta_ads"]),
  account_id: z.string(),
  campaign_id: z.string(),
  name: z.string().nullable(),
  platform_conversions: z.number().describe("Google Ads: metrics.conversions_by_conversion_date (dated by conversion). Meta: default conversion action types, unified attribution."),
  platform_conversions_by_click_date: z.number().nullable().describe("Google Ads metrics.conversions (dated by the ad click); null for Meta."),
  ga4_key_events: z.number(),
  gap: z.number().describe("platform_conversions - ga4_key_events."),
  relative_gap: z.number().nullable().describe("|gap| / the larger of the two; null when both are 0."),
  flagged: z.boolean(),
});
const REASONS = [
  "Attribution: Google Ads and Meta credit their own ad clicks/views (Meta also view-through, per the ad set's attribution setting); GA4 key events are counted on sessions and credited by GA4's own model, across all channels.",
  "Dates: Google Ads metrics.conversions is reported on the ad-click date; conversions_by_conversion_date (used here) on the conversion date; GA4 on the event date. Late conversions inside a conversion window keep changing past periods.",
  "What is counted: Google Ads 'conversions' include only actions counted in the Conversions column (include_in_conversions_metric), possibly imported or offline ones; GA4 key events here are all key events of the property.",
  "Counting: one vs every conversion per click (Google Ads), once per event vs once per session (GA4 key events).",
  "Time zones: each source closes its days in its own zone (see period.time_zones).",
  "Tracking loss: consent choices, ad blockers and missing tags affect each side differently; GA4 needs the Google Ads link and auto-tagging (gclid) to attribute sessions to Google Ads campaigns.",
];

export const compareConversionTracking = ga4Cross("google_analytics", [GA4_READ, ADWORDS, META_READ], {
  name: "compare_conversion_tracking",
  title: "Compare ad platform conversions with GA4",
  description:
    "Per campaign of the Google Ads and/or Meta accounts linked to this GA4 property (or named): conversions the ad platform reports, GA4 key events for the same campaign's sessions, the gap, and a flag when the gap is larger than gap_threshold. Google Ads campaigns are joined on campaign id (GA4's Google Ads dimensions), Meta campaigns through UTM tags. Lists the known reasons a gap is normal and never says which side is right.",
  input: z
    .object({
      account_id: z.string().min(1),
      google_ads_account_ids: idsArg("Google Ads accounts"),
      meta_account_ids: idsArg("Meta ad accounts"),
      ...periodFields,
      gap_threshold: z.number().min(0).max(1).default(0.25).describe("Flag when |gap| / the larger count exceeds this."),
      min_conversions: z.number().min(0).max(1_000_000).default(5).describe("Flag only when the larger of the two counts is at least this."),
      limit: limitField,
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    ...frame,
    summary: z.object({ campaigns_compared: z.number().int(), flagged: z.number().int(), google_ads_conversions: z.number(), google_ads_ga4_key_events: z.number(), meta_conversions: z.number(), meta_ga4_key_events: z.number() }),
    campaigns: listOf(CompareRow),
    reasons_a_gap_can_be_normal: z.array(z.string()),
    unmatched: z.object({ meta_campaigns: listOf(UnmatchedCampaign), ga4_google_ads_campaigns_not_in_accounts: listOf(z.object({ campaign_id: z.string(), campaign: z.string(), key_events: z.number().nullable(), sessions: z.number().nullable() })) }),
  }),
  handler: async (a, ctx) => {
    const ga4 = ctx.services.ga4;
    const [gAds, metas] = await Promise.all([accountList<GoogleServices>(ctx, "google_ads", a.google_ads_account_ids), accountList<MetaServices>(ctx, "meta_ads", a.meta_account_ids)]);
    if (!gAds.length && !metas.length) throw new ToolError("invalid_argument", "No Google Ads or Meta ad account is linked to this GA4 property. Link one on the Connections page (owners and admins), or pass google_ads_account_ids / meta_account_ids.");
    const own = ctx.account!;
    const period = await resolveCrossPeriod(a, [{ source: "google_analytics", account: own.externalId, time_zone: ga4Zone(ga4, own.timeZone) }, ...gAds.map(zoneOf), ...metas.map(zoneOf)]);
    const coverage = newCoverage();
    const rows: z.infer<typeof CompareRow>[] = [];
    const flag = (p: number, g: number) => {
      const big = Math.max(p, g);
      const rel = big > 0 ? round(Math.abs(p - g) / big)! : null;
      return { relative_gap: rel, flagged: big >= a.min_conversions && rel !== null && rel > a.gap_threshold };
    };
    const totals = { google_ads_conversions: 0, google_ads_ga4_key_events: 0, meta_conversions: 0, meta_ga4_key_events: 0 };
    let notInAccounts: { campaign_id: string; campaign: string; key_events: number | null; sessions: number | null }[] = [];
    if (gAds.length) {
      const traffic = await fetchGoogleAdsTraffic(ga4, { period: ga4Period(period), level: "campaign", include_cost: false, limit: GA4_CAP });
      coverage.sources.push(ga4Source("google_analytics Google Ads campaigns", traffic));
      coverage.notes.push(...traffic.data_quality.notes, ...(traffic.note ? [traffic.note] : []));
      const ga4ById = new Map<string, number>();
      for (const r of traffic.rows) ga4ById.set(r.campaign_id, (ga4ById.get(r.campaign_id) ?? 0) + (r.key_events ?? 0));
      const known = new Set<string>();
      for (const acc of gAds) {
        const q = new Gaql().select("campaign.id", "campaign.name", "metrics.conversions_by_conversion_date", "metrics.conversions").from("campaign").where(adsBetween(period)).orderBy("campaign.id").limit(ADS_CAMPAIGN_CAP);
        const res = await acc.services.ads.query(q, { maxRows: ADS_CAMPAIGN_CAP });
        coverage.sources.push({ source: `google_ads campaigns ${acc.account.externalId}`, rows_read: res.length, complete: res.length < ADS_CAMPAIGN_CAP, note: null });
        for (const r of res) {
          const id = str(r, "campaign.id") ?? "";
          known.add(id);
          const p = round(num(pick(r, "metrics.conversions_by_conversion_date")), 2)!;
          const g = round(ga4ById.get(id) ?? 0, 2)!;
          totals.google_ads_conversions += p;
          totals.google_ads_ga4_key_events += g;
          rows.push({ platform: "google_ads", account_id: acc.account.id, campaign_id: id, name: str(r, "campaign.name"), platform_conversions: p, platform_conversions_by_click_date: round(num(pick(r, "metrics.conversions")), 2), ga4_key_events: g, gap: round(p - g, 2)!, ...flag(p, g) });
        }
      }
      notInAccounts = traffic.rows.filter((r) => !known.has(r.campaign_id)).map((r) => ({ campaign_id: r.campaign_id, campaign: r.campaign, key_events: r.key_events, sessions: r.sessions }));
      if (notInAccounts.length) coverage.notes.push("GA4 has Google Ads campaigns that are not in the accounts compared (another linked Ads account, or '(not set)'); they are listed under unmatched.");
    } else coverage.not_checked.push({ source: "google_ads", reason: "No Google Ads account linked to this property (or named)." });

    let metaUnmatched: Unmatched[] = [];
    if (metas.length) {
      const utmTraffic = await fetchCampaignTraffic(ga4, { period: ga4Period(period), utm_only: true, limit: GA4_CAP });
      coverage.sources.push(ga4Source("google_analytics manual UTM traffic", utmTraffic));
      for (const acc of metas) {
        const m = acc.services.meta;
        const [camps, ads] = await Promise.all([metaCampaigns(m, period, acc.account.timeZone), metaAds(m)]);
        coverage.sources.push({ source: `meta_ads campaigns ${acc.account.externalId}`, rows_read: camps.campaigns.length, complete: !camps.truncated && !ads.truncated, note: ads.truncated ? `Only the first ${META_AD_CAP} ads were read for UTM tags.` : null });
        const j = joinMetaGa4(camps.campaigns, ads, utmTraffic);
        metaUnmatched = [...metaUnmatched, ...j.unmatched];
        for (const x of j.matched) {
          const p = round(x.c.conversions, 2)!;
          const g = round(x.agg.key_events, 2)!;
          totals.meta_conversions += p;
          totals.meta_ga4_key_events += g;
          rows.push({ platform: "meta_ads", account_id: acc.account.id, campaign_id: x.c.campaign_id, name: x.c.name, platform_conversions: p, platform_conversions_by_click_date: null, ga4_key_events: g, gap: round(p - g, 2)!, ...flag(p, g) });
        }
      }
    } else coverage.not_checked.push({ source: "meta_ads", reason: "No Meta ad account linked to this property (or named)." });

    rows.sort((x, y) => Number(y.flagged) - Number(x.flagged) || Math.abs(y.gap) - Math.abs(x.gap) || x.campaign_id.localeCompare(y.campaign_id));
    return {
      period,
      accounts: [accountInfo("ga4_property", own), ...gAds.map((x) => accountInfo("google_ads", x.account)), ...metas.map((x) => accountInfo("meta_ads", x.account))],
      rules: [
        "Google Ads ↔ GA4: on campaign id (GA4 sessionGoogleAdsCampaignId, which needs the Google Ads link and auto-tagging). GA4 side: keyEvents of those sessions.",
        UTM_RULE,
        `Flag: the larger of the two counts ≥ ${a.min_conversions} and |gap| / larger > ${a.gap_threshold}.`,
        "Campaigns with no platform conversions row in the period (no delivery) are not listed.",
      ],
      coverage,
      summary: { campaigns_compared: rows.length, flagged: rows.filter((r) => r.flagged).length, google_ads_conversions: r2(totals.google_ads_conversions), google_ads_ga4_key_events: r2(totals.google_ads_ga4_key_events), meta_conversions: r2(totals.meta_conversions), meta_ga4_key_events: r2(totals.meta_ga4_key_events) },
      campaigns: capList(rows, a.limit),
      reasons_a_gap_can_be_normal: REASONS,
      unmatched: { meta_campaigns: capList(metaUnmatched, a.limit), ga4_google_ads_campaigns_not_in_accounts: capList(notInAccounts, a.limit) },
    };
  },
});

// ------------------------------------------------------------------------------------------------- get_channel_mix
const SpendOut = z.object({ account: AccountOut, spend: z.number().describe("In this account's currency.") });

async function spendOf(x: OtherAccount<GoogleServices | MetaServices>, p: { start_date: string; end_date: string }): Promise<number> {
  if (x.account.platform === "google_ads") {
    const rows = await (x.services as GoogleServices).ads.query(new Gaql().select("metrics.cost_micros").from("customer").where(adsBetween(p)), { maxRows: 10 });
    return r2(rows.reduce((s, r) => s + fromMicros(pick(r, "metrics.cost_micros")), 0));
  }
  return r2([...(await metaDailySpend((x.services as MetaServices).meta, p, x.account.timeZone)).values()].reduce((s, v) => s + v, 0));
}

export const getChannelMix = ga4Cross("google_analytics", [GA4_READ, ADWORDS, META_READ], {
  name: "get_channel_mix",
  title: "Channel mix with ad spend",
  description:
    "GA4 sessions, key events and revenue per default channel group (paid, organic and others) with each channel's share of GA4's totals, plus the spend of the Google Ads and Meta accounts linked to this property (or named) for the same days. Spend is shown per ad account in its own currency and is not assigned to GA4 channels or added across currencies.",
  input: z.object({ account_id: z.string().min(1), google_ads_account_ids: idsArg("Google Ads accounts for spend"), meta_account_ids: idsArg("Meta ad accounts for spend"), ...periodFields }).refine(datesOk, datesMsg),
  output: z.object({
    ...frame,
    currency_code: z.string().nullable().describe("GA4 revenue currency."),
    channels: z.array(z.object({ channel: z.string(), sessions: z.number().nullable(), key_events: z.number().nullable(), total_revenue: z.number().nullable(), engagement_rate: z.number().nullable(), share_of_sessions: z.number().nullable(), share_of_key_events: z.number().nullable(), share_of_revenue: z.number().nullable() })),
    totals: z.object({ sessions: z.number().nullable(), key_events: z.number().nullable(), total_revenue: z.number().nullable() }).describe("GA4's own totals over all rows."),
    channels_truncated: z.boolean(),
    ad_spend: z.array(SpendOut),
  }),
  handler: async (a, ctx) => {
    const ga4 = ctx.services.ga4;
    const own = ctx.account!;
    const [gAds, metas] = await Promise.all([accountList<GoogleServices>(ctx, "google_ads", a.google_ads_account_ids), accountList<MetaServices>(ctx, "meta_ads", a.meta_account_ids)]);
    const spendAccounts: OtherAccount<GoogleServices | MetaServices>[] = [...gAds, ...metas];
    const period = await resolveCrossPeriod(a, [{ source: "google_analytics", account: own.externalId, time_zone: ga4Zone(ga4, own.timeZone) }, ...spendAccounts.map(zoneOf)]);
    const [ch, spends] = await Promise.all([fetchChannelTraffic(ga4, { period: ga4Period(period), limit: 100 }), Promise.all(spendAccounts.map((x) => spendOf(x, period)))]);
    const t = { sessions: ch.totals?.sessions ?? null, key_events: ch.totals?.keyEvents ?? null, total_revenue: ch.totals?.totalRevenue ?? null };
    const share = (v: number | null, total: number | null) => (v === null || total === null ? null : round(ratio(v, total)));
    const coverage: Coverage = newCoverage();
    coverage.sources.push(ga4Source("google_analytics channels", ch));
    for (const [i, x] of spendAccounts.entries()) coverage.sources.push({ source: `${x.account.platform} spend ${x.account.externalId}`, rows_read: 1, complete: true, note: `${spends[i]} ${x.account.currencyCode ?? "(currency unknown)"}` });
    if (!gAds.length) coverage.not_checked.push({ source: "google_ads", reason: "No Google Ads account linked to this property (or named)." });
    if (!metas.length) coverage.not_checked.push({ source: "meta_ads", reason: "No Meta ad account linked to this property (or named)." });
    coverage.notes.push(...ch.data_quality.notes, "GA4 'Paid Search' and 'Paid Social' include every engine or network, not just the linked accounts, so spend and channels are shown side by side only.");
    return {
      period,
      accounts: [accountInfo("ga4_property", own), ...spendAccounts.map((x) => accountInfo(x.account.platform === "google_ads" ? "spend_google_ads" : "spend_meta", x.account))],
      rules: ["Channels: GA4 sessionDefaultChannelGroup. Shares divide by GA4's totals over all rows (not the sum of the rows shown).", "Spend: Google Ads customer metrics.cost_micros; Meta account insights spend; each for the same dates in its own zone and currency."],
      coverage,
      currency_code: ch.currency_code,
      channels: ch.channels.map((c) => ({ channel: c.channel, sessions: c.sessions, key_events: c.key_events, total_revenue: c.total_revenue, engagement_rate: c.engagement_rate, share_of_sessions: share(c.sessions, t.sessions), share_of_key_events: share(c.key_events, t.key_events), share_of_revenue: share(c.total_revenue, t.total_revenue) })),
      totals: t,
      channels_truncated: ch.truncated,
      ad_spend: spendAccounts.map((x, i) => ({ account: accountInfo(x.account.platform === "google_ads" ? "spend_google_ads" : "spend_meta", x.account), spend: spends[i]! })),
    };
  },
});

// ------------------------------------------------------------------------------------------------ check_utm_tagging
const Finding = z.object({ severity: z.enum(["high", "medium", "info"]), source: z.string(), account: z.string(), rule: z.string(), message: z.string(), items: z.array(z.string()).max(50), items_total: z.number().int() });
type FindingT = z.infer<typeof Finding>;
const finding = (f: Omit<FindingT, "items" | "items_total">, items: string[] = []): FindingT => ({ ...f, items: items.slice(0, 50), items_total: items.length });
const hasUtm = (s: string | null) => !!s && /[?&{]?utm_(source|medium|campaign)=/i.test(s);

export const checkUtmTagging = ga4Cross("google_analytics", [GA4_READ, ADWORDS, META_READ], {
  name: "check_utm_tagging",
  title: "Check UTM tagging",
  description:
    "Checks how the Google Ads and Meta accounts linked to this GA4 property (or named) tag their clicks, and what GA4 receives: whether Google Ads auto-tagging is on and manual UTMs in tracking templates or final URL suffixes; Meta campaigns whose ads lack utm_source, utm_medium or utm_campaign, use several campaign values or dynamic parameters; and GA4 UTM values that differ only by letter case or have a source without a medium. Each finding names the rule and the items.",
  input: z.object({ account_id: z.string().min(1), google_ads_account_ids: idsArg("Google Ads accounts"), meta_account_ids: idsArg("Meta ad accounts"), ...periodFields }).refine(datesOk, datesMsg),
  output: z.object({ ...frame, findings: z.array(Finding), summary: z.object({ high: z.number().int(), medium: z.number().int(), info: z.number().int() }) }),
  handler: async (a, ctx) => {
    const ga4 = ctx.services.ga4;
    const own = ctx.account!;
    const [gAds, metas] = await Promise.all([accountList<GoogleServices>(ctx, "google_ads", a.google_ads_account_ids), accountList<MetaServices>(ctx, "meta_ads", a.meta_account_ids)]);
    const period = await resolveCrossPeriod(a, [{ source: "google_analytics", account: own.externalId, time_zone: ga4Zone(ga4, own.timeZone) }, ...gAds.map(zoneOf), ...metas.map(zoneOf)]);
    const findings: FindingT[] = [];
    const coverage = newCoverage();

    for (const acc of gAds) {
      const ads = acc.services.ads;
      const id = acc.account.externalId;
      const [cust] = await ads.query(new Gaql().select("customer.auto_tagging_enabled", "customer.tracking_url_template", "customer.final_url_suffix").from("customer").limit(1), { maxRows: 1 });
      const camps = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.tracking_url_template", "campaign.final_url_suffix").from("campaign").where("campaign.status != 'REMOVED'").orderBy("campaign.id").limit(10_000), { maxRows: 10_000 });
      coverage.sources.push({ source: `google_ads ${id} campaigns`, rows_read: camps.length, complete: camps.length < 10_000, note: null });
      const auto = pick(cust ?? {}, "customer.auto_tagging_enabled") === true;
      const acctManual = hasUtm(str(cust ?? {}, "customer.tracking_url_template")) || hasUtm(str(cust ?? {}, "customer.final_url_suffix"));
      const manual = camps.filter((r) => hasUtm(str(r, "campaign.tracking_url_template")) || hasUtm(str(r, "campaign.final_url_suffix"))).map((r) => `${str(r, "campaign.name") ?? ""} (${str(r, "campaign.id")})`);
      if (!auto) {
        const untagged = acctManual ? [] : camps.filter((r) => !hasUtm(str(r, "campaign.tracking_url_template")) && !hasUtm(str(r, "campaign.final_url_suffix"))).map((r) => `${str(r, "campaign.name") ?? ""} (${str(r, "campaign.id")})`);
        findings.push(finding({ severity: "high", source: "google_ads", account: id, rule: "auto_tagging_off", message: "Auto-tagging is off: clicks carry no gclid, so GA4 cannot fill its Google Ads dimensions (campaign, ad group, keyword, query) for this account." }));
        if (untagged.length) findings.push(finding({ severity: "high", source: "google_ads", account: id, rule: "no_auto_tagging_and_no_utm", message: "These campaigns have neither auto-tagging nor utm_ parameters in a campaign tracking template or final URL suffix (ad group and ad level templates are not read)." }, untagged));
      }
      if (auto && (manual.length || acctManual)) findings.push(finding({ severity: "info", source: "google_ads", account: id, rule: "manual_utm_with_auto_tagging", message: `Manual utm_ parameters are set ${acctManual ? "at account level" : "on these campaigns"} while auto-tagging is on; GA4 receives both, so check which one its reports use.` }, manual));
    }
    if (!gAds.length) coverage.not_checked.push({ source: "google_ads", reason: "No Google Ads account linked to this property (or named)." });

    for (const acc of metas) {
      const m = acc.services.meta;
      const id = acc.account.externalId;
      const [ads, campRows] = await Promise.all([metaAds(m), m.list(`${m.adAccountId}/campaigns`, { fields: "id,name" }, META_AD_CAP)]);
      coverage.sources.push({ source: `meta_ads ${id} ads`, rows_read: ads.ads.length, complete: !ads.truncated, note: ads.truncated ? `Only the first ${META_AD_CAP} ads were read.` : null });
      const names = new Map(campRows.map((r) => [String(r.id ?? ""), typeof r.name === "string" ? r.name : ""]));
      const label = (cid: string) => `${names.get(cid) ?? ""} (${cid})`;
      const byCamp = new Map<string, MetaAd[]>();
      for (const ad of ads.ads) byCamp.set(ad.campaign_id, [...(byCamp.get(ad.campaign_id) ?? []), ad]);
      const untagged: string[] = [], partial: string[] = [], multi: string[] = [], dynamic: string[] = [];
      const sources = new Set<string>(), mediums = new Set<string>();
      for (const [cid, list] of byCamp) {
        const full = list.filter((x) => x.utm.utm_source && x.utm.utm_medium && x.utm.utm_campaign);
        if (!full.length) untagged.push(label(cid));
        else if (full.length < list.length) partial.push(`${label(cid)}: ${list.length - full.length} of ${list.length} ads lack a UTM key`);
        const camps = new Set(full.map((x) => x.utm.utm_campaign!));
        if (camps.size > 1) multi.push(`${label(cid)}: ${[...camps].slice(0, 5).join(", ")}`);
        if (list.some((x) => Object.values(x.utm).some(isDynamic))) dynamic.push(label(cid));
        for (const x of full) sources.add(x.utm.utm_source!), mediums.add(x.utm.utm_medium!);
      }
      if (untagged.length) findings.push(finding({ severity: "high", source: "meta_ads", account: id, rule: "campaign_untagged", message: "No ad in these campaigns has utm_source, utm_medium and utm_campaign in its link or url_tags, so GA4 cannot tell their clicks apart from other Meta traffic." }, untagged));
      if (partial.length) findings.push(finding({ severity: "medium", source: "meta_ads", account: id, rule: "campaign_partly_tagged", message: "Some ads in these campaigns lack a UTM key." }, partial));
      if (multi.length) findings.push(finding({ severity: "medium", source: "meta_ads", account: id, rule: "several_campaign_values", message: "Ads of one campaign send different utm_campaign values, which splits the campaign in GA4." }, multi));
      if (dynamic.length) findings.push(finding({ severity: "info", source: "meta_ads", account: id, rule: "dynamic_parameters", message: "These campaigns use Meta dynamic URL parameters ({{...}}) in UTM values; their resolved values are not checked here." }, dynamic));
      if (sources.size > 1) findings.push(finding({ severity: "info", source: "meta_ads", account: id, rule: "several_sources", message: `Ads use ${sources.size} different utm_source values.` }, [...sources]));
      if (mediums.size > 1) findings.push(finding({ severity: "info", source: "meta_ads", account: id, rule: "several_mediums", message: `Ads use ${mediums.size} different utm_medium values.` }, [...mediums]));
    }
    if (!metas.length) coverage.not_checked.push({ source: "meta_ads", reason: "No Meta ad account linked to this property (or named)." });

    const t = await fetchCampaignTraffic(ga4, { period: ga4Period(period), utm_only: true, limit: GA4_CAP });
    coverage.sources.push(ga4Source("google_analytics manual UTM traffic", t));
    coverage.notes.push(...t.data_quality.notes);
    for (const [field, key] of [["utm_source", "source"], ["utm_medium", "medium"], ["utm_campaign", "campaign"]] as const) {
      const groups = new Map<string, Map<string, number>>();
      for (const r of t.rows) {
        const v = r[key];
        if (!v || v === "(not set)") continue;
        const g = groups.get(utmKey(v)) ?? new Map<string, number>();
        g.set(v, (g.get(v) ?? 0) + (r.sessions ?? 0));
        groups.set(utmKey(v), g);
      }
      const variants = [...groups.values()].filter((g) => g.size > 1).map((g) => [...g.entries()].map(([v, n]) => `${v} (${n} sessions)`).join(" / "));
      if (variants.length) findings.push(finding({ severity: "medium", source: "google_analytics", account: own.externalId, rule: `${field}_case_variants`, message: `GA4 received ${field} values that differ only by letter case or spacing; GA4 reports them as separate rows.` }, variants));
    }
    const noMedium = t.rows.filter((r) => r.source && r.source !== "(not set)" && (!r.medium || r.medium === "(not set)")).map((r) => `${r.source} / ${r.campaign} (${r.sessions ?? 0} sessions)`);
    if (noMedium.length) findings.push(finding({ severity: "medium", source: "google_analytics", account: own.externalId, rule: "source_without_medium", message: "Sessions with a utm_source but no utm_medium: GA4's channel grouping relies on the medium, so these land in a less specific channel." }, noMedium));
    const rank = { high: 0, medium: 1, info: 2 };
    findings.sort((x, y) => rank[x.severity] - rank[y.severity]);
    return {
      period,
      accounts: [accountInfo("ga4_property", own), ...gAds.map((x) => accountInfo("google_ads", x.account)), ...metas.map((x) => accountInfo("meta_ads", x.account))],
      rules: [
        "Google Ads: customer.auto_tagging_enabled; utm_ parameters looked for in the account and campaign tracking_url_template and final_url_suffix (ad group and ad level are not read).",
        "Meta: UTM values from each ad's creative link plus url_tags (url_tags win). Tagged = utm_source, utm_medium and utm_campaign all present. All ads of the account are read, whatever their status.",
        "GA4: sessionManualSource / Medium / CampaignName for the period; values equal after lower-casing and trimming but written differently are reported.",
      ],
      coverage,
      findings,
      summary: { high: findings.filter((f) => f.severity === "high").length, medium: findings.filter((f) => f.severity === "medium").length, info: findings.filter((f) => f.severity === "info").length },
    };
  },
});

// -------------------------------------------------------------------------------------- analyze_paid_search_on_site
const QueryRow = z.object({ query: z.string(), campaign: z.string(), campaign_id: z.string(), sessions: z.number().nullable(), engagement_rate: z.number().nullable(), key_events: z.number().nullable(), session_key_event_rate: z.number().nullable(), total_revenue: z.number().nullable() });

export const analyzePaidSearchOnSite = ga4Cross("google_analytics", [GA4_READ], {
  name: "analyze_paid_search_on_site",
  title: "Paid search queries on the site",
  description:
    "Uses GA4's Google Ads query dimension (sessionGoogleAdsQuery) to show which paid search queries bring visitors who engage and convert on the site, sorted into fixed groups: converting (key events > 0), engaged without key events, and low engagement. Needs the property's Google Ads link and auto-tagging. Reports the share of sessions GA4 could not tie to a query.",
  input: z
    .object({
      account_id: z.string().min(1),
      ...periodFields,
      min_sessions: z.number().int().min(1).max(1_000_000).default(10).describe("Sessions a query needs to be put in the engaged or low-engagement group."),
      engaged_rate: z.number().min(0).max(1).default(0.5),
      low_rate: z.number().min(0).max(1).default(0.2),
      limit: limitField,
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    ...frame,
    currency_code: z.string().nullable(),
    summary: z.object({ queries: z.number().int(), sessions: z.number(), not_set_sessions: z.number().describe("Sessions with query '(not set)' (GA4 could not tie them to a query)."), not_set_share: z.number().nullable() }),
    converting: listOf(QueryRow),
    engaged_without_key_events: listOf(QueryRow),
    low_engagement: listOf(QueryRow),
  }),
  handler: async (a, ctx) => {
    const ga4 = ctx.services.ga4;
    const own = ctx.account!;
    const period = await resolveCrossPeriod(a, [{ source: "google_analytics", account: own.externalId, time_zone: ga4Zone(ga4, own.timeZone) }]);
    const t = await fetchGoogleAdsTraffic(ga4, { period: ga4Period(period), level: "query", include_cost: false, limit: GA4_CAP });
    const rows = t.rows.map((r) => ({ query: r.query ?? "", campaign: r.campaign, campaign_id: r.campaign_id, sessions: r.sessions, engagement_rate: r.engagement_rate, key_events: r.key_events, session_key_event_rate: r.session_key_event_rate, total_revenue: r.total_revenue }));
    const notSet = rows.filter((r) => r.query === "(not set)" || r.query === "");
    const real = rows.filter((r) => !(r.query === "(not set)" || r.query === ""));
    const converting = real.filter((r) => (r.key_events ?? 0) > 0).sort((x, y) => (y.key_events ?? 0) - (x.key_events ?? 0) || x.query.localeCompare(y.query));
    const engaged = real.filter((r) => !((r.key_events ?? 0) > 0) && (r.sessions ?? 0) >= a.min_sessions && (r.engagement_rate ?? 0) >= a.engaged_rate).sort((x, y) => (y.sessions ?? 0) - (x.sessions ?? 0));
    const low = real.filter((r) => !((r.key_events ?? 0) > 0) && (r.sessions ?? 0) >= a.min_sessions && r.engagement_rate !== null && r.engagement_rate < a.low_rate).sort((x, y) => (y.sessions ?? 0) - (x.sessions ?? 0));
    const total = rows.reduce((s, r) => s + (r.sessions ?? 0), 0);
    const ns = notSet.reduce((s, r) => s + (r.sessions ?? 0), 0);
    const coverage = newCoverage();
    coverage.sources.push(ga4Source("google_analytics Google Ads queries", t));
    coverage.notes.push(...t.data_quality.notes, ...(t.note ? [t.note] : []));
    return {
      period,
      accounts: [accountInfo("ga4_property", own)],
      rules: ["Rows are GA4 sessionGoogleAdsQuery per campaign (one query can appear under several campaigns).", "converting: key events > 0.", `engaged_without_key_events: no key events, sessions ≥ ${a.min_sessions}, engagement rate ≥ ${a.engaged_rate}.`, `low_engagement: no key events, sessions ≥ ${a.min_sessions}, engagement rate < ${a.low_rate}.`, "'(not set)' query rows are counted in the summary only."],
      coverage,
      currency_code: t.currency_code,
      summary: { queries: real.length, sessions: total, not_set_sessions: ns, not_set_share: round(ratio(ns, total)) },
      converting: capList(converting, a.limit),
      engaged_without_key_events: capList(engaged, a.limit),
      low_engagement: capList(low, a.limit),
    };
  },
});

