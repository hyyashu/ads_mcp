import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { isRealDate, todayIn } from "../../core/report-math";
import type { GscClient, SaFilter, SaRequest, SaRow } from "../client";
import { platformTools } from "../../core/tool-defs";
import { GSC_FULL, GSC_READONLY } from "../../gapi/scopes";
import type { GscServices } from "../services";

export { GSC_FULL, GSC_READONLY };

export const accountId = z.string().min(1).describe("Search Console site: the site URL exactly as Search Console shows it (https://example.com/ or sc-domain:example.com) or the account_id from list_accounts.");

const gsc = platformTools<GscServices>("google_search_console", {
  read: { platformPermissions: [GSC_READONLY], notes: "Search Console connection (read-only or allow changes; webmasters covers reads too). The Google Cloud project needs the Google Search Console API enabled." },
  write: { platformPermissions: [GSC_FULL], notes: "Search Console connection with changes allowed (webmasters scope), and an owner or full user permission on the site." },
});
/** Declares a Search Console read tool. */
export const gscRead = gsc.read;
/** Declares a Search Console write tool. Writes never run directly: the pipeline queues an approval first. */
export const gscWrite = gsc.write;

// ---------------------------------------------------------------------------------------------- shared tool pieces
// Every value below is from Google's Search Console API pages (docs/VERIFICATION.md, "Search Console tools (2026-11-10)").


/** Search Console dates are Pacific Time. */
export const PT = "America/Los_Angeles";
export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").refine(isRealDate, "not a real date");
export const SEARCH_TYPES = ["web", "image", "video", "news", "discover", "googleNews"] as const;
export const DIMENSIONS = ["country", "device", "page", "query", "searchAppearance", "date", "hour"] as const;
export const FILTER_DIMENSIONS = ["country", "device", "page", "query", "searchAppearance"] as const;
export const OPERATORS = ["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"] as const;
export const AGGREGATIONS = ["auto", "byPage", "byProperty", "byNewsShowcasePanel"] as const;
export const DATA_STATES = ["final", "all", "hourly_all"] as const;
export const PERIODS = ["last_7_days", "last_28_days", "last_90_days", "last_180_days", "last_365_days", "last_16_months"] as const;
export const DEVICES = ["DESKTOP", "MOBILE", "TABLET"] as const;
const PERIOD_DAYS: Record<(typeof PERIODS)[number], number | null> = { last_7_days: 7, last_28_days: 28, last_90_days: 90, last_180_days: 180, last_365_days: 365, last_16_months: null };

export type SearchType = (typeof SEARCH_TYPES)[number];
export type Dimension = (typeof DIMENSIONS)[number];
const isRegexOp = (op: string) => op === "includingRegex" || op === "excludingRegex";

export const filterSchema = z
  .object({
    dimension: z.enum(FILTER_DIMENSIONS),
    operator: z.enum(OPERATORS).default("equals"),
    expression: z.string().min(1).max(4096).describe("Value to match (at most 4,096 characters). Regex operators use RE2 syntax."),
  })
  .superRefine((f, ctx) => {
    if (f.dimension === "country" && !isRegexOp(f.operator) && !/^[A-Za-z]{3}$/.test(f.expression)) ctx.addIssue({ code: "custom", message: "country is a 3-letter ISO 3166-1 alpha-3 code, e.g. USA", path: ["expression"] });
    if (f.dimension === "device" && (f.operator === "equals" || f.operator === "notEquals") && !(DEVICES as readonly string[]).includes(f.expression.toUpperCase())) ctx.addIssue({ code: "custom", message: "device is DESKTOP, MOBILE or TABLET", path: ["expression"] });
  });
export type FilterInput = z.infer<typeof filterSchema>;

/** Filters as Google's request wants them: device values upper-case, everything else as given. */
export const toApiFilter = (f: FilterInput): SaFilter => ({ dimension: f.dimension, operator: f.operator, expression: f.dimension === "device" && !isRegexOp(f.operator) ? f.expression.toUpperCase() : f.expression });
export const filterGroups = (filters: FilterInput[]): Pick<SaRequest, "dimensionFilterGroups"> => (filters.length ? { dimensionFilterGroups: [{ groupType: "and", filters: filters.map(toApiFilter) }] } : {});

