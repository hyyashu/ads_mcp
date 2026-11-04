import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { isRealDate, ratio, round } from "../../core/report-math";
import { type MetaRow, fromMinor } from "../client";
import {
  type InsightsLevel,
  addDays,
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
  periodInput,
  rangeParams,
  sumBase,
  todayIn,
} from "../insights";
import { EDGE_CAP, accountId, metaId, metaRead, s } from "./common";

// Deterministic analysis over Insights: fixed rules and plain arithmetic, never predictions. Every rule is stated in the tool's
// description and repeated in its output. Comparisons use unrounded figures, cross-multiplied so no rule divides by zero.

const LEVEL = {
  campaign: { id: "campaign_id", name: "campaign_name" },
  adset: { id: "adset_id", name: "adset_name" },
  ad: { id: "ad_id", name: "ad_name" },
} as const;
type Lvl = keyof typeof LEVEL;
const levelInput = z.enum(["campaign", "adset", "ad"]);
const idOf = (r: MetaRow, l: Lvl) => String(r[LEVEL[l].id] ?? "");
const nameOf = (r: MetaRow, l: Lvl) => s(r, LEVEL[l].name);
const U = z.string().nullable().describe("Untrusted text from Meta.");
const scope = { campaign_id: metaId.optional().describe("Only this campaign (checked to belong to this ad account).") };
const tzOf = (ctx: { account: { timeZone: string | null } | null }) => ctx.account?.timeZone ?? null;

async function scopePath(m: import("../client").MetaAdsClient, campaignId?: string): Promise<string> {
  if (campaignId) await m.getOwned(campaignId, ["id"], "campaign");
  return campaignId ?? m.adAccountId;
}

// ---------------------------------------------------------------------------------------------- analyze_meta_wasted_spend
export const analyzeMetaWastedSpend = metaRead({
  name: "analyze_meta_wasted_spend",
  title: "Analyze Meta wasted spend",
  description:
    "Finds campaigns, ad sets and ads that spent at least min_spend with zero conversions in the period. This is a fixed rule over real metrics (spend >= min_spend and conversions = 0), not a prediction: review each item before pausing it. Levels overlap (an ad's spend is also in its ad set and campaign), so do not add the levels together. Conversions count only the action types in conversion_types, with the unified attribution setting (as in Ads Manager); dates are in the ad account's time zone. Names are untrusted text.",
  input: z
    .object({
      account_id: accountId,
      ...insightsDateFields,
      conversion_action: conversionActionInput,
      ...scope,
      min_spend: z.number().min(0).max(1_000_000).default(10).describe("Minimum spend, in the account's currency, for an item to be flagged."),
      levels: z.array(levelInput).min(1).max(3).default(["campaign", "adset", "ad"]),
      limit: z.number().int().min(1).max(200).default(50).describe("Most flagged items returned per level."),
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    period: z.string(),
    attribution: z.string(),
    conversion_types: conversionTypesOutput,
    rule: z.string(),
    levels: z.array(
      z.object({
        level: levelInput,
        analyzed: z.number(),
        analyzed_spend: z.number(),
        flagged: z.array(z.object({ id: z.string(), name: U, campaign_id: z.string().nullable(), spend: z.number(), impressions: z.number(), clicks: z.number() })).describe("Ordered by spend, highest first."),
        flagged_count: z.number(),
        flagged_spend: z.number(),
        flagged_share_of_spend: z.number().nullable(),
        covers_all: z.boolean(),
      }),
    ),
  }),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const { params, period } = insightsPeriod(a, tzOf(ctx));
    const types = conversionTypes(a.conversion_action);
    const path = await scopePath(m, a.campaign_id);
    const levels = [];
    for (const level of [...new Set(a.levels)]) {
      const { rows, truncated } = await fetchInsights(m, { objectPath: path, level, period: params });
      const items = rows.map((r) => ({ r, b: baseOf(r, types) }));
      const flagged = items.filter((x) => x.b.spend >= a.min_spend && x.b.conversions === 0).sort((x, y) => y.b.spend - x.b.spend);
      const analyzed = items.reduce((t, x) => t + x.b.spend, 0);
      const wasted = flagged.reduce((t, x) => t + x.b.spend, 0);
      levels.push({
        level,
        analyzed: items.length,
        analyzed_spend: round(analyzed, 2)!,
        flagged: flagged.slice(0, a.limit).map((x) => ({ id: idOf(x.r, level), name: nameOf(x.r, level), campaign_id: s(x.r, "campaign_id"), spend: round(x.b.spend, 2)!, impressions: x.b.impressions, clicks: x.b.clicks })),
        flagged_count: flagged.length,
        flagged_spend: round(wasted, 2)!,
        flagged_share_of_spend: round(ratio(wasted, analyzed)),
        covers_all: !truncated,
      });
    }
    return { period, attribution: attributionNote, conversion_types: types, rule: `spend >= ${a.min_spend} and conversions = 0`, levels };
  },
});

