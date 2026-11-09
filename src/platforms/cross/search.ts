import { z } from "zod";
import { ToolError } from "../../mcp/errors";
import type { OtherAccount, ToolContext } from "../../mcp/tool";
import type { GoogleServices } from "../google/services";
import { Gaql, pick } from "../google/gaql";
import { str } from "../google/tools/common";
import type { GscServices } from "../gsc/services";
import type { MetaServices } from "../meta/services";
import {
  ADS_ROW_CAP,
  ADWORDS,
  AccountOut,
  type AdsTerm,
  type Coverage,
  CoverageOut,
  GSC_NOTES,
  GSC_QUERY_CAP,
  GSC_READ,
  GscQueryOut,
  META_READ,
  PeriodOut,
  TERM_RULE,
  accountInfo,
  accountList,
  adsDailyCost,
  adsSearchTerms,
  capList,
  crossRead,
  datesMsg,
  datesOk,
  gscQueries,
  idArg,
  idsArg,
  limitField,
  listOf,
  metaDailySpend,
  newCoverage,
  normTerm,
  periodFields,
  r2,
  ratio,
  requiredAccount,
  resolveCrossPeriod,
  round,
} from "./common";
import { addDays } from "./common";

// Combined tools built on Search Console queries (design §5.5): paid/organic overlap, keyword gaps, converting terms without
// organic visibility, and the brand trend next to ad spend. Rules and caps: docs/superpowers/plans/2026-11-10-cross-plan.md.

const PaidOut = z.object({ impressions: z.number(), clicks: z.number(), cost: z.number().describe("Google Ads account currency."), conversions: z.number(), conversion_value: z.number() });
const paidOf = (t: AdsTerm) => ({ impressions: t.impressions, clicks: t.clicks, cost: r2(t.cost), conversions: round(t.conversions, 2)!, conversion_value: r2(t.conversion_value) });
const googleCross = crossRead<GoogleServices>();
const gscCross = crossRead<GscServices>();
const frame = { period: PeriodOut, accounts: z.array(AccountOut), rules: z.array(z.string()), coverage: CoverageOut };

/** The linked Search Console site, the period (with GSC's latest final day) and the Google Ads search terms + GSC queries. */
async function adsAndQueries(ctx: ToolContext<GoogleServices>, a: { site_account_id?: string; days: number; start_date?: string; end_date?: string }, o: { convertingOnly?: boolean } = {}) {
  const own = ctx.account!;
  const site = await requiredAccount<GscServices>(ctx, "google_search_console", a.site_account_id, "site_account_id");
  const period = await resolveCrossPeriod(a, [{ source: "google_ads", account: own.externalId, time_zone: own.timeZone }], { gsc: site.services.gsc });
  const [ads, gsc] = await Promise.all([adsSearchTerms(ctx.services.ads, period, o), gscQueries(site.services.gsc, period)]);
  const coverage = newCoverage();
  coverage.sources.push({ source: "google_ads search_term_view", rows_read: ads.rows, complete: ads.complete, note: ads.complete ? null : `Only the ${ADS_ROW_CAP.toLocaleString("en-US")} highest-cost search-term rows were read; lower-cost terms are not in this result.` });
  coverage.sources.push({ source: "google_search_console queries", rows_read: gsc.rows, complete: !gsc.truncated, note: gsc.truncated ? `Only the first ${GSC_QUERY_CAP.toLocaleString("en-US")} query rows were read (Search Console orders them by clicks); queries past that are treated as having no organic row.` : null });
  coverage.notes.push(...GSC_NOTES, "Google Ads search_term_view does not include Performance Max search terms.");
  const accounts = [accountInfo("google_ads", own), accountInfo("search_console_site", site.account)];
  return { site, period, ads, gsc, coverage, accounts };
}

// --------------------------------------------------------------------------------------- analyze_paid_organic_overlap
const OverlapRow = z.object({ search_term: z.string(), paid: PaidOut, organic: GscQueryOut });