export const periodFields = {
  period: z.enum(PERIODS).default("last_28_days").describe("Named period in Pacific Time, ending on the latest day with final data (or on today when data_state includes fresh data). Ignored when start_date and end_date are given."),
  start_date: ymd.optional().describe("YYYY-MM-DD in Pacific Time (Search Console's time zone). Give with end_date; overrides period."),
  end_date: ymd.optional().describe("YYYY-MM-DD in Pacific Time, inclusive."),
};

export const MetricsSchema = z.object({
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number().nullable().describe("Click-through rate, 0 to 1."),
  position: z.number().nullable().describe("Average position (1 is the top). null when Google reports none."),
});
export type Metrics = z.infer<typeof MetricsSchema>;
export const END_BASIS = ["explicit", "latest_final_data", "fallback_today_minus_3", "today_fresh_data"] as const;
export const PeriodSchema = z.object({ start_date: z.string(), end_date: z.string(), time_zone: z.literal(PT), end_basis: z.enum(END_BASIS) });
export type Period = z.infer<typeof PeriodSchema>;

const round = (n: number | null, d: number) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);
export const metrics = (r: Pick<SaRow, "clicks" | "impressions" | "ctr" | "position"> | undefined): Metrics =>
  r ? { clicks: r.clicks, impressions: r.impressions, ctr: round(r.ctr, 4), position: round(r.position, 2) } : { clicks: 0, impressions: 0, ctr: null, position: null };
/** One row's keys as named fields, in the order the dimensions were requested. */
export const rowObject = (dimensions: readonly string[], keys: string[]): Record<string, string> => Object.fromEntries(dimensions.map((d, i) => [d, keys[i] ?? ""]));

// ----------------------------------------------------------------------------------------------------- dates

export const pacificToday = (now = new Date()): string => todayIn(PT, now);
export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
/** The same day `months` earlier, clamped to the end of a shorter month. */
export function minusMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, "0")}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
/** Search Console keeps data for the last 16 months. */
export const oldestAllowed = (today: string) => minusMonths(today, 16);

export function checkDates(start: string, end: string, today: string, label = ""): void {
  const p = label ? `${label}: ` : "";
  if (start > end) throw new ToolError("invalid_argument", `${p}start_date ${start} is after end_date ${end}.`);
  if (end > today) throw new ToolError("invalid_argument", `${p}end_date ${end} is after today (${today}) in Pacific Time, Search Console's time zone.`);
  const oldest = oldestAllowed(today);
  if (start < oldest) throw new ToolError("invalid_argument", `${p}Search Console keeps 16 months of data; the earliest date available is ${oldest} (Pacific Time).`);
}

/** The latest day with final data: one query grouped by date over the past 10 days, Google's own advice. Null when none. */
export async function latestDataDate(gsc: GscClient, type: SearchType, today: string): Promise<string | null> {
  const r = await gsc.searchAnalytics({ startDate: addDays(today, -10), endDate: today, dimensions: ["date"], type, dataState: "final" }, { maxRows: 11, partial: true });
  let max: string | null = null;
  for (const row of r.rows) if (row.keys[0] && (max === null || row.keys[0] > max)) max = row.keys[0];
  return max;
}

export interface PeriodArgs {
  period: (typeof PERIODS)[number];
  start_date?: string;
  end_date?: string;
}

/**
 * Explicit dates are checked and used as given. A named period ends on the latest day with final data, or, when the query
 * asks for fresh data (data_state all or hourly_all), on today in Pacific Time so the fresh days are included.
 */
export async function resolvePeriod(gsc: GscClient, a: PeriodArgs, type: SearchType, now = new Date(), dataState: (typeof DATA_STATES)[number] = "final"): Promise<{ period: Period; notes: string[] }> {
  const today = pacificToday(now);
  if (a.start_date !== undefined || a.end_date !== undefined) {
    if (a.start_date === undefined || a.end_date === undefined) throw new ToolError("invalid_argument", "Give both start_date and end_date, or neither (then period is used).");
    checkDates(a.start_date, a.end_date, today);
    return { period: { start_date: a.start_date, end_date: a.end_date, time_zone: PT, end_basis: "explicit" }, notes: [] };
  }
  if (dataState !== "final") return { period: periodEnding(a.period, today, today, "today_fresh_data"), notes: [] };
  return presetPeriod(gsc, a.period, type, today);
}

