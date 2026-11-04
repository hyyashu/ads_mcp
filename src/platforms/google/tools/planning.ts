import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Row } from "../client";
import { Gaql, fromMicros, isRealDate, lit, num, pick } from "../gaql";
import { Money, accountId, campaignIds, dateClause, googleRead, idSchema, ratio, round, str } from "./common";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, "not a real date");
const n = (r: Row, f: string): number | null => (pick(r, f) === undefined || pick(r, f) === null ? null : num(pick(r, f)));
const money = (r: Row, f: string): number | null => (pick(r, f) === undefined ? null : fromMicros(pick(r, f)));

// ------------------------------------------------------------------------------------------------- research_keywords
/**
 * Keyword Planner through KeywordPlanIdeaService (v26 keyword planning guides, checked 2026-11-04): GenerateKeywordIdeas
 * (keyword, URL or site seeds; paged, up to 10,000 per page), GenerateKeywordHistoricalMetrics (exact keywords), and
 * GenerateKeywordForecastMetrics (an inline CampaignToForecast; forecast_period must start in the future and end within a
 * year; default next Sunday to Saturday). Numbers come from Google's planner; nothing here is estimated by this server.
 */
const metricsSchema = z.object({ avg_monthly_searches: z.number().nullable(), competition: z.string().nullable(), competition_index: z.number().nullable(), low_top_of_page_bid: Money.nullable(), high_top_of_page_bid: Money.nullable(), average_cpc: Money.nullable() });
const metricsOf = (m: Row | undefined) => ({
  avg_monthly_searches: m ? n(m, "avgMonthlySearches") : null,
  competition: m ? str(m, "competition") : null,
  competition_index: m ? n(m, "competitionIndex") : null,
  low_top_of_page_bid: m ? money(m, "lowTopOfPageBidMicros") : null,
  high_top_of_page_bid: m ? money(m, "highTopOfPageBidMicros") : null,
  average_cpc: m ? money(m, "averageCpcMicros") : null,
});
const kw = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f]+$/);
export const researchKeywords = googleRead({
  name: "research_keywords",
  title: "Keyword research (Keyword Planner)",
  description:
    "Google Keyword Planner data, three modes. ideas: keyword ideas from seed keywords and/or a URL, with average monthly searches, competition and top-of-page bid range. historical: the same metrics for exact keywords. forecast: Google's forecast of clicks, cost, conversions and average CPC for keywords at a max CPC and daily budget over a future period. Locations and language narrow the data. Numbers are Google's planner data, not estimates by this server.",
  input: z
    .object({
      account_id: accountId,
      mode: z.enum(["ideas", "historical", "forecast"]),
      keywords: z.array(kw).max(200).default([]),
      url: z.string().url().refine((u) => /^https?:\/\//.test(u), "http(s) URL").optional(),
      location_ids: z.array(idSchema).max(10).default([]),
      language_id: idSchema.default("1000").describe("Language constant id; 1000 = English."),
      network: z.enum(["GOOGLE_SEARCH", "GOOGLE_SEARCH_AND_PARTNERS"]).default("GOOGLE_SEARCH"),
      limit: z.number().int().min(1).max(1000).default(100),
      match_type: z.enum(["BROAD", "PHRASE", "EXACT"]).default("BROAD").describe("forecast only"),
      max_cpc: z.number().positive().max(10_000).optional().describe("forecast only"),
      daily_budget: z.number().positive().max(10_000_000).optional().describe("forecast only"),
      forecast_start: day.optional(),
      forecast_end: day.optional(),
    })
    .refine((v) => (v.mode === "ideas" ? v.keywords.length > 0 || !!v.url : v.keywords.length > 0), "give keywords (and/or a url for ideas)")
    .refine((v) => v.mode !== "forecast" || v.max_cpc !== undefined, "forecast needs max_cpc"),
  output: z.object({
    mode: z.string(),
    keywords: z.array(z.object({ text: z.string(), metrics: metricsSchema })),
    forecast: z.object({ clicks: z.number().nullable(), cost: Money.nullable(), conversions: z.number().nullable(), average_cpc: Money.nullable(), average_cpa: Money.nullable(), period: z.string() }).nullable(),
    truncated: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const geo = a.location_ids.map((g) => `geoTargetConstants/${g}`);
    const language = `languageConstants/${a.language_id}`;
    if (a.mode === "ideas") {
      const seed = a.keywords.length && a.url ? { keywordAndUrlSeed: { keywords: a.keywords, url: a.url } } : a.url ? { urlSeed: { url: a.url } } : { keywordSeed: { keywords: a.keywords } };
      const res = await ads.rpc<{ results?: Row[]; nextPageToken?: string }>("customers/{customer}:generateKeywordIdeas", { language, geoTargetConstants: geo, keywordPlanNetwork: a.network, includeAdultKeywords: false, pageSize: a.limit, ...seed });
      const rows = (res.results ?? []).slice(0, a.limit);
      return { mode: a.mode, keywords: rows.map((r) => ({ text: String(r.text ?? ""), metrics: metricsOf(r.keywordIdeaMetrics as Row | undefined) })), forecast: null, truncated: !!res.nextPageToken || (res.results ?? []).length > a.limit };
    }
    if (a.mode === "historical") {
      const res = await ads.rpc<{ results?: Row[] }>("customers/{customer}:generateKeywordHistoricalMetrics", { keywords: a.keywords, language, geoTargetConstants: geo, keywordPlanNetwork: a.network, includeAdultKeywords: false });
      return { mode: a.mode, keywords: (res.results ?? []).map((r) => ({ text: String(r.text ?? ""), metrics: metricsOf(r.keywordMetrics as Row | undefined) })), forecast: null, truncated: false };
    }
    if ((a.forecast_start === undefined) !== (a.forecast_end === undefined)) throw new ToolError("invalid_argument", "give forecast_start and forecast_end together");
    const strategy = a.daily_budget ? { manualCpcBiddingStrategy: { maxCpcBidMicros: String(Math.round(a.max_cpc! * 1e6)), dailyBudgetMicros: String(Math.round(a.daily_budget * 1e6)) } } : { manualCpcBiddingStrategy: { maxCpcBidMicros: String(Math.round(a.max_cpc! * 1e6)) } };
    const res = await ads.rpc<{ campaignForecastMetrics?: Row }>("customers/{customer}:generateKeywordForecastMetrics", {
      campaign: { languageConstants: [language], geoTargetConstants: geo, biddingStrategy: strategy, adGroups: [{ keywords: a.keywords.map((t) => ({ text: t, matchType: a.match_type })) }] },
      ...(a.forecast_start ? { forecastPeriod: { startDate: a.forecast_start, endDate: a.forecast_end } } : {}),
    });
    const m = res.campaignForecastMetrics ?? {};
    return { mode: a.mode, keywords: a.keywords.map((t) => ({ text: t, metrics: metricsOf(undefined) })), forecast: { clicks: n(m, "clicks"), cost: money(m, "costMicros"), conversions: n(m, "conversions"), average_cpc: money(m, "averageCpcMicros"), average_cpa: money(m, "averageCpaMicros"), period: a.forecast_start ? `${a.forecast_start}..${a.forecast_end}` : "next Sunday to Saturday (Google default)" }, truncated: false };
  },
});

// ------------------------------------------------------------------------------------------------- get_reach_frequency
export const getReachFrequency = googleRead({
  name: "get_reach_frequency",
  title: "Reach and frequency forecast (Reach Planner)",
  description:
    "Google Reach Planner forecast for YouTube video products: for a plannable location, duration and budget split across plannable products (product codes as Google's Reach Planner lists them, for example TRUEVIEW_IN_STREAM or BUMPER), returns Google's reach curve (cost, reach, impressions, on-target reach and views at each budget point). Optional age, gender and device targeting. Reach Planner access can depend on the Google Cloud project [unverified]; Google's permission error is passed through.",
  input: z.object({
    account_id: accountId,
    plannable_location_id: idSchema.describe("A Reach Planner location id, e.g. 2840 for the United States."),
    duration_days: z.number().int().min(1).max(90),
    products: z.array(z.object({ code: z.string().regex(/^[A-Z_]{3,60}$/), budget: z.number().positive().max(100_000_000) })).min(1).max(10),
    currency_code: z.string().regex(/^[A-Z]{3}$/).optional().describe("Defaults to the account's currency."),
    age_range: z.enum(["AGE_RANGE_18_24", "AGE_RANGE_18_34", "AGE_RANGE_18_44", "AGE_RANGE_18_49", "AGE_RANGE_18_54", "AGE_RANGE_18_64", "AGE_RANGE_18_65_UP", "AGE_RANGE_25_34", "AGE_RANGE_25_44", "AGE_RANGE_25_54", "AGE_RANGE_35_44", "AGE_RANGE_35_54", "AGE_RANGE_45_54", "AGE_RANGE_55_64", "AGE_RANGE_65_UP"]).optional(),
    genders: z.array(z.enum(["MALE", "FEMALE"])).max(2).default([]),
    devices: z.array(z.enum(["MOBILE", "DESKTOP", "TABLET", "CONNECTED_TV"])).max(4).default([]),
  }),
  output: z.object({ currency_code: z.string().nullable(), points: z.array(z.object({ cost: Money.nullable(), total_reach: z.number().nullable(), total_impressions: z.number().nullable(), on_target_reach: z.number().nullable(), on_target_impressions: z.number().nullable(), views: z.number().nullable() })) }),
  handler: async (a, ctx) => {
    const currency = a.currency_code ?? ctx.account?.currencyCode ?? undefined;
    if (!currency) throw new ToolError("invalid_argument", "The account currency is unknown; give currency_code.");
    const res = await ctx.services.ads.rpc<{ reachCurve?: { reachForecasts?: Row[] } }>("customers/{customer}:generateReachForecast", {
      currencyCode: currency,
      campaignDuration: { durationInDays: a.duration_days },
      plannedProducts: a.products.map((p) => ({ plannableProductCode: p.code, budgetMicros: String(Math.round(p.budget * 1e6)) })),
      targeting: { plannableLocationIds: [a.plannable_location_id], ...(a.age_range ? { ageRange: a.age_range } : {}), ...(a.genders.length ? { genders: a.genders.map((g) => ({ type: g })) } : {}), ...(a.devices.length ? { devices: a.devices.map((d) => ({ type: d })) } : {}) },
    });
    return {
      currency_code: currency,
      points: (res.reachCurve?.reachForecasts ?? []).map((f) => ({ cost: money(f, "costMicros"), total_reach: n(f, "forecast.totalReach"), total_impressions: n(f, "forecast.totalImpressions"), on_target_reach: n(f, "forecast.onTargetReach"), on_target_impressions: n(f, "forecast.onTargetImpressions"), views: n(f, "forecast.trueviewViews") })),
    };
  },
});

// ------------------------------------------------------------------------------------------ explain_performance_anomaly
const period = z.object({ start_date: day, end_date: day }).refine((p) => p.start_date <= p.end_date, "start_date must not be after end_date");
const sums = (rows: Row[]) => {
  const t = { impressions: 0, clicks: 0, cost: 0, conversions: 0, value: 0 };
  for (const r of rows) (t.impressions += num(pick(r, "metrics.impressions"))), (t.clicks += num(pick(r, "metrics.clicks"))), (t.cost += fromMicros(pick(r, "metrics.cost_micros"))), (t.conversions += num(pick(r, "metrics.conversions"))), (t.value += num(pick(r, "metrics.conversions_value")));
  return t;
};
type Sums = ReturnType<typeof sums>;
const kpis = (t: Sums) => ({ impressions: t.impressions, clicks: t.clicks, cost: round(t.cost, 2)!, conversions: round(t.conversions, 2)!, conversion_value: round(t.value, 2)!, ctr: round(ratio(t.clicks, t.impressions)), cpc: round(ratio(t.cost, t.clicks), 2), conversion_rate: round(ratio(t.conversions, t.clicks)), cpa: round(ratio(t.cost, t.conversions), 2), roas: round(ratio(t.value, t.cost)) });
const pct = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : round((a - b) / b, 4));
const kpiSchema = z.object({ impressions: z.number(), clicks: z.number(), cost: Money, conversions: z.number(), conversion_value: z.number(), ctr: z.number().nullable(), cpc: Money.nullable(), conversion_rate: z.number().nullable(), cpa: Money.nullable(), roas: z.number().nullable() });
export const explainPerformanceAnomaly = googleRead({
  name: "explain_performance_anomaly",
  title: "Explain a performance change",
  description:
    "Compares two periods for the account (or given campaigns): headline metrics and their relative change; which campaigns contributed most to the change in cost and conversions; the funnel step that moved (impressions, CTR, CPC, conversion rate); and the account changes recorded by Google in the current period (change history, at most the last 30 days). It reports facts from live data; it does not guess causes.",
  input: z.object({ account_id: accountId, current: period, previous: period, campaign_ids: campaignIds.optional(), top: z.number().int().min(1).max(50).default(10) }),
  output: z.object({
    current: kpiSchema,
    previous: kpiSchema,
    change: z.record(z.string(), z.number().nullable()).describe("Relative change per metric (0.1 = +10%); null when the previous value is 0 or undefined."),
    campaigns: z.array(z.object({ campaign_id: z.string(), name: z.string().nullable(), cost_delta: Money, conversions_delta: z.number(), current: kpiSchema, previous: kpiSchema })),
    changes_in_period: z.array(z.object({ at: z.string().nullable(), resource_type: z.string().nullable(), operation: z.string().nullable(), campaign_id: z.string().nullable(), changed_fields: z.string().nullable(), client: z.string().nullable() })),
    change_history_note: z.string(),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const q = (p: { start_date: string; end_date: string }) => new Gaql().select("campaign.id", "campaign.name", "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value").from("campaign").where(dateClause({ date_range: "LAST_30_DAYS", ...p })).where(a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined);
    const [cur, prev] = await Promise.all([ads.query(q(a.current), { maxRows: 10_000 }), ads.query(q(a.previous), { maxRows: 10_000 })]);
    const c = kpis(sums(cur));
    const p = kpis(sums(prev));
    const change = Object.fromEntries(Object.keys(c).map((k) => [k, pct(c[k as keyof typeof c] as number | null, p[k as keyof typeof p] as number | null)]));
    const ids = new Set([...cur, ...prev].map((r) => String(pick(r, "campaign.id"))));
    const by = (rows: Row[], id: string) => rows.filter((r) => String(pick(r, "campaign.id")) === id);
    const campaigns = [...ids]
      .map((id) => {
        const cs = sums(by(cur, id));
        const ps = sums(by(prev, id));
        return { campaign_id: id, name: str([...by(cur, id), ...by(prev, id)][0]!, "campaign.name"), cost_delta: round(cs.cost - ps.cost, 2)!, conversions_delta: round(cs.conversions - ps.conversions, 2)!, current: kpis(cs), previous: kpis(ps) };
      })
      .sort((x, y) => Math.abs(y.cost_delta) + Math.abs(y.conversions_delta) - (Math.abs(x.cost_delta) + Math.abs(x.conversions_delta)))
      .slice(0, a.top);
    // change_event covers at most the last 30 days and needs a date filter and a LIMIT (Google Ads API reference).
    const since = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const from = a.current.start_date > since ? a.current.start_date : since;
    let events: Row[] = [];
    let note = `Change history from ${from} to ${a.current.end_date}.`;
    if (from <= a.current.end_date) {
      events = await ads.query(new Gaql().select("change_event.change_date_time", "change_event.change_resource_type", "change_event.resource_change_operation", "change_event.campaign", "change_event.changed_fields", "change_event.client_type").from("change_event").where(`change_event.change_date_time >= ${lit.str(`${from} 00:00:00`)}`).where(`change_event.change_date_time <= ${lit.str(`${a.current.end_date} 23:59:59`)}`).orderBy("change_event.change_date_time", "DESC").limit(200), { maxRows: 200 });
    } else note = "The current period is older than 30 days, so Google keeps no change history for it.";
    return {
      current: c,
      previous: p,
      change,
      campaigns,
      changes_in_period: events.map((e) => ({ at: str(e, "change_event.change_date_time"), resource_type: str(e, "change_event.change_resource_type"), operation: str(e, "change_event.resource_change_operation"), campaign_id: str(e, "change_event.campaign")?.split("/").pop() ?? null, changed_fields: str(e, "change_event.changed_fields"), client: str(e, "change_event.client_type") })),
      change_history_note: note,
    };
  },
});

// ------------------------------------------------------------------------------------------- optimize_budget_allocation
export const optimizeBudgetAllocation = googleRead({
  name: "optimize_budget_allocation",
  title: "Budget allocation analysis",
  description:
    "Analyses how daily budgets are spread across enabled campaigns over a period: each campaign's spend, conversions, CPA, ROAS and the search impression share it lost to budget (Search and Shopping only), plus Google's own budget recommendations for the account. It then lists, with the numbers behind each, which campaigns are budget-limited with better than average efficiency (candidates to receive budget) and which spend without being budget-limited at worse efficiency (candidates to give budget). Read-only: it changes nothing; apply changes with update_campaign.",
  input: z.object({ account_id: accountId, date_range: z.enum(["LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS"]).default("LAST_30_DAYS"), optimize_for: z.enum(["conversions", "conversion_value"]).default("conversions") }),
  output: z.object({
    campaigns: z.array(z.object({ campaign_id: z.string(), name: z.string().nullable(), channel: z.string().nullable(), daily_budget: Money.nullable(), budget_shared: z.boolean(), cost: Money, conversions: z.number(), conversion_value: z.number(), cpa: Money.nullable(), roas: z.number().nullable(), lost_is_budget: z.number().nullable() })),
    account: z.object({ cpa: Money.nullable(), roas: z.number().nullable() }),
    candidates_to_increase: z.array(z.object({ campaign_id: z.string(), reason: z.string() })),
    candidates_to_decrease: z.array(z.object({ campaign_id: z.string(), reason: z.string() })),
    google_recommendations: z.array(z.object({ campaign_id: z.string().nullable(), current_budget: Money.nullable(), recommended_budget: Money.nullable() })),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const [rows, recs] = await Promise.all([
      ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.advertising_channel_type", "campaign_budget.amount_micros", "campaign_budget.explicitly_shared", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value", "metrics.search_budget_lost_impression_share").from("campaign").where("campaign.status = 'ENABLED'").where(`segments.date DURING ${lit.enumOf(a.date_range, ["LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS"] as const)}`), { maxRows: 5000 }),
      ads.query(new Gaql().select("recommendation.campaign", "recommendation.type", "recommendation.campaign_budget_recommendation.current_budget_amount_micros", "recommendation.campaign_budget_recommendation.recommended_budget_amount_micros").from("recommendation").where("recommendation.type = 'CAMPAIGN_BUDGET'"), { maxRows: 500 }),
    ]);
    const campaigns = rows.map((r) => {
      const cost = fromMicros(pick(r, "metrics.cost_micros")), conv = num(pick(r, "metrics.conversions")), value = num(pick(r, "metrics.conversions_value"));
      return { campaign_id: String(pick(r, "campaign.id")), name: str(r, "campaign.name"), channel: str(r, "campaign.advertising_channel_type"), daily_budget: money(r, "campaign_budget.amount_micros"), budget_shared: pick(r, "campaign_budget.explicitly_shared") === true, cost: round(cost, 2)!, conversions: round(conv, 2)!, conversion_value: round(value, 2)!, cpa: round(ratio(cost, conv), 2), roas: round(ratio(value, cost)), lost_is_budget: n(r, "metrics.search_budget_lost_impression_share") };
    });
    const tot = campaigns.reduce((s, c) => ({ cost: s.cost + c.cost, conv: s.conv + c.conversions, value: s.value + c.conversion_value }), { cost: 0, conv: 0, value: 0 });
    const account = { cpa: round(ratio(tot.cost, tot.conv), 2), roas: round(ratio(tot.value, tot.cost)) };
    const better = (c: (typeof campaigns)[number]) => (a.optimize_for === "conversions" ? c.cpa !== null && account.cpa !== null && c.cpa < account.cpa : c.roas !== null && account.roas !== null && c.roas > account.roas);
    const worse = (c: (typeof campaigns)[number]) => (a.optimize_for === "conversions" ? (c.cpa === null ? c.cost > 0 : account.cpa !== null && c.cpa > account.cpa) : c.roas === null ? c.cost > 0 : account.roas !== null && c.roas < account.roas);
    const eff = (c: (typeof campaigns)[number]) => (a.optimize_for === "conversions" ? `CPA ${c.cpa ?? "n/a (no conversions)"} vs account ${account.cpa ?? "n/a"}` : `ROAS ${c.roas ?? "n/a"} vs account ${account.roas ?? "n/a"}`);
    return {
      campaigns,
      account,
      candidates_to_increase: campaigns.filter((c) => !c.budget_shared && (c.lost_is_budget ?? 0) >= 0.1 && better(c)).map((c) => ({ campaign_id: c.campaign_id, reason: `lost ${round((c.lost_is_budget ?? 0) * 100, 1)}% of search impression share to budget; ${eff(c)}` })),
      candidates_to_decrease: campaigns.filter((c) => !c.budget_shared && c.cost > 0 && (c.lost_is_budget ?? 0) < 0.01 && worse(c)).map((c) => ({ campaign_id: c.campaign_id, reason: `not limited by budget; ${eff(c)}` })),
      google_recommendations: recs.map((r) => ({ campaign_id: str(r, "recommendation.campaign")?.split("/").pop() ?? null, current_budget: money(r, "recommendation.campaign_budget_recommendation.current_budget_amount_micros"), recommended_budget: money(r, "recommendation.campaign_budget_recommendation.recommended_budget_amount_micros") })),
    };
  },
});

// ------------------------------------------------------------------------------------------------ get_benchmark_context
export const getBenchmarkContext = googleRead({
  name: "get_benchmark_context",
  title: "Benchmark context",
  description:
    "Context for judging performance from this account's own history and Google's competitive metrics, never from invented industry averages: monthly metrics for up to the last 13 months by channel type, and for Search and Shopping campaigns the impression share, top and absolute top impression share and impression share lost to rank and to budget for the last 30 days. Industry benchmarks are not available from the Google Ads API and are not provided.",
  input: z.object({ account_id: accountId, months: z.number().int().min(1).max(13).default(13), campaign_ids: campaignIds.optional() }),
  output: z.object({
    monthly: z.array(z.object({ month: z.string(), channel: z.string().nullable(), impressions: z.number(), clicks: z.number(), cost: Money, conversions: z.number(), ctr: z.number().nullable(), cpc: Money.nullable(), cpa: Money.nullable(), roas: z.number().nullable() })),
    competitive: z.array(z.object({ campaign_id: z.string(), name: z.string().nullable(), impression_share: z.number().nullable(), top_impression_share: z.number().nullable(), absolute_top_impression_share: z.number().nullable(), lost_to_rank: z.number().nullable(), lost_to_budget: z.number().nullable() })),
    note: z.string(),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const end = new Date();
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (a.months - 1), 1)).toISOString().slice(0, 10);
    const camp = a.campaign_ids?.length ? `campaign.id IN ${lit.list(a.campaign_ids.map(lit.id))}` : undefined;
    const [monthly, comp] = await Promise.all([
      ads.query(new Gaql().select("segments.month", "campaign.advertising_channel_type", "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value").from("campaign").where(`segments.date BETWEEN ${lit.date(start)} AND ${lit.date(end.toISOString().slice(0, 10))}`).where(camp), { maxRows: 10_000 }),
      ads.query(new Gaql().select("campaign.id", "campaign.name", "metrics.search_impression_share", "metrics.search_top_impression_share", "metrics.search_absolute_top_impression_share", "metrics.search_rank_lost_impression_share", "metrics.search_budget_lost_impression_share").from("campaign").where("campaign.advertising_channel_type IN ('SEARCH', 'SHOPPING')").where("segments.date DURING LAST_30_DAYS").where(camp), { maxRows: 5000 }),
    ]);
    const groups = new Map<string, Row[]>();
    for (const r of monthly) {
      const k = `${str(r, "segments.month")}|${str(r, "campaign.advertising_channel_type")}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return {
      monthly: [...groups.entries()].map(([k, rs]) => {
        const t = sums(rs);
        const [month, channel] = k.split("|");
        return { month: month!, channel: channel === "null" ? null : channel!, impressions: t.impressions, clicks: t.clicks, cost: round(t.cost, 2)!, conversions: round(t.conversions, 2)!, ctr: round(ratio(t.clicks, t.impressions)), cpc: round(ratio(t.cost, t.clicks), 2), cpa: round(ratio(t.cost, t.conversions), 2), roas: round(ratio(t.value, t.cost)) };
      }).sort((x, y) => x.month.localeCompare(y.month) || String(x.channel).localeCompare(String(y.channel))),
      competitive: comp.map((r) => ({ campaign_id: String(pick(r, "campaign.id")), name: str(r, "campaign.name"), impression_share: n(r, "metrics.search_impression_share"), top_impression_share: n(r, "metrics.search_top_impression_share"), absolute_top_impression_share: n(r, "metrics.search_absolute_top_impression_share"), lost_to_rank: n(r, "metrics.search_rank_lost_impression_share"), lost_to_budget: n(r, "metrics.search_budget_lost_impression_share") })),
      note: "History and impression share are from this account via the Google Ads API. Shares are fractions (0.42 = 42%); Google reports very small shares as a floor value. No external or industry benchmarks are included.",
    };
  },
});

export const planningTools = [researchKeywords, getReachFrequency, explainPerformanceAnomaly, optimizeBudgetAllocation, getBenchmarkContext];
