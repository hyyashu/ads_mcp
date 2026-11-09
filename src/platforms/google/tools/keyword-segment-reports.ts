import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Row } from "../client";
import { Gaql, fromMicros, lit, num, pick } from "../gaql";
import { tailId } from "./campaign-reads";
import { Money, accountId, campaignIds, dateClause, dateFields, datesMsg, datesOk, googleRead, idSchema, keywordItem, keywordKey, ratio, round, str } from "./common";
import { activeLists, attachedCampaigns, members } from "./negative-lists";
import { stateWrite } from "./write-kit";

/** Added by the project owner (2026-11-04) beyond the Adspirer inventory. Fields checked against the v26 field reference. */
const period = (a: { date_range: string; start_date?: string; end_date?: string }) => (a.start_date ? `${a.start_date}..${a.end_date}` : a.date_range);
const n = (r: Row, f: string): number | null => (pick(r, f) === undefined || pick(r, f) === null ? null : num(pick(r, f)));
const money = (r: Row, f: string): number | null => (pick(r, f) === undefined ? null : fromMicros(pick(r, f)));
const perfSchema = z.object({ impressions: z.number(), clicks: z.number(), cost: Money, conversions: z.number(), conversion_value: z.number(), ctr: z.number().nullable(), average_cpc: Money.nullable(), conversion_rate: z.number().nullable(), cost_per_conversion: Money.nullable(), roas: z.number().nullable() });
type Totals = { impressions: number; clicks: number; cost: number; conversions: number; value: number };
const add = (t: Totals, r: Row) => {
  t.impressions += num(pick(r, "metrics.impressions"));
  t.clicks += num(pick(r, "metrics.clicks"));
  t.cost += fromMicros(pick(r, "metrics.cost_micros"));
  t.conversions += num(pick(r, "metrics.conversions"));
  t.value += num(pick(r, "metrics.conversions_value"));
  return t;
};
const zero = (): Totals => ({ impressions: 0, clicks: 0, cost: 0, conversions: 0, value: 0 });
const perf = (t: Totals) => ({ impressions: t.impressions, clicks: t.clicks, cost: round(t.cost, 2)!, conversions: round(t.conversions, 2)!, conversion_value: round(t.value, 2)!, ctr: round(ratio(t.clicks, t.impressions)), average_cpc: round(ratio(t.cost, t.clicks), 2), conversion_rate: round(ratio(t.conversions, t.clicks)), cost_per_conversion: round(ratio(t.cost, t.conversions), 2), roas: round(ratio(t.value, t.cost)) });