/** A named period ending on `end`, never starting before the 16-month retention limit. */
function periodEnding(preset: (typeof PERIODS)[number], end: string, today: string, basis: Period["end_basis"]): Period {
  const days = PERIOD_DAYS[preset];
  const oldest = oldestAllowed(today);
  let start = days === null ? oldest : addDays(end, -(days - 1));
  if (start < oldest) start = oldest;
  return { start_date: start, end_date: end, time_zone: PT, end_basis: basis };
}

export async function presetPeriod(gsc: GscClient, preset: (typeof PERIODS)[number], type: SearchType, today: string): Promise<{ period: Period; notes: string[] }> {
  const latest = await latestDataDate(gsc, type, today);
  const notes: string[] = [];
  const end = latest ?? addDays(today, -3);
  if (!latest) notes.push(`Search Console returned no final data for the last 10 days, so the period ends on ${end} (3 days ago; data is typically available after 2-3 days).`);
  return { period: periodEnding(preset, end, today, latest ? "latest_final_data" : "fallback_today_minus_3"), notes };
}

// ------------------------------------------------------------------------------------------ query validation

export interface QueryShape {
  dimensions: readonly string[];
  type: SearchType;
  filters: readonly FilterInput[];
  aggregation: (typeof AGGREGATIONS)[number];
  dataState: (typeof DATA_STATES)[number];
}

/**
 * Discover (Google's 2021 blog post) and Google News (Search Console Help, answer 10083653) report no queries and no
 * position.
 */
export const noQueries = (type: SearchType): boolean => type === "discover" || type === "googleNews";
const TYPE_LABEL: Record<SearchType, string> = { web: "Web", image: "Image", video: "Video", news: "News", discover: "Discover", googleNews: "Google News" };

/** Google's documented rules for one query, checked before anything is sent. */
export function validateQuery(q: QueryShape): void {
  const bad = (m: string) => {
    throw new ToolError("invalid_argument", m);
  };
  if (new Set(q.dimensions).size !== q.dimensions.length) bad("Each dimension may appear only once.");
  if (q.dimensions.includes("searchAppearance") && q.dimensions.length > 1) bad("searchAppearance cannot be grouped with other dimensions (Google's rule). Group by it alone, or use get_search_appearance with a breakdown.");
  if (q.dimensions.includes("hour") && q.dataState !== "hourly_all") bad('Grouping by hour needs data_state "hourly_all".');
  if (noQueries(q.type) && (q.dimensions.includes("query") || q.filters.some((f) => f.dimension === "query"))) bad(`${TYPE_LABEL[q.type]} data has no queries: drop the query dimension or filter, or use another type.`);
  const pageUsed = q.dimensions.includes("page") || q.filters.some((f) => f.dimension === "page");
  if (q.aggregation === "byProperty" && pageUsed) bad('aggregation_type "byProperty" cannot be used when grouping or filtering by page; use "auto".');
  if (q.aggregation === "byProperty" && (q.type === "discover" || q.type === "googleNews")) bad('aggregation_type "byProperty" is not supported for discover or googleNews.');
  if (q.aggregation === "byNewsShowcasePanel") {
    const sa = q.filters.filter((f) => f.dimension === "searchAppearance");
    if (sa.length !== 1 || sa[0]!.operator !== "equals" || sa[0]!.expression !== "NEWS_SHOWCASE") bad('aggregation_type "byNewsShowcasePanel" needs exactly one searchAppearance filter: equals NEWS_SHOWCASE.');
    if (q.type !== "discover" && q.type !== "googleNews") bad('aggregation_type "byNewsShowcasePanel" needs type discover or googleNews.');
    if (pageUsed) bad('aggregation_type "byNewsShowcasePanel" cannot be combined with page grouping or a page filter.');
  }
}

// --------------------------------------------------------------------------------------------- notes

