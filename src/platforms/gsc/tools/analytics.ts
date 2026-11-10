import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { GscClient, SaRequest } from "../client";
import {
  AGGREGATIONS,
  DATA_STATES,
  DEVICES,
  DIMENSIONS,
  type FilterInput,
  MetricsSchema,
  type Metrics,
  type Period,
  PeriodSchema,
  type PeriodArgs,
  SEARCH_TYPES,
  type SearchType,
  accountId,
  analyticsNotes,
  filterGroups,
  filterSchema,
  gscRead,
  metrics,
  noQueries,
  periodFields,
  resolvePeriod,
  rowObject,
  validateQuery,
} from "./common";

// searchAnalytics.query (POST webmasters/v3/sites/{siteUrl}/searchAnalytics/query). Dates Pacific Time; rows sorted by clicks
// descending (by date ascending when grouped by date); anonymized queries are omitted from rows but counted in totals.

export interface AnalyticsArgs extends PeriodArgs {
  type: SearchType;
  dimensions: string[];
  filters: FilterInput[];
  aggregation: (typeof AGGREGATIONS)[number];
  dataState: (typeof DATA_STATES)[number];
  limit: number;
  startRow: number;
}

export interface AnalyticsResult {
  period: Period;
  rows: (Metrics & { [dimension: string]: string | number | null })[];
  totals: Metrics;
  responseAggregationType: string | null;
  firstIncompleteDate: string | null;
  firstIncompleteHour: string | null;
  truncated: boolean;
  periodNotes: string[];
}

/**
 * Validates the query (Google's rules, dates), resolves the period, then runs the main query (paged up to `limit`, partial)
 * and a totals query with no dimensions and the same filters, type, aggregation and data state.
 */
export async function runAnalytics(gsc: GscClient, a: AnalyticsArgs): Promise<AnalyticsResult> {
  validateQuery({ dimensions: a.dimensions, type: a.type, filters: a.filters, aggregation: a.aggregation, dataState: a.dataState });
  const { period, notes } = await resolvePeriod(gsc, a, a.type, new Date(), a.dataState);
  const base: SaRequest = { startDate: period.start_date, endDate: period.end_date, type: a.type, ...filterGroups(a.filters), aggregationType: a.aggregation, dataState: a.dataState };
  const main = await gsc.searchAnalytics({ ...base, dimensions: a.dimensions }, { maxRows: a.limit, startRow: a.startRow, partial: true });
  const totalsRow = a.dimensions.length === 0 ? main.rows[0] : (await gsc.searchAnalytics({ ...base, dimensions: [] }, { maxRows: 1, partial: true })).rows[0];
  return {
    period,
    rows: main.rows.map((r) => ({ ...rowObject(a.dimensions, r.keys), ...metrics(r) })),
    totals: metrics(totalsRow),
    responseAggregationType: main.responseAggregationType,
    firstIncompleteDate: main.firstIncompleteDate,
    firstIncompleteHour: main.firstIncompleteHour,
    truncated: main.truncated,
    periodNotes: notes,
  };
}

const TotalsSchema = MetricsSchema.describe("The whole property for these filters, as Google totals it (includes anonymized queries unless a filter is set).");
const typeField = z.enum(SEARCH_TYPES).default("web").describe("Search type: web (default), image, video, news, discover or googleNews.");
const countryField = z.string().regex(/^[A-Za-z]{3}$/, "a 3-letter ISO 3166-1 alpha-3 code").optional().describe("Only this country (ISO 3166-1 alpha-3, e.g. USA).");
const deviceField = z.enum(DEVICES).optional().describe("Only this device.");
const text = (what: string) => z.string().min(1).max(4096).optional().describe(what);