// -------------------------------------------------------------------------------------------- get_keyword_performance
export const getKeywordPerformance = googleRead({
  name: "get_keyword_performance",
  title: "Keyword performance",
  description:
    "Search keywords with their status, match type, max CPC bid, Quality Score and its components (expected CTR, ad relevance, landing page experience), Google's first-page and top-of-page bid estimates, and performance for a period (impressions, clicks, cost, conversions, value, impression share), sorted by cost or another metric. Negative keywords are not included. Quality Score is Google's current value; null when Google has too little data. Fetched live.",
  input: z
    .object({
      account_id: accountId,
      ...dateFields,
      campaign_ids: campaignIds.optional(),
      ad_group_ids: z.array(idSchema).max(50).optional(),
      status: z.enum(["ENABLED", "PAUSED"]).optional(),
      min_impressions: z.number().int().min(0).max(10_000_000).default(0),
      max_quality_score: z.number().int().min(1).max(10).optional().describe("Only keywords with a Quality Score at or below this."),
      order_by: z.enum(["cost", "clicks", "conversions", "impressions"]).default("cost"),
      limit: z.number().int().min(1).max(1000).default(100),
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    period: z.string(),
    keywords: z.array(
      z.object({
        campaign_id: z.string().nullable(),
        ad_group_id: z.string().nullable(),
        criterion_id: z.string().min(1),
        text: z.string().nullable(),
        match_type: z.string().nullable(),
        status: z.string().nullable(),
        serving_status: z.string().nullable(),
        cpc_bid: Money.nullable(),
        quality_score: z.number().nullable(),
        expected_ctr: z.string().nullable(),
        ad_relevance: z.string().nullable(),
        landing_page_experience: z.string().nullable(),
        first_page_cpc: Money.nullable(),
        top_of_page_cpc: Money.nullable(),
        search_impression_share: z.number().nullable(),
        performance: perfSchema,
      }),
    ),
    returned: z.number(),
    truncated: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const c = "ad_group_criterion";
    const order = { cost: "metrics.cost_micros", clicks: "metrics.clicks", conversions: "metrics.conversions", impressions: "metrics.impressions" }[a.order_by];
    const rows = await ctx.services.ads.query(
      new Gaql()
        .select(
          "campaign.id", "ad_group.id", `${c}.criterion_id`, `${c}.keyword.text`, `${c}.keyword.match_type`, `${c}.status`, `${c}.system_serving_status`, `${c}.effective_cpc_bid_micros`,
          `${c}.quality_info.quality_score`, `${c}.quality_info.search_predicted_ctr`, `${c}.quality_info.creative_quality_score`, `${c}.quality_info.post_click_quality_score`,
          `${c}.position_estimates.first_page_cpc_micros`, `${c}.position_estimates.top_of_page_cpc_micros`,
          "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value", "metrics.search_impression_share",
        )
        .from("keyword_view")
        .where(dateClause(a))
        .where(`${c}.status != 'REMOVED'`)
        .where(`${c}.negative = FALSE`)
        .where(a.status && `${c}.status = '${a.status}'`)
        .where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined)
        .where(a.ad_group_ids?.length ? `ad_group.id IN ${lit.list(a.ad_group_ids.map(lit.id))}` : undefined)
        .where(a.min_impressions > 0 && `metrics.impressions >= ${lit.int(a.min_impressions)}`)
        .where(a.max_quality_score !== undefined && `${c}.quality_info.quality_score <= ${lit.int(a.max_quality_score)}`)
        .orderBy(order, "DESC")
        .limit(a.limit + 1),
      { maxRows: a.limit + 1, partial: true },
    );
    const shown = rows.slice(0, a.limit).map((r) => ({
      campaign_id: str(r, "campaign.id"),
      ad_group_id: str(r, "ad_group.id"),
      criterion_id: String(pick(r, `${c}.criterion_id`) ?? ""),
      text: str(r, `${c}.keyword.text`),
      match_type: str(r, `${c}.keyword.match_type`),
      status: str(r, `${c}.status`),
      serving_status: str(r, `${c}.system_serving_status`),
      cpc_bid: money(r, `${c}.effective_cpc_bid_micros`),
      quality_score: n(r, `${c}.quality_info.quality_score`),
      expected_ctr: str(r, `${c}.quality_info.search_predicted_ctr`),
      ad_relevance: str(r, `${c}.quality_info.creative_quality_score`),
      landing_page_experience: str(r, `${c}.quality_info.post_click_quality_score`),
      first_page_cpc: money(r, `${c}.position_estimates.first_page_cpc_micros`),
      top_of_page_cpc: money(r, `${c}.position_estimates.top_of_page_cpc_micros`),
      search_impression_share: n(r, "metrics.search_impression_share"),
      performance: perf(add(zero(), r)),
    }));
    return { period: period(a), keywords: shown, returned: shown.length, truncated: rows.length > a.limit };
  },
});