export const analyzePaidOrganicOverlap = googleCross("google_ads", [ADWORDS, GSC_READ], {
  name: "analyze_paid_organic_overlap",
  title: "Paid search terms that already rank organically",
  description:
    "Joins the Google Ads search terms of this account with the Search Console queries of its linked site for the same days and lists the paid terms where the site already ranks in the top N organically (average position ≤ top_n, default 3), with the paid spend on each. These are candidates to review for lower bids or exclusion, not instructions: ranking organically does not mean the paid click would have come anyway. Also lists paid terms with no organic row. States the period, time zones, rules and what could not be matched.",
  input: z.object({ account_id: z.string().min(1), site_account_id: idArg("Search Console site"), ...periodFields, top_n: z.number().min(1).max(20).default(3).describe("Overlap when the average organic position is at most this."), min_impressions: z.number().int().min(0).max(1_000_000).default(10).describe("Organic impressions the query needs in the period."), limit: limitField }).refine(datesOk, datesMsg),
  output: z.object({
    ...frame,
    summary: z.object({ paid_terms: z.number().int(), paid_cost: z.number(), with_organic_row: z.number().int(), overlap_terms: z.number().int(), overlap_cost: z.number(), overlap_share_of_cost: z.number().nullable(), currency_code: z.string().nullable() }),
    overlap: listOf(OverlapRow),
    unmatched: z.object({ paid_terms_without_organic_row: listOf(z.object({ search_term: z.string(), cost: z.number(), clicks: z.number() })) }),
    note: z.string(),
  }),
  handler: async (a, ctx) => {
    const { period, ads, gsc, coverage, accounts } = await adsAndQueries(ctx, a);
    const rows: z.infer<typeof OverlapRow>[] = [];
    const without: { search_term: string; cost: number; clicks: number }[] = [];
    let withRow = 0;
    for (const [k, t] of ads.terms) {
      const q = gsc.queries.get(k);
      if (!q) {
        without.push({ search_term: t.search_term, cost: r2(t.cost), clicks: t.clicks });
        continue;
      }
      withRow++;
      if (q.position !== null && q.position <= a.top_n && q.impressions >= a.min_impressions) rows.push({ search_term: t.search_term, paid: paidOf(t), organic: q });
    }
    rows.sort((x, y) => y.paid.cost - x.paid.cost || x.search_term.localeCompare(y.search_term));
    without.sort((x, y) => y.cost - x.cost || x.search_term.localeCompare(y.search_term));
    const paidCost = [...ads.terms.values()].reduce((s, t) => s + t.cost, 0);
    const overlapCost = rows.reduce((s, r) => s + r.paid.cost, 0);
    return {
      period,
      accounts,
      rules: [TERM_RULE, `Overlap: the query's average organic position ≤ ${a.top_n} and organic impressions ≥ ${a.min_impressions} in the same days.`, "Paid figures are summed per normalised term across campaigns and ad groups."],
      coverage,
      summary: { paid_terms: ads.terms.size, paid_cost: r2(paidCost), with_organic_row: withRow, overlap_terms: rows.length, overlap_cost: r2(overlapCost), overlap_share_of_cost: round(ratio(overlapCost, paidCost)), currency_code: ctx.account!.currencyCode },
      overlap: capList(rows, a.limit),
      unmatched: { paid_terms_without_organic_row: capList(without, a.limit) },
      note: "Candidates to review, not instructions. Organic rank and paid clicks are reported side by side; this does not show that paid clicks would have arrived organically.",
    };
  },
});

// ------------------------------------------------------------------------------------------ find_organic_keyword_gaps
const KW_CAP = 10_000;
const GapRow = z.object({ query: z.string(), organic: GscQueryOut, reasons: z.array(z.string()), excluded_by_negative: z.boolean(), has_paid_search_term_traffic: z.boolean().describe("The same normalised text triggered ads as a search term in the period (e.g. via broad match).") });