// -------------------------------------------------------------------------------------------- get_search_performance
export const getSearchPerformance = gscRead({
  name: "get_search_performance",
  title: "Search performance",
  description:
    "Clicks, impressions, CTR and average position from Google Search for a site, grouped by any of country, device, page, query, searchAppearance, date and hour, with filters, search type and period. Returns Google's totals for the same filters next to the rows. Pages through up to the limit and reports truncated with next_start_row. Dates are Pacific Time.",
  input: z.object({
    account_id: accountId,
    ...periodFields,
    dimensions: z.array(z.enum(DIMENSIONS)).max(7).default([]).describe("Group by these, in this order. searchAppearance must be alone; hour needs data_state hourly_all."),
    type: typeField,
    filters: z.array(filterSchema).max(10).default([]).describe("All filters must match (AND)."),
    aggregation_type: z.enum(AGGREGATIONS).default("auto"),
    data_state: z.enum(DATA_STATES).default("final").describe("final (default), all (adds fresh data) or hourly_all (needed to group by hour). With all or hourly_all a named period ends on today (Pacific Time)."),
    limit: z.number().int().min(1).max(5000).default(100),
    start_row: z.number().int().min(0).max(50_000).default(0).describe("Skip this many rows (continue from next_start_row)."),
  }),
  output: z.object({
    site_url: z.string(),
    type: z.string(),
    data_state: z.string(),
    period: PeriodSchema,
    dimensions: z.array(z.string()),
    rows: z.array(MetricsSchema.catchall(z.union([z.string(), z.number(), z.null()]))).describe("Each row has one field per dimension (e.g. query, page) plus the metrics, in Google's order."),
    totals: TotalsSchema,
    response_aggregation_type: z.string().nullable(),
    first_incomplete_date: z.string().nullable(),
    first_incomplete_hour: z.string().nullable(),
    returned: z.number(),
    start_row: z.number(),
    truncated: z.boolean(),
    next_start_row: z.number().nullable(),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const r = await runAnalytics(ctx.services.gsc, { ...a, aggregation: a.aggregation_type, dataState: a.data_state, startRow: a.start_row });
    return {
      site_url: ctx.services.gsc.siteUrl,
      type: a.type,
      data_state: a.data_state,
      period: r.period,
      dimensions: a.dimensions,
      rows: r.rows,
      totals: r.totals,
      response_aggregation_type: r.responseAggregationType,
      first_incomplete_date: r.firstIncompleteDate,
      first_incomplete_hour: r.firstIncompleteHour,
      returned: r.rows.length,
      start_row: a.start_row,
      truncated: r.truncated,
      next_start_row: r.truncated ? a.start_row + r.rows.length : null,
      notes: analyticsNotes(a.type, a.data_state, r.periodNotes),
    };
  },
});

// ---------------------------------------------------------------------------------------------------- get_top_queries
export const getTopQueries = gscRead({
  name: "get_top_queries",
  title: "Top search queries",
  description:
    "The search queries that brought the most clicks from Google Search to a site in a period, with impressions, CTR and average position, plus Google's totals. Optional filters by page, country, device and query text. Discover and Google News are not offered because they report no queries. Dates are Pacific Time.",
  input: z.object({
    account_id: accountId,
    ...periodFields,
    type: z.enum(["web", "image", "video", "news"]).default("web"),
    page_filter: text("Only pages whose URL contains this."),
    country: countryField,
    device: deviceField,
    query_contains: text("Only queries containing this (case-insensitive)."),
    exclude_query_regex: text("Leave out queries matching this RE2 regular expression (e.g. your brand name)."),
    limit: z.number().int().min(1).max(1000).default(25),
  }),
  output: z.object({ site_url: z.string(), type: z.string(), period: PeriodSchema, queries: z.array(MetricsSchema.extend({ query: z.string() })), totals: TotalsSchema, returned: z.number(), truncated: z.boolean(), notes: z.array(z.string()) }),
  handler: async (a, ctx) => {
    const filters: FilterInput[] = [];
    if (a.page_filter) filters.push({ dimension: "page", operator: "contains", expression: a.page_filter });
    if (a.country) filters.push({ dimension: "country", operator: "equals", expression: a.country });
    if (a.device) filters.push({ dimension: "device", operator: "equals", expression: a.device });
    if (a.query_contains) filters.push({ dimension: "query", operator: "contains", expression: a.query_contains });
    if (a.exclude_query_regex) filters.push({ dimension: "query", operator: "excludingRegex", expression: a.exclude_query_regex });
    const r = await runAnalytics(ctx.services.gsc, { ...a, dimensions: ["query"], filters, aggregation: "auto", dataState: "final", startRow: 0 });
    const extra = a.query_contains || a.exclude_query_regex ? ["With a query filter, Google's totals leave out anonymized queries too."] : [];
    return {
      site_url: ctx.services.gsc.siteUrl,
      type: a.type,
      period: r.period,
      queries: r.rows.map((x) => ({ ...x, query: String(x.query ?? "") })),
      totals: r.totals,
      returned: r.rows.length,
      truncated: r.truncated,
      notes: analyticsNotes(a.type, "final", [...r.periodNotes, ...extra]),
    };
  },
});

// ------------------------------------------------------------------------------------------------------ get_top_pages
export const getTopPages = gscRead({
  name: "get_top_pages",
  title: "Top pages in search",
  description:
    "The site's pages that got the most clicks from Google (Search, image, video, news, Discover or Google News) in a period, with impressions, CTR and average position, plus Google's totals. Optional filters by page URL, country, device and query text. Dates are Pacific Time.",
  input: z.object({
    account_id: accountId,
    ...periodFields,
    type: typeField,
    page_contains: text("Only pages whose URL contains this."),
    country: countryField,
    device: deviceField,
    query_contains: text("Only clicks from queries containing this (not for Discover or Google News)."),
    limit: z.number().int().min(1).max(1000).default(25),
  }),
  output: z.object({ site_url: z.string(), type: z.string(), period: PeriodSchema, pages: z.array(MetricsSchema.extend({ page: z.string() })), totals: TotalsSchema, returned: z.number(), truncated: z.boolean(), notes: z.array(z.string()) }),
  handler: async (a, ctx) => {
    const filters: FilterInput[] = [];
    if (a.page_contains) filters.push({ dimension: "page", operator: "contains", expression: a.page_contains });
    if (a.country) filters.push({ dimension: "country", operator: "equals", expression: a.country });
    if (a.device) filters.push({ dimension: "device", operator: "equals", expression: a.device });
    if (a.query_contains) filters.push({ dimension: "query", operator: "contains", expression: a.query_contains });
    const r = await runAnalytics(ctx.services.gsc, { ...a, dimensions: ["page"], filters, aggregation: "auto", dataState: "final", startRow: 0 });
    return {
      site_url: ctx.services.gsc.siteUrl,
      type: a.type,
      period: r.period,
      pages: r.rows.map((x) => ({ ...x, page: String(x.page ?? "") })),
      totals: r.totals,
      returned: r.rows.length,
      truncated: r.truncated,
      notes: analyticsNotes(a.type, "final", [...r.periodNotes, "Grouped by page, Google computes CTR and position per page, which differs from the property totals."]),
    };
  },
});

// ------------------------------------------------------------------------------------------------ get_search_appearance

/** Search appearance API values and the names Search Console shows for them (Search Console Help, answer 17011259). */
export const APPEARANCE_LABEL: Record<string, string> = {
  AMP_TOP_STORIES: "AMP articles",
  AMP_BLUE_LINK: "AMP non-rich results",
  AMP_IMAGE_RESULT: "AMP on image result",
  FORUMS: "Discussion forums",
  EDU_Q_AND_A: "Education Q&As",
  JOB_DETAILS: "Job details",
  JOB_LISTING: "Job listings",
  MATH_SOLVERS: "Math solvers",
  ACTION: "Media Actions",
  MERCHANT_LISTINGS: "Merchant listings",
  PRACTICE_PROBLEMS: "Practice problems",
  PRODUCT_SNIPPETS: "Product snippets",
  TPF_QA: "Q&A rich results",
  RECIPE_FEATURE: "Recipe galleries",
  RECIPE_RICH_SNIPPET: "Recipe rich results",
  REVIEW_SNIPPET: "Review snippet",
  SUBSCRIBED_CONTENT: "Subscribed content",
  TRANSLATED_RESULT: "Translated results",
  VIDEO: "Videos",
  AMP_STORY: "Web Stories",
  // Deprecated by Google; kept so old periods still read well.
  SEARCH_APPEARANCE_ANDROID_APP: "Android app (deprecated)",
  EVENTS_DETAILS: "Event details (deprecated)",
  EVENTS_LISTING: "Event listing (deprecated)",
  TPF_FAQ: "FAQ rich results (deprecated)",
  PAGE_EXPERIENCE: "Good page experience (deprecated)",
  TPF_HOWTO: "How-to rich results (deprecated)",
  LEARNING_VIDEOS: "Learning videos (deprecated)",
  ORGANIC_SHOPPING: "Product results (deprecated)",
  SPECIAL_ANNOUNCEMENT: "Special announcements (deprecated)",
  WEBLITE: "Web Light results (deprecated)",
};
const APPEARANCE_CAP = 200;

export const getSearchAppearance = gscRead({
  name: "get_search_appearance",
  title: "Performance by search appearance",
  description:
    "Clicks, impressions, CTR and position per search appearance (rich result types such as product snippets, review snippets, videos) for a site and period. Optionally breaks one appearance down by query or page, using Google's documented two-step method (search appearance cannot be grouped with other dimensions). Dates are Pacific Time.",
  input: z.object({
    account_id: accountId,
    ...periodFields,
    type: typeField,
    appearance: z.string().regex(/^[A-Z0-9_]{2,64}$/, "an API value such as PRODUCT_SNIPPETS").optional().describe("One search appearance (API value from the appearances list) to break down."),
    breakdown: z.enum(["none", "query", "page"]).default("none").describe("With appearance: show its rows by query or by page."),
    limit: z.number().int().min(1).max(1000).default(50).describe("Most breakdown rows."),
  }),
  output: z.object({
    site_url: z.string(),
    type: z.string(),
    period: PeriodSchema,
    appearances: z.array(MetricsSchema.extend({ appearance: z.string(), label: z.string().nullable() })),
    breakdown: z.object({ appearance: z.string(), dimension: z.string(), rows: z.array(MetricsSchema.extend({ key: z.string() })), truncated: z.boolean() }).nullable(),
    returned: z.number(),
    truncated: z.boolean(),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const gsc = ctx.services.gsc;
    if (a.breakdown !== "none" && !a.appearance) throw new ToolError("invalid_argument", "A breakdown needs appearance (one API value, e.g. PRODUCT_SNIPPETS).");
    if (a.breakdown === "query" && noQueries(a.type)) throw new ToolError("invalid_argument", `${a.type === "discover" ? "Discover" : "Google News"} data has no queries: use breakdown page.`);
    const r = await runAnalytics(gsc, { ...a, dimensions: ["searchAppearance"], filters: [], aggregation: "auto", dataState: "final", limit: APPEARANCE_CAP, startRow: 0 });
    let breakdown: { appearance: string; dimension: string; rows: (Metrics & { key: string })[]; truncated: boolean } | null = null;
    if (a.appearance && a.breakdown !== "none") {
      const sub = await gsc.searchAnalytics(
        { startDate: r.period.start_date, endDate: r.period.end_date, type: a.type, dimensions: [a.breakdown], ...filterGroups([{ dimension: "searchAppearance", operator: "equals", expression: a.appearance }]), aggregationType: "auto", dataState: "final" },
        { maxRows: a.limit, partial: true },
      );
      breakdown = { appearance: a.appearance, dimension: a.breakdown, rows: sub.rows.map((x) => ({ key: x.keys[0] ?? "", ...metrics(x) })), truncated: sub.truncated };
    }
    const appearances = r.rows.map((x) => ({ appearance: String(x.searchAppearance ?? ""), label: APPEARANCE_LABEL[String(x.searchAppearance ?? "")] ?? null, ...metrics(x) }));
    return {
      site_url: gsc.siteUrl,
      type: a.type,
      period: r.period,
      appearances,
      breakdown,
      returned: appearances.length,
      truncated: r.truncated,
      notes: analyticsNotes(a.type, "final", [...r.periodNotes, "Search appearance data is aggregated by page, so it can differ from property totals.", "label is null for a value Google added that this server does not know yet; the raw value is always shown."]),
    };
  },
});