// -------------------------------------------------------------------------------------------- get_segment_performance
const SEGMENTS = ["device", "hour_of_day", "day_of_week", "country", "region", "city", "age", "gender"] as const;
type Segment = (typeof SEGMENTS)[number];
/** FROM resource and segment field per breakdown (v26: device/hour/day_of_week on campaign; geo on geographic_view; age and gender views). */
const PLAN: Record<Segment, { from: string; field: string; geo?: boolean }> = {
  device: { from: "campaign", field: "segments.device" },
  hour_of_day: { from: "campaign", field: "segments.hour" },
  day_of_week: { from: "campaign", field: "segments.day_of_week" },
  country: { from: "geographic_view", field: "geographic_view.country_criterion_id", geo: true },
  region: { from: "geographic_view", field: "segments.geo_target_region", geo: true },
  city: { from: "geographic_view", field: "segments.geo_target_city", geo: true },
  age: { from: "age_range_view", field: "ad_group_criterion.age_range.type" },
  gender: { from: "gender_view", field: "ad_group_criterion.gender.type" },
};
export const getSegmentPerformance = googleRead({
  name: "get_segment_performance",
  title: "Performance by segment",
  description:
    "Breaks performance for a period down by one segment: device, hour_of_day, day_of_week, country, region or city (where people were, or showed interest, as Google's geographic report records it; location_type says which), age or gender. Each value gets its metrics, its share of cost and conversions, and how its cost per conversion and conversion rate compare with the total, which is the evidence for bid adjustments and exclusions. Age and gender cover campaigns that report them (Display, Video, Demand Gen and Search with demographics). Fetched live.",
  input: z.object({ account_id: accountId, segment: z.enum(SEGMENTS), ...dateFields, campaign_ids: campaignIds.optional(), limit: z.number().int().min(1).max(500).default(100) }).refine(datesOk, datesMsg),
  output: z.object({
    period: z.string(),
    segment: z.string(),
    rows: z.array(z.object({ value: z.string(), name: z.string().nullable(), location_type: z.string().nullable(), performance: perfSchema, cost_share: z.number().nullable(), conversion_share: z.number().nullable(), cpa_vs_total: z.number().nullable().describe("1.2 = cost per conversion 20% above the total's."), conversion_rate_vs_total: z.number().nullable() })),
    total: perfSchema,
    truncated: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const p = PLAN[a.segment];
    const extra = p.from === "geographic_view" ? ["geographic_view.location_type"] : [];
    const rows = await ads.query(
      new Gaql()
        .select(p.field, ...extra, "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value")
        .from(p.from)
        .where(dateClause(a))
        .where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined),
      { maxRows: 10_000 },
    );
    const groups = new Map<string, { t: Totals; location_type: string | null }>();
    for (const r of rows) {
      const raw = pick(r, p.field);
      if (raw === undefined || raw === null) continue;
      const value = p.geo ? (tailId(raw) ?? String(raw)) : String(raw);
      const lt = extra.length ? str(r, "geographic_view.location_type") : null;
      const key = `${value}|${lt ?? ""}`;
      const g = groups.get(key) ?? { t: zero(), location_type: lt };
      add(g.t, r);
      groups.set(key, g);
    }
    // Location ids are resolved to names with geo_target_constant (it cannot be joined in the report query).
    const names = new Map<string, string>();
    if (p.geo) {
      const ids = [...new Set([...groups.keys()].map((k) => k.split("|")[0]!))].filter((x) => /^\d+$/.test(x)).slice(0, 1000);
      if (ids.length) for (const g of await ads.query(new Gaql().select("geo_target_constant.id", "geo_target_constant.canonical_name").from("geo_target_constant").where(`geo_target_constant.id IN ${lit.list(ids.map(lit.id))}`), { maxRows: 1000 })) names.set(String(pick(g, "geo_target_constant.id")), str(g, "geo_target_constant.canonical_name") ?? "");
    }
    const total = [...groups.values()].reduce((s, g) => ({ impressions: s.impressions + g.t.impressions, clicks: s.clicks + g.t.clicks, cost: s.cost + g.t.cost, conversions: s.conversions + g.t.conversions, value: s.value + g.t.value }), zero());
    const tp = perf(total);
    const out = [...groups.entries()]
      .map(([k, g]) => {
        const value = k.split("|")[0]!;
        const pp = perf(g.t);
        return {
          value,
          name: p.geo ? (names.get(value) ?? null) : null,
          location_type: g.location_type,
          performance: pp,
          cost_share: round(ratio(g.t.cost, total.cost)),
          conversion_share: round(ratio(g.t.conversions, total.conversions)),
          cpa_vs_total: pp.cost_per_conversion !== null && tp.cost_per_conversion ? round(pp.cost_per_conversion / tp.cost_per_conversion, 3) : null,
          conversion_rate_vs_total: pp.conversion_rate !== null && tp.conversion_rate ? round(pp.conversion_rate / tp.conversion_rate, 3) : null,
        };
      })
      .sort((x, y) => (a.segment === "hour_of_day" ? Number(x.value) - Number(y.value) : y.performance.cost - x.performance.cost));
    return { period: period(a), segment: a.segment, rows: out.slice(0, a.limit), total: tp, truncated: out.length > a.limit };
  },
});