export const findOrganicKeywordGaps = googleCross("google_ads", [ADWORDS, GSC_READ], {
  name: "find_organic_keyword_gaps",
  title: "Organic queries the account does not bid on",
  description:
    "Lists Search Console queries of the linked site with many impressions and a low CTR or poor average position that match no keyword of this Google Ads account (exact text after normalising, any match type): candidates to consider adding. Each row says whether a negative keyword excludes it and whether it already reached ads as a search term. Rules, thresholds, period and time zones are in the output; keyword lists past 10,000 are reported as incomplete.",
  input: z.object({ account_id: z.string().min(1), site_account_id: idArg("Search Console site"), ...periodFields, min_impressions: z.number().int().min(1).max(10_000_000).default(100), max_ctr: z.number().min(0).max(1).default(0.02).describe("Low CTR: at most this (0.02 = 2%)."), min_position: z.number().min(1).max(100).default(10).describe("Poor position: average position above this."), limit: limitField }).refine(datesOk, datesMsg),
  output: z.object({ ...frame, summary: z.object({ queries_read: z.number().int(), meeting_thresholds: z.number().int(), already_keywords: z.number().int(), gaps: z.number().int(), keywords_read: z.number().int() }), gaps: listOf(GapRow), note: z.string() }),
  handler: async (a, ctx) => {
    const { period, ads, gsc, coverage, accounts } = await adsAndQueries(ctx, a);
    const kwQ = new Gaql()
      .select("ad_group_criterion.keyword.text", "ad_group_criterion.negative")
      .from("ad_group_criterion")
      .where("ad_group_criterion.type = 'KEYWORD'")
      .where("ad_group_criterion.status != 'REMOVED'")
      .where("ad_group.status != 'REMOVED'")
      .where("campaign.status != 'REMOVED'")
      .limit(KW_CAP);
    const negQ = new Gaql().select("campaign_criterion.keyword.text").from("campaign_criterion").where("campaign_criterion.type = 'KEYWORD'").where("campaign_criterion.negative = TRUE").where("campaign.status != 'REMOVED'").limit(KW_CAP);
    const [kw, neg] = await Promise.all([ctx.services.ads.query(kwQ, { maxRows: KW_CAP }), ctx.services.ads.query(negQ, { maxRows: KW_CAP })]);
    const positive = new Set<string>();
    const negative = new Set<string>();
    for (const r of kw) {
      const t = str(r, "ad_group_criterion.keyword.text");
      if (t) (pick(r, "ad_group_criterion.negative") === true ? negative : positive).add(normTerm(t));
    }
    for (const r of neg) {
      const t = str(r, "campaign_criterion.keyword.text");
      if (t) negative.add(normTerm(t));
    }
    coverage.sources.push({ source: "google_ads keywords (ad group, not removed)", rows_read: kw.length, complete: kw.length < KW_CAP, note: kw.length < KW_CAP ? null : "Keyword list reached 10,000 rows: some 'gaps' may be keywords that were not read." });
    coverage.sources.push({ source: "google_ads campaign negative keywords", rows_read: neg.length, complete: neg.length < KW_CAP, note: null });
    coverage.notes.push("Negative keywords in shared negative lists are not read, so excluded_by_negative can be false for a query a shared list excludes.");
    const gaps: z.infer<typeof GapRow>[] = [];
    let meeting = 0;
    let already = 0;
    for (const [k, q] of gsc.queries) {
      if (q.impressions < a.min_impressions) continue;
      const reasons: string[] = [];
      if (q.ctr !== null && q.ctr <= a.max_ctr) reasons.push(`CTR ${q.ctr} ≤ ${a.max_ctr}`);
      if (q.position !== null && q.position > a.min_position) reasons.push(`average position ${q.position} > ${a.min_position}`);
      if (!reasons.length) continue;
      meeting++;
      if (positive.has(k)) {
        already++;
        continue;
      }
      gaps.push({ query: q.query, organic: q, reasons, excluded_by_negative: negative.has(k), has_paid_search_term_traffic: ads.terms.has(k) });
    }
    gaps.sort((x, y) => y.organic.impressions - x.organic.impressions || x.query.localeCompare(y.query));
    return {
      period,
      accounts,
      rules: [TERM_RULE, `Gap: organic impressions ≥ ${a.min_impressions} and (CTR ≤ ${a.max_ctr} or average position > ${a.min_position}), and the normalised query equals no positive ad-group keyword text (any match type, keywords not removed in campaigns and ad groups not removed).`, "excluded_by_negative: equals an ad-group or campaign negative keyword text (exact after normalising; match-type semantics are not applied)."],
      coverage,
      summary: { queries_read: gsc.queries.size, meeting_thresholds: meeting, already_keywords: already, gaps: gaps.length, keywords_read: kw.length },
      gaps: capList(gaps, a.limit),
      note: "Candidates to consider, not instructions: a broad or phrase keyword may already cover a query that is listed here, since only exact text is compared.",
    };
  },
});