export const NOTE_PT = "Dates are in Pacific Time (Search Console's time zone).";
export const NOTE_ANONYMIZED = "Anonymized queries are left out of rows but counted in totals (unless a filter is set), so rows can sum to less than totals.";
export const NOTE_ROW_LIMIT = "Google returns at most 50,000 rows per day per search type and may drop rows when grouping by page or query, so long tails can be missing.";
export const NOTE_DISCOVER = "Discover reports no queries, and position is not reported for Discover.";
export const NOTE_GOOGLE_NEWS = "Google News reports no queries, and position is not reported for Google News.";
export const NOTE_FRESH = "data_state includes fresh data that is still being collected; recent numbers can change.";
export function analyticsNotes(type: SearchType, dataState: string, extra: string[] = []): string[] {
  return [NOTE_PT, NOTE_ANONYMIZED, NOTE_ROW_LIMIT, ...(type === "discover" ? [NOTE_DISCOVER] : type === "googleNews" ? [NOTE_GOOGLE_NEWS] : []), ...(dataState !== "final" ? [NOTE_FRESH] : []), ...extra];
}

// ------------------------------------------------------------------------------------------ URLs and sites

/**
 * Whether `url` falls under the property: URL-prefix by prefix, Domain property by host (any subdomain, http or https).
 * Both sides are normalised by the URL parser first (host lower-cased, "." and ".." segments resolved), so
 * https://example.com/blog/../admin is not inside https://example.com/blog/.
 */
export function withinProperty(siteUrl: string, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (siteUrl.startsWith("sc-domain:")) {
    const d = siteUrl.slice("sc-domain:".length).toLowerCase();
    const h = u.hostname.toLowerCase();
    return h === d || h.endsWith(`.${d}`);
  }
  let site: URL;
  try {
    site = new URL(siteUrl);
  } catch {
    return false;
  }
  return u.href.startsWith(site.href);
}

export const httpUrl = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !/\s/.test(s);
    } catch {
      return false;
    }
  }, "expected a full http or https URL");

/** A property to add: sc-domain:example.com or a URL prefix ending in "/" (never fixed silently). */
export const siteUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .superRefine((s, ctx) => {
    if (s.startsWith("sc-domain:")) {
      if (!/^sc-domain:[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)) ctx.addIssue({ code: "custom", message: "a Domain property is sc-domain: followed by a domain name, e.g. sc-domain:example.com" });
      return;
    }
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      ctx.addIssue({ code: "custom", message: "expected sc-domain:example.com or a URL prefix such as https://www.example.com/" });
      return;
    }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash || /\s/.test(s)) ctx.addIssue({ code: "custom", message: "a URL-prefix property is an http or https URL with no query, fragment or credentials" });
    else if (!s.endsWith("/")) ctx.addIssue({ code: "custom", message: `URL-prefix properties need a trailing "/": use ${s}/` });
  })
  .describe("sc-domain:example.com (Domain property) or a URL prefix ending in /, e.g. https://www.example.com/");

export const propertyType = (siteUrl: string): "domain" | "url_prefix" => (siteUrl.startsWith("sc-domain:") ? "domain" : "url_prefix");

/** Plain-language permission levels (Search Console's Sites resource). */
export const PERMISSION_LABEL: Record<string, string> = { siteOwner: "owner", siteFullUser: "full user", siteRestrictedUser: "restricted user", siteUnverifiedUser: "unverified (ownership not verified)" };
export const permissionLabel = (p: string) => PERMISSION_LABEL[p] ?? (p || "unknown");

// ------------------------------------------------------------------------------------------------- writes

/**
 * The connected user's permission on this site, refusing levels that cannot change it: restricted users cannot submit
 * sitemaps (Search Console Help, permissions), and an unverified user has no access until ownership is verified.
 */
export async function requireEditor(gsc: GscClient, what: string): Promise<string> {
  const { permissionLevel } = await gsc.getSite();
  if (permissionLevel === "siteRestrictedUser") throw new ToolError("platform_permission_denied", `The connected Google user is a restricted user of ${gsc.siteUrl}; restricted users cannot ${what}. An owner or full user must do it.`);
  if (permissionLevel === "siteUnverifiedUser") throw new ToolError("platform_permission_denied", `The connected Google user has not verified ownership of ${gsc.siteUrl}; verify it in Search Console first.`);
  return permissionLevel;
}

/** A read after a change was sent: any failure there means the outcome is unknown, never a definite failure. */
export async function readBack<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw new ToolError("unknown_outcome", "The change was sent but reading it back failed, so its outcome is not confirmed. Check Search Console before trying again.");
  }
}