// --------------------------------------------------------------------------------- negative keyword list maintenance
export const removeNegativeKeywordsFromList = stateWrite({
  name: "remove_negative_keywords_from_list",
  title: "Remove keywords from a negative keyword list",
  risk: "destructive",
  description: "Removes keywords from a shared negative keyword list after approval from a second person. Every campaign the list is attached to may then show ads for those searches again. Give the keywords (text and match type, matched case-insensitively) to remove. Confirmed by re-reading the list.",
  input: z.object({ account_id: accountId, shared_set_id: idSchema, keywords: z.array(keywordItem).min(1).max(100) }),
  output: z.object({ shared_set_id: z.string(), removed: z.number(), campaigns_affected: z.number() }),
  read: async (a, ads) => {
    const list = (await activeLists(ads)).find((l) => l.id === a.shared_set_id);
    if (!list) throw new ToolError("not_found", `No active negative keyword list ${a.shared_set_id} in this account.`);
    const m = await members(ads, a.shared_set_id);
    return { list: { id: list.id, name: list.name, references: list.referenceCount ?? 0 }, members: m.map((x) => ({ criterion_id: x.id, key: keywordKey(x.text, x.matchType), label: `${x.text} [${x.matchType}]` })).sort((x, y) => x.criterion_id.localeCompare(y.criterion_id)) };
  },
  build: (a, s, ads) => {
    const want = [...new Set(a.keywords.map((k) => keywordKey(k.text, k.match_type)))];
    const missing = want.filter((k) => !s.members.some((m) => m.key === k));
    if (missing.length) throw new ToolError("invalid_argument", `Not in the list: ${missing.join(", ")}`);
    const hit = s.members.filter((m) => want.includes(m.key));
    return {
      summary: `Remove ${hit.length} keyword(s) from negative keyword list "${s.list.name}" (used by ${s.list.references} campaign(s)): ${hit.slice(0, 10).map((m) => m.label).join(", ")}${hit.length > 10 ? ", …" : ""}`,
      changes: hit.map((m) => ({ resource: "negative_keyword_list", id: s.list.id, name: s.list.name, field: "negative_keyword", before: m.label, after: null, unit: "text" as const, effect: "remove" as const })),
      ops: hit.map((m) => ({ sharedCriterionOperation: { remove: `customers/${ads.customerId}/sharedCriteria/${a.shared_set_id}~${m.criterion_id}` } })),
    };
  },
  landed: (a, _b, after) => !a.keywords.some((k) => after.members.some((m) => m.key === keywordKey(k.text, k.match_type))),
  result: (a, _x, _r, before) => ({ shared_set_id: a.shared_set_id, removed: before.members.filter((m) => a.keywords.some((k) => keywordKey(k.text, k.match_type) === m.key)).length, campaigns_affected: before.list.references }),
});

export const detachNegativeKeywordListFromCampaign = stateWrite({
  name: "detach_negative_keyword_list_from_campaign",
  title: "Detach a negative keyword list from a campaign",
  risk: "destructive",
  description: "Stops applying a shared negative keyword list to a campaign, after approval from a second person: the campaign may then show ads for searches the list blocked. The list itself and its other campaigns are unchanged. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, campaign_id: idSchema, shared_set_id: idSchema }),
  output: z.object({ campaign_id: z.string(), shared_set_id: z.string(), detached: z.literal(true) }),
  read: async (a, ads) => {
    const list = (await activeLists(ads)).find((l) => l.id === a.shared_set_id);
    if (!list) throw new ToolError("not_found", `No active negative keyword list ${a.shared_set_id} in this account.`);
    return { list: { id: list.id, name: list.name }, campaigns: (await attachedCampaigns(ads, a.shared_set_id)).map((c) => c.campaign_id).sort() };
  },
  build: (a, s, ads) => {
    if (!s.campaigns.includes(a.campaign_id)) throw new ToolError("invalid_argument", `The list is not attached to campaign ${a.campaign_id}.`);
    return {
      summary: `Detach negative keyword list "${s.list.name}" from campaign ${a.campaign_id}`,
      changes: [{ resource: "campaign", id: a.campaign_id, field: "negative_keyword_list", before: s.list.name, after: null, unit: "text", effect: "remove" }],
      ops: [{ campaignSharedSetOperation: { remove: `customers/${ads.customerId}/campaignSharedSets/${a.campaign_id}~${a.shared_set_id}` } }],
    };
  },
  landed: (a, _b, after) => !after.campaigns.includes(a.campaign_id),
  result: (a) => ({ campaign_id: a.campaign_id, shared_set_id: a.shared_set_id, detached: true as const }),
});

export const keywordSegmentTools = [getKeywordPerformance, getSegmentPerformance, removeNegativeKeywordsFromList, detachNegativeKeywordListFromCampaign];