// ------------------------------------------------------------------------------ find_converting_terms_without_content
const NoContentRow = z.object({ search_term: z.string(), paid: PaidOut });

export const findConvertingTermsWithoutContent = googleCross("google_ads", [ADWORDS, GSC_READ], {
  name: "find_converting_terms_without_content",
  title: "Converting paid terms with no organic visibility",
  description:
    "Lists Google Ads search terms that converted (conversions ≥ min_conversions, default 1) for which the linked Search Console site had no organic impressions in the same days: ideas for content. Says how many converting terms do have organic rows, and which caps or anonymised queries can hide organic impressions. Period, time zones and rules are stated.",
  input: z.object({ account_id: z.string().min(1), site_account_id: idArg("Search Console site"), ...periodFields, min_conversions: z.number().min(0.01).max(1_000_000).default(1), limit: limitField }).refine(datesOk, datesMsg),
  output: z.object({ ...frame, summary: z.object({ converting_terms: z.number().int(), with_organic_impressions: z.number().int(), without_organic_impressions: z.number().int(), currency_code: z.string().nullable() }), terms: listOf(NoContentRow), note: z.string() }),
  handler: async (a, ctx) => {
    const { period, ads, gsc, coverage, accounts } = await adsAndQueries(ctx, a, { convertingOnly: true });
    const rows: z.infer<typeof NoContentRow>[] = [];
    let converting = 0;
    let withOrganic = 0;
    for (const [k, t] of ads.terms) {
      if (t.conversions < a.min_conversions) continue;
      converting++;
      if ((gsc.queries.get(k)?.impressions ?? 0) > 0) withOrganic++;
      else rows.push({ search_term: t.search_term, paid: paidOf(t) });
    }
    rows.sort((x, y) => y.paid.conversions - x.paid.conversions || y.paid.cost - x.paid.cost || x.search_term.localeCompare(y.search_term));
    return {
      period,
      accounts,
      rules: [TERM_RULE, `Converting: conversions ≥ ${a.min_conversions} (Google Ads metrics.conversions, summed per normalised term).`, "Without organic visibility: no Search Console web query row with impressions > 0 for the same normalised text in the same days."],
      coverage,
      summary: { converting_terms: converting, with_organic_impressions: withOrganic, without_organic_impressions: rows.length, currency_code: ctx.account!.currencyCode },
      terms: capList(rows, a.limit),
      note: "Content ideas, not instructions. A term can also lack organic impressions because Search Console anonymised the query or because another wording ranks.",
    };
  },
});

// ------------------------------------------------------------------------------------------ analyze_brand_search_trend
/** One brand term as a case-insensitive RE2 pattern without flags: letters become [xX] classes, everything else is escaped. */
export function brandPattern(term: string): string {
  return [...normTerm(term)]
    .map((c) => {
      const lo = c.toLowerCase();
      const up = c.toUpperCase();
      if (lo !== up && lo.length === 1 && up.length === 1) return `[${lo}${up}]`;
      if (c === " ") return "\\s+";
      return /[\\^$.|?*+()[\]{}]/.test(c) ? `\\${c}` : c;
    })
    .join("");
}