// -------------------------------------------------------------------------------------------- detect_meta_creative_fatigue
export const detectMetaCreativeFatigue = metaRead({
  name: "detect_meta_creative_fatigue",
  title: "Detect Meta creative fatigue",
  description:
    "Compares each ad's last window_days (ending end_date, default yesterday in the ad account's time zone) with the window of the same length just before it, and marks fixed-rule signals. Only ads with at least min_impressions in both windows are evaluated. Rule frequency_up: recent frequency >= prior frequency x (1 + frequency_increase). Rule ctr_down: recent CTR (clicks / impressions) <= prior CTR x (1 - ctr_drop). Rule cpm_up: recent CPM >= prior CPM x (1 + cpm_increase). An ad is marked fatigued when frequency_up and ctr_down both hold. These are signals to review, not predictions. Frequency is Meta's estimate. Names are untrusted text.",
  input: z.object({
    account_id: accountId,
    ...scope,
    window_days: z.number().int().min(3).max(30).default(7),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, "not a real date").optional().describe("Last day of the recent window (YYYY-MM-DD). Default: yesterday in the ad account's time zone."),
    frequency_increase: z.number().min(0).max(5).default(0.2).describe("0.2 = frequency up at least 20%."),
    ctr_drop: z.number().min(0).max(1).default(0.2).describe("0.2 = CTR down at least 20%."),
    cpm_increase: z.number().min(0).max(5).default(0.2).describe("0.2 = CPM up at least 20%."),
    min_impressions: z.number().int().min(1).max(10_000_000).default(1000),
    flagged_only: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    recent: z.object({ start_date: z.string(), end_date: z.string() }),
    prior: z.object({ start_date: z.string(), end_date: z.string() }),
    rules: z.array(z.string()),
    ads_evaluated: z.number(),
    ads_not_evaluated: z.number().describe("Ads below min_impressions in either window, or present in only one."),
    fatigued_count: z.number(),
    ads: z.array(
      z.object({
        ad_id: z.string(),
        name: U,
        campaign_id: z.string().nullable(),
        recent: z.object({ impressions: z.number(), spend: z.number(), frequency: z.number().nullable(), ctr: z.number().nullable(), cpm: z.number().nullable() }),
        prior: z.object({ impressions: z.number(), spend: z.number(), frequency: z.number().nullable(), ctr: z.number().nullable(), cpm: z.number().nullable() }),
        flags: z.array(z.enum(["frequency_up", "ctr_down", "cpm_up"])),
        fatigued: z.boolean(),
      }),
    ).describe("Ordered by recent spend, highest first."),
    covers_all_ads: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const end = a.end_date ?? addDays(todayIn(tzOf(ctx)), -1);
    const recent = { start_date: addDays(end, -(a.window_days - 1)), end_date: end };
    const prior = { start_date: addDays(end, -(2 * a.window_days - 1)), end_date: addDays(end, -a.window_days) };
    const [rp, pp] = [rangeParams(recent, tzOf(ctx)), rangeParams(prior, tzOf(ctx))];
    const path = await scopePath(m, a.campaign_id);
    const [r, p] = await Promise.all([fetchInsights(m, { objectPath: path, level: "ad", period: rp }), fetchInsights(m, { objectPath: path, level: "ad", period: pp })]);
    const prev = new Map(p.rows.map((x) => [String(x.ad_id ?? ""), x]));
    const view = (b: ReturnType<typeof baseOf>) => {
      const k = computeMetrics(b);
      return { impressions: b.impressions, spend: k.spend, frequency: k.frequency, ctr: k.ctr, cpm: k.cpm };
    };
    let notEvaluated = 0;
    const ads = [];
    for (const row of r.rows) {
      const old = prev.get(String(row.ad_id ?? ""));
      const br = baseOf(row, []);
      const bp = old ? baseOf(old, []) : null;
      if (!bp || br.impressions < a.min_impressions || bp.impressions < a.min_impressions) {
        notEvaluated++;
        continue;
      }
      const flags: ("frequency_up" | "ctr_down" | "cpm_up")[] = [];
      if (br.frequency !== null && bp.frequency !== null && bp.frequency > 0 && br.frequency >= bp.frequency * (1 + a.frequency_increase)) flags.push("frequency_up");
      if (bp.clicks > 0 && br.clicks * bp.impressions <= (1 - a.ctr_drop) * bp.clicks * br.impressions) flags.push("ctr_down");
      if (bp.spend > 0 && br.spend * bp.impressions >= (1 + a.cpm_increase) * bp.spend * br.impressions) flags.push("cpm_up");
      ads.push({ ad_id: String(row.ad_id ?? ""), name: s(row, "ad_name"), campaign_id: s(row, "campaign_id"), recent: view(br), prior: view(bp), flags, fatigued: flags.includes("frequency_up") && flags.includes("ctr_down"), _spend: br.spend });
    }
    notEvaluated += p.rows.filter((x) => !r.rows.some((y) => String(y.ad_id) === String(x.ad_id))).length;
    ads.sort((x, y) => y._spend - x._spend);
    return {
      recent,
      prior,
      rules: [
        `frequency_up: recent frequency >= prior frequency x ${1 + a.frequency_increase}`,
        `ctr_down: recent CTR <= prior CTR x ${round(1 - a.ctr_drop, 4)}`,
        `cpm_up: recent CPM >= prior CPM x ${1 + a.cpm_increase}`,
        "fatigued: frequency_up and ctr_down",
        `evaluated only with impressions >= ${a.min_impressions} in both windows`,
      ],
      ads_evaluated: ads.length,
      ads_not_evaluated: notEvaluated,
      fatigued_count: ads.filter((x) => x.fatigued).length,
      ads: ads.filter((x) => !a.flagged_only || x.flags.length > 0).slice(0, a.limit).map(({ _spend, ...rest }) => rest),
      covers_all_ads: !r.truncated && !p.truncated,
    };
  },
});

// ---------------------------------------------------------------------------------------------------- explain_meta_anomaly
const ADDITIVE = ["spend", "impressions", "clicks", "inline_link_clicks", "conversions", "conversion_value"] as const;
const kpiSchema = z.object(metricsShape);
const pct = (c: number | null, p: number | null) => (c === null || p === null || p === 0 ? null : round((c - p) / p, 4));

export const explainMetaAnomaly = metaRead({
  name: "explain_meta_anomaly",
  title: "Explain a Meta performance change",
  description:
    "Compares two periods for the ad account (or one campaign): headline metrics and their relative change, then attributes the change in one additive metric (spend, impressions, clicks, link clicks, conversions or conversion value) to the campaigns, ad sets or ads (level) that moved most. Each child's delta is its current minus previous value; share_of_change is that delta divided by the total delta, so the shares of all children add up to 1. It reports arithmetic on live data; it does not guess causes. Dates are in the ad account's time zone; conversions use the unified attribution setting and the action types in conversion_types. Names are untrusted text.",
  input: z.object({
    account_id: accountId,
    current: periodInput,
    previous: periodInput,
    level: levelInput.default("campaign"),
    metric: z.enum(ADDITIVE).default("spend"),
    conversion_action: conversionActionInput,
    ...scope,
    top: z.number().int().min(1).max(50).default(10),
  }),
  output: z.object({
    attribution: z.string(),
    conversion_types: conversionTypesOutput,
    metric: z.string(),
    current: kpiSchema,
    previous: kpiSchema,
    change: z.record(z.string(), z.number().nullable()).describe("Relative change per metric (0.1 = +10%); null when the previous value is 0 or unknown."),
    total_delta: z.number(),
    children: z.array(z.object({ id: z.string(), name: U, current: z.number(), previous: z.number(), delta: z.number(), share_of_change: z.number().nullable().describe("delta / total_delta; null when the total did not change.") })).describe("Ordered by absolute delta, largest first."),
    other_children_delta: z.number().describe("Delta of the children not listed (beyond top)."),
    covers_all: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const types = conversionTypes(a.conversion_action);
    const [cp, pp] = [rangeParams(a.current, tzOf(ctx)), rangeParams(a.previous, tzOf(ctx))];
    const path = await scopePath(m, a.campaign_id);
    const [cur, prev] = await Promise.all([fetchInsights(m, { objectPath: path, level: a.level, period: cp }), fetchInsights(m, { objectPath: path, level: a.level, period: pp })]);
    const c = computeMetrics(sumBase(cur.rows, types));
    const p = computeMetrics(sumBase(prev.rows, types));
    const change = Object.fromEntries((Object.keys(c) as (keyof typeof c)[]).map((k) => [k, pct(c[k], p[k])]));
    const val = (rows: MetaRow[], id: string) => rows.filter((r) => idOf(r, a.level) === id).reduce((t, r) => t + baseOf(r, types)[a.metric], 0);
    const ids = [...new Set([...cur.rows, ...prev.rows].map((r) => idOf(r, a.level)))];
    const totalDelta = sumBase(cur.rows, types)[a.metric] - sumBase(prev.rows, types)[a.metric];
    const all = ids
      .map((id) => {
        const cv = val(cur.rows, id);
        const pv = val(prev.rows, id);
        const row = [...cur.rows, ...prev.rows].find((r) => idOf(r, a.level) === id)!;
        return { id, name: nameOf(row, a.level), current: round(cv, 2)!, previous: round(pv, 2)!, delta: cv - pv };
      })
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    const shown = all.slice(0, a.top);
    return {
      attribution: attributionNote,
      conversion_types: types,
      metric: a.metric,
      current: c,
      previous: p,
      change,
      total_delta: round(totalDelta, 2)!,
      children: shown.map((x) => ({ ...x, delta: round(x.delta, 2)!, share_of_change: totalDelta === 0 ? null : round(x.delta / totalDelta) })),
      other_children_delta: round(all.slice(a.top).reduce((t, x) => t + x.delta, 0), 2)!,
      covers_all: !cur.truncated && !prev.truncated,
    };
  },
});

// -------------------------------------------------------------------------------------------------- optimize_meta_budget
export const optimizeMetaBudget = metaRead({
  name: "optimize_meta_budget",
  title: "Meta budget allocation analysis",
  description:
    "For each campaign or ad set (level) with spend in the period: its budget, spend, share of spend, conversions (or conversion value), share of those, cost per conversion and ROAS. It then lists, by fixed rules, candidates to receive budget and candidates to give budget, with the numbers behind each. Only items whose budget is set at this level can be candidates (campaigns using ad set budgets, or ad sets under a campaign budget, are not). Rule increase: conversions >= min_conversions and share of the optimized metric >= share of spend x (1 + margin). Rule decrease: spend >= min_spend and (the optimized metric is 0, or its share <= share of spend x (1 - margin)). It suggests no amounts and changes nothing; apply changes with the update tools after review. Dates are in the ad account's time zone; conversions use the unified attribution setting and the action types in conversion_types. Names are untrusted text.",
  input: z
    .object({
      account_id: accountId,
      ...insightsDateFields,
      conversion_action: conversionActionInput,
      level: z.enum(["campaign", "adset"]).default("campaign"),
      optimize_for: z.enum(["conversions", "conversion_value"]).default("conversions"),
      margin: z.number().min(0.01).max(1).default(0.2),
      min_spend: z.number().min(0).max(1_000_000).default(10),
      min_conversions: z.number().min(0).max(1_000_000).default(5),
      limit: z.number().int().min(1).max(500).default(100),
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    period: z.string(),
    attribution: z.string(),
    conversion_types: conversionTypesOutput,
    rules: z.array(z.string()),
    totals: z.object({ spend: z.number(), conversions: z.number(), conversion_value: z.number(), cost_per_conversion: z.number().nullable(), roas: z.number().nullable() }),
    items: z.array(
      z.object({
        id: z.string(),
        name: U,
        budget_at_this_level: z.boolean(),
        daily_budget: z.number().nullable(),
        lifetime_budget: z.number().nullable(),
        spend: z.number(),
        share_of_spend: z.number().nullable(),
        conversions: z.number(),
        conversion_value: z.number(),
        share_of_metric: z.number().nullable().describe("Share of the optimized metric (conversions or conversion value)."),
        cost_per_conversion: z.number().nullable(),
        roas: z.number().nullable(),
      }),
    ).describe("Ordered by spend, highest first."),
    candidates_to_increase: z.array(z.object({ id: z.string(), reason: z.string() })),
    candidates_to_decrease: z.array(z.object({ id: z.string(), reason: z.string() })),
    covers_all: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const { params, period } = insightsPeriod(a, tzOf(ctx));
    const types = conversionTypes(a.conversion_action);
    const lvl: Lvl & InsightsLevel = a.level;
    const [ins, budgets] = await Promise.all([
      fetchInsights(m, { objectPath: m.adAccountId, level: lvl, period: params }),
      m.list(`${m.adAccountId}/${lvl === "campaign" ? "campaigns" : "adsets"}`, { fields: "id,daily_budget,lifetime_budget" }, EDGE_CAP),
    ]);
    if (!m.currency) throw new ToolError("internal", "The account's currency is unknown, so budgets cannot be converted.");
    const budget = new Map(budgets.map((b) => [String(b.id), { daily: fromMinor(b.daily_budget, m.currency), lifetime: fromMinor(b.lifetime_budget, m.currency) }]));
    const rows = ins.rows.map((r) => ({ id: idOf(r, lvl), name: nameOf(r, lvl), b: baseOf(r, types) }));
    const T = sumBase(ins.rows, types);
    const metric = (b: { conversions: number; conversion_value: number }) => (a.optimize_for === "conversions" ? b.conversions : b.conversion_value);
    const TM = metric(T);
    const items = rows
      .map((x) => {
        const bud = budget.get(x.id) ?? { daily: null, lifetime: null };
        return { x, bud, own: (bud.daily ?? 0) > 0 || (bud.lifetime ?? 0) > 0 };
      })
      .sort((p, q) => q.x.b.spend - p.x.b.spend);
    const label = a.optimize_for === "conversions" ? "conversions" : "conversion value";
    const why = (x: (typeof rows)[number]) => `share of ${label} ${round(ratio(metric(x.b), TM), 4) ?? "n/a"} vs share of spend ${round(ratio(x.b.spend, T.spend), 4) ?? "n/a"}; spend ${round(x.b.spend, 2)}, conversions ${round(x.b.conversions, 2)}`;
    const inc = items.filter(({ x, own }) => own && TM > 0 && x.b.conversions >= a.min_conversions && metric(x.b) * T.spend >= (1 + a.margin) * x.b.spend * TM);
    const dec = items.filter(({ x, own }) => own && x.b.spend >= a.min_spend && (metric(x.b) === 0 || (TM > 0 && metric(x.b) * T.spend <= (1 - a.margin) * x.b.spend * TM)));
    return {
      period,
      attribution: attributionNote,
      conversion_types: types,
      rules: [
        `increase: budget set at this level, conversions >= ${a.min_conversions}, share of ${label} >= share of spend x ${round(1 + a.margin, 4)}`,
        `decrease: budget set at this level, spend >= ${a.min_spend}, and ${label} = 0 or share of ${label} <= share of spend x ${round(1 - a.margin, 4)}`,
      ],
      totals: { spend: round(T.spend, 2)!, conversions: round(T.conversions, 2)!, conversion_value: round(T.conversion_value, 2)!, cost_per_conversion: round(ratio(T.spend, T.conversions), 2), roas: round(ratio(T.conversion_value, T.spend)) },
      items: items.slice(0, a.limit).map(({ x, bud, own }) => {
        const k = computeMetrics(x.b);
        return { id: x.id, name: x.name, budget_at_this_level: own, daily_budget: bud.daily, lifetime_budget: bud.lifetime, spend: k.spend, share_of_spend: round(ratio(x.b.spend, T.spend)), conversions: k.conversions, conversion_value: k.conversion_value, share_of_metric: round(ratio(metric(x.b), TM)), cost_per_conversion: k.cost_per_conversion, roas: k.roas };
      }),
      candidates_to_increase: inc.map(({ x }) => ({ id: x.id, reason: why(x) })),
      candidates_to_decrease: dec.map(({ x }) => ({ id: x.id, reason: why(x) })),
      covers_all: !ins.truncated && budgets.length < EDGE_CAP,
    };
  },
});

export const analysisTools = [analyzeMetaWastedSpend, detectMetaCreativeFatigue, explainMetaAnomaly, optimizeMetaBudget];