const SpendSeries = z.object({ account: AccountOut, total: z.number(), by_bucket: z.array(z.number()).describe("Spend per row of series, same order, in this account's currency.") });
const SeriesRow = z.object({ bucket_start: z.string(), bucket_end: z.string(), branded_clicks: z.number(), branded_impressions: z.number(), all_clicks: z.number(), all_impressions: z.number(), branded_share_of_clicks: z.number().nullable() });

export const analyzeBrandSearchTrend = gscCross("google_search_console", [GSC_READ, ADWORDS, META_READ], {
  name: "analyze_brand_search_trend",
  title: "Branded organic search over time next to ad spend",
  description:
    "Shows branded organic search (queries containing any of brand_terms) per day or week from Search Console, next to the daily spend of the linked (or named) Google Ads and Meta ad accounts. A trend only: it never says the ads caused a change. Brand terms are an input; matching is case-insensitive substring on the query. States period, time zones, rules and what Search Console leaves out.",
  input: z
    .object({
      account_id: z.string().min(1),
      brand_terms: z.array(z.string().trim().min(2).max(80)).min(1).max(20).describe("Brand names or spellings; a query containing any of them counts as branded."),
      google_ads_account_ids: idsArg("Google Ads accounts for spend"),
      meta_account_ids: idsArg("Meta ad accounts for spend"),
      granularity: z.enum(["day", "week"]).default("week").describe("week = Monday to Sunday buckets (a partial first or last week is marked by its dates)."),
      days: z.number().int().min(7).max(480).default(90).describe("Last N complete days (ending on Search Console's latest final day)."),
      start_date: periodFields.start_date,
      end_date: periodFields.end_date,
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    ...frame,
    brand_pattern: z.string().describe("The RE2 pattern sent to Search Console (includingRegex on query)."),
    series: z.array(SeriesRow),
    spend: z.array(SpendSeries),
    summary: z.object({ first_half_avg_branded_clicks: z.number().nullable(), second_half_avg_branded_clicks: z.number().nullable(), change: z.number().nullable().describe("(second - first) / first; null when first is 0.") }),
    note: z.string(),
  }),
  handler: async (a, ctx) => {
    const gsc = ctx.services.gsc;
    const [gAds, metas] = await Promise.all([accountList<GoogleServices>(ctx, "google_ads", a.google_ads_account_ids), accountList<MetaServices>(ctx, "meta_ads", a.meta_account_ids)]);
    const spendAccounts: OtherAccount<GoogleServices | MetaServices>[] = [...gAds, ...metas];
    const period = await resolveCrossPeriod(a, spendAccounts.map((x) => ({ source: x.account.platform, account: x.account.externalId, time_zone: x.account.timeZone })), { gsc });
    if (period.days > 480) throw new ToolError("invalid_argument", "The period may be at most 480 days.");
    const pattern = `(${a.brand_terms.map(brandPattern).join("|")})`;
    const base = { startDate: period.start_date, endDate: period.end_date, dimensions: ["date"], type: "web", dataState: "final" };
    const [branded, all] = await Promise.all([
      gsc.searchAnalytics({ ...base, dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "query", operator: "includingRegex", expression: pattern }] }] }, { maxRows: 1_000 }),
      gsc.searchAnalytics(base, { maxRows: 1_000 }),
    ]);
    const spends = await Promise.all(
      spendAccounts.map(async (x) => (x.account.platform === "google_ads" ? adsDailyCost((x.services as GoogleServices).ads, period) : metaDailySpend((x.services as MetaServices).meta, period, x.account.timeZone))),
    );
    // buckets
    const buckets: { start: string; end: string }[] = [];
    for (let d = period.start_date; d <= period.end_date; ) {
      let end = d;
      if (a.granularity === "week") {
        const dow = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
        end = addDays(d, 6 - dow);
        if (end > period.end_date) end = period.end_date;
      }
      buckets.push({ start: d, end });
      d = addDays(end, 1);
    }
    const idx = (date: string) => buckets.findIndex((b) => date >= b.start && date <= b.end);
    const series = buckets.map((b) => ({ bucket_start: b.start, bucket_end: b.end, branded_clicks: 0, branded_impressions: 0, all_clicks: 0, all_impressions: 0, branded_share_of_clicks: null as number | null }));
    for (const r of branded.rows) {
      const i = idx(r.keys[0] ?? "");
      if (i >= 0) (series[i]!.branded_clicks += r.clicks), (series[i]!.branded_impressions += r.impressions);
    }
    for (const r of all.rows) {
      const i = idx(r.keys[0] ?? "");
      if (i >= 0) (series[i]!.all_clicks += r.clicks), (series[i]!.all_impressions += r.impressions);
    }
    for (const s of series) s.branded_share_of_clicks = round(ratio(s.branded_clicks, s.all_clicks));
    const spend = spendAccounts.map((x, i) => {
      const by = buckets.map(() => 0);
      for (const [d, v] of spends[i]!) {
        const j = idx(d);
        if (j >= 0) by[j] = by[j]! + v;
      }
      return { account: accountInfo(x.account.platform === "google_ads" ? "spend_google_ads" : "spend_meta", x.account), total: r2(by.reduce((s, v) => s + v, 0)), by_bucket: by.map(r2) };
    });
    const half = Math.floor(series.length / 2);
    const avg = (xs: typeof series) => (xs.length ? round(xs.reduce((s, x) => s + x.branded_clicks, 0) / xs.length, 2) : null);
    const first = half ? avg(series.slice(0, half)) : null;
    const second = half ? avg(series.slice(series.length - half)) : null;
    const coverage: Coverage = newCoverage();
    coverage.sources.push({ source: "google_search_console date rows (branded)", rows_read: branded.rows.length, complete: true, note: null }, { source: "google_search_console date rows (all)", rows_read: all.rows.length, complete: true, note: null });
    for (const [i, x] of spendAccounts.entries()) coverage.sources.push({ source: `${x.account.platform} daily spend`, rows_read: spends[i]!.size, complete: true, note: null });
    if (!gAds.length) coverage.not_checked.push({ source: "google_ads", reason: "No Google Ads account is linked to this site (or named)." });
    if (!metas.length) coverage.not_checked.push({ source: "meta_ads", reason: "No Meta ad account is linked to this site (or named)." });
    coverage.notes.push(
      ...GSC_NOTES,
      "When filtering by query, Search Console drops anonymised queries from the branded figures, so branded clicks can be undercounted; the 'all' figures include them.",
      "Spend is per day in each ad account's own time zone and currency; currencies are never added together.",
    );
    return {
      period,
      accounts: [accountInfo("search_console_site", ctx.account!), ...spend.map((s) => s.account)],
      rules: [`Branded: the query contains any of: ${a.brand_terms.map((t) => `"${normTerm(t)}"`).join(", ")} (case-insensitive, spaces match any whitespace).`, `Buckets: ${a.granularity === "week" ? "weeks from Monday to Sunday; the first and last may be partial (see bucket dates)" : "single days"}.`, "Summary: average branded clicks per bucket in the first half of the buckets vs the second half (an odd middle bucket is left out)."],
      coverage,
      brand_pattern: pattern,
      series,
      spend,
      summary: { first_half_avg_branded_clicks: first, second_half_avg_branded_clicks: second, change: first !== null && second !== null ? round(ratio(second - first, first)) : null },
      note: "A trend shown next to spend, not an explanation: seasonality, PR, other channels and Google changes also move branded search. No causal claim is made.",
    };
  },
});
