import { z } from "zod";
import type { Platform } from "../../inventory";
import { ToolError } from "../../mcp/errors";
import type { OtherAccount, ReadTool, ResolvedAccount, ToolContext } from "../../mcp/tool";
import { isRealDate, ratio, round, todayIn } from "../core/report-math";
import type { GoogleAdsClient } from "../google/client";
import { Gaql, fromMicros, lit, num, pick } from "../google/gaql";
import { str } from "../google/tools/common";
import { checkDates, latestDataDate, pacificToday, PT } from "../gsc/tools/common";
import type { GscClient } from "../gsc/client";
import type { MetaAdsClient, MetaRow } from "../meta/client";
import { DEFAULT_CONVERSION_TYPES, baseOf, fetchInsights, rangeParams } from "../meta/insights";

/**
 * Shared pieces of the combined tools (docs/superpowers/plans/2026-11-10-cross-plan.md §1): choosing the other accounts,
 * one period in whole days across time zones, normalisation for joins, capped lists, the common output frame, and the
 * small fetchers several tools share. Every fetcher calls the platforms live through the clients the pipeline built.
 */

// ------------------------------------------------------------------------------------------------ permissions
const G = (s: string) => `https://www.googleapis.com/auth/${s}`;
export const ADWORDS = G("adwords");
export const GSC_READ = G("webmasters.readonly");
export const GA4_READ = G("analytics.readonly");
export const GTM_READ = G("tagmanager.readonly");
export const META_READ = "ads_read";

/** A combined read tool. Its permissions name every product it reads; each product's own connection grants its scope. */
export const crossRead = <S>() => <I extends z.ZodObject, O extends z.ZodType>(platform: Platform, platformPermissions: string[], def: Omit<ReadTool<I, O, S>, "kind" | "platform" | "permissions">): ReadTool<I, O, S> => ({
    timeoutMs: 90_000,
    ...def,
    kind: "read",
    platform,
    permissions: {
      scope: "ads:read",
      platformPermissions,
      notes: "Combined tool: reads each product through the account linked on the Connections page (or named explicitly). Each product's own connection must grant its read scope; nothing is stored.",
    },
  });

// ------------------------------------------------------------------------------------------------ other accounts
export const LABEL: Record<Platform, string> = {
  google_ads: "Google Ads account",
  meta_ads: "Meta ad account",
  google_search_console: "Search Console site",
  google_analytics: "GA4 property",
  google_tag_manager: "Tag Manager container",
};
const ownLabel = (ctx: ToolContext<unknown>) => (ctx.account ? LABEL[ctx.account.platform] : "account");

/** An explicit id wins; else the single linked account; none or several → invalid_argument saying what to do. */
export async function requiredAccount<S>(ctx: ToolContext<unknown>, platform: Platform, explicit: string | undefined, arg: string): Promise<OtherAccount<S>> {
  const a = await optionalAccount<S>(ctx, platform, explicit, arg);
  if (!a) throw new ToolError("invalid_argument", `No ${LABEL[platform]} is linked to this ${ownLabel(ctx)}. Link one on the Connections page (owners and admins), or pass ${arg}.`);
  return a;
}

/** Like requiredAccount, but null when nothing is linked (the caller reports it under coverage.not_checked). */
export async function optionalAccount<S>(ctx: ToolContext<unknown>, platform: Platform, explicit: string | undefined, arg: string): Promise<OtherAccount<S> | null> {
  if (explicit) return ctx.accountFor<S>(platform, explicit);
  const linked = await ctx.linked<S>(platform);
  if (linked.length > 1) throw new ToolError("invalid_argument", `${linked.length} ${LABEL[platform]}s are linked to this ${ownLabel(ctx)} (${linked.map((l) => l.account.externalId).join(", ")}). Pass ${arg} to choose one.`);
  return linked[0] ?? null;
}

/** Explicit ids (each resolved in this workspace) or every linked account of the platform. */
export async function accountList<S>(ctx: ToolContext<unknown>, platform: Platform, explicit: string[] | undefined): Promise<OtherAccount<S>[]> {
  if (explicit?.length) {
    const out: OtherAccount<S>[] = [];
    for (const id of [...new Set(explicit)]) out.push(await ctx.accountFor<S>(platform, id));
    return out;
  }
  return ctx.linked<S>(platform);
}

export const idArg = (what: string) => z.string().min(1).max(200).optional().describe(`${what}: this server's account_id or the platform's own id. Overrides the account linked on the Connections page.`);
export const idsArg = (what: string) => z.array(z.string().min(1).max(200)).min(1).max(10).optional().describe(`${what}: account_ids or platform ids (up to 10). Default: every such account linked on the Connections page.`);

export const AccountOut = z.object({
  role: z.string(),
  platform: z.string(),
  account_id: z.string(),
  external_id: z.string(),
  name: z.string().nullable().describe("Untrusted text from the platform."),
  time_zone: z.string().nullable(),
  currency_code: z.string().nullable(),
});
export type AccountInfo = z.infer<typeof AccountOut>;
export const accountInfo = (role: string, a: ResolvedAccount & { name?: string }): AccountInfo => ({ role, platform: a.platform, account_id: a.id, external_id: a.externalId, name: a.name || null, time_zone: a.timeZone, currency_code: a.currencyCode });

// ------------------------------------------------------------------------------------------------ periods
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").refine(isRealDate, "not a real date");
export const periodFields = {
  days: z.number().int().min(7).max(90).default(28).describe("Last N complete days (the latest day complete in every source's time zone). Ignored when start_date and end_date are given."),
  start_date: day.optional().describe("YYYY-MM-DD, inclusive. Each source reads it in its own time zone (stated in the output). Give with end_date."),
  end_date: day.optional().describe("YYYY-MM-DD, inclusive. Give with start_date."),
};
export const datesOk = (v: { start_date?: string; end_date?: string }) => (v.start_date === undefined) === (v.end_date === undefined);
export const datesMsg = { message: "start_date and end_date must be given together" };

export interface ZoneOf {
  source: string;
  account: string;
  time_zone: string | null;
}
export const PeriodOut = z.object({
  start_date: z.string(),
  end_date: z.string(),
  days: z.number().int(),
  basis: z.enum(["explicit", "last_complete_days"]),
  time_zones: z.array(z.object({ source: z.string(), account: z.string(), time_zone: z.string().nullable() })).describe("Each source reads the same dates in its own zone."),
  notes: z.array(z.string()),
});
export type CrossPeriod = z.infer<typeof PeriodOut>;

export function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
/** Today in a zone; an unknown zone counts as the earliest zone on Earth (UTC-12), so no day is taken as complete too early. */
const todayStrict = (tz: string | null, now: Date) => (tz ? todayIn(tz, now) : new Date(now.getTime() - 12 * 3_600_000).toISOString().slice(0, 10));

/** Search Console's latest day with final web data, else 3 days ago in Pacific Time. */
async function gscLatest(gsc: GscClient, now: Date): Promise<{ end: string; latest: string | null }> {
  const latest = await latestDataDate(gsc, "web", pacificToday(now));
  return { end: latest ?? addDays(pacificToday(now), -3), latest };
}

/**
 * One set of calendar dates for every source. Named periods end on the latest day complete in every zone (and, with
 * Search Console, on its latest day with final data). Explicit dates may not be after today in any zone; with Search
 * Console, end_date may not be after its latest day with final data either (later days would read as zero organic data).
 */
export async function resolveCrossPeriod(a: { days: number; start_date?: string; end_date?: string }, zones: ZoneOf[], o: { gsc?: GscClient; now?: Date } = {}): Promise<CrossPeriod> {
  const now = o.now ?? new Date();
  const all = o.gsc ? [...zones, { source: "google_search_console", account: o.gsc.siteUrl, time_zone: PT }] : zones;
  const today = all.map((z) => todayStrict(z.time_zone, now)).sort()[0] ?? todayIn(null, now);
  const notes: string[] = [];
  const known = [...new Set(all.map((z) => z.time_zone).filter((z): z is string => !!z))];
  if (known.length > 1) notes.push(`Each source reads these dates in its own time zone (${known.join(", ")}): day boundaries differ by the zones' UTC offsets, so per-day figures are not hour-aligned between sources.`);
  for (const z of all.filter((x) => !x.time_zone)) notes.push(`The time zone of ${z.source} ${z.account} is unknown here; its own reporting zone applies.`);
  let start: string, end: string, basis: CrossPeriod["basis"];
  if (a.start_date !== undefined || a.end_date !== undefined) {
    if (!a.start_date || !a.end_date) throw new ToolError("invalid_argument", "start_date and end_date must be given together.");
    if (a.start_date > a.end_date) throw new ToolError("invalid_argument", "start_date must not be after end_date.");
    if (a.end_date > today) throw new ToolError("invalid_argument", `end_date ${a.end_date} is after today (${today}) in one of the sources' time zones.`);
    if (o.gsc) {
      checkDates(a.start_date, a.end_date, pacificToday(now));
      const { end: gscEnd, latest } = await gscLatest(o.gsc, now);
      if (a.end_date > gscEnd)
        throw new ToolError(
          "invalid_argument",
          latest
            ? `end_date ${a.end_date} is after ${gscEnd}, Search Console's latest day with final data: later days have no final organic data yet and would read as zero. Use end_date ${gscEnd} or earlier.`
            : `end_date ${a.end_date} is after ${gscEnd}: Search Console returned no final data for the last 10 days, so days after ${gscEnd} (3 days ago, Pacific Time) would read as zero. Use end_date ${gscEnd} or earlier.`,
        );
    }
    [start, end, basis] = [a.start_date, a.end_date, "explicit"];
  } else {
    end = addDays(today, -1);
    if (o.gsc) {
      const { end: gscEnd, latest } = await gscLatest(o.gsc, now);
      if (!latest) notes.push(`Search Console returned no final data for the last 10 days, so the period ends no later than ${gscEnd} (3 days ago, Pacific Time).`);
      if (gscEnd < end) {
        end = gscEnd;
        notes.push(`The period ends on ${end}, Search Console's latest day with final data, so every source covers the same days.`);
      }
    }
    start = addDays(end, -(a.days - 1));
    basis = "last_complete_days";
  }
  return { start_date: start, end_date: end, days: daysBetween(start, end), basis, time_zones: all, notes };
}

// ------------------------------------------------------------------------------------------------ normalisation
/** Search terms and queries: NFKC, lower case, trimmed, whitespace collapsed. Exact join on this form only. */
export const normTerm = (s: string): string => s.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
export const TERM_RULE = "Search terms and queries are joined exactly after normalising: Unicode NFKC, lower case, trimmed, whitespace collapsed. No stemming, plurals, word order or close variants.";

const cleanPath = (p: string): string => {
  let path = p || "/";
  try {
    path = decodeURI(path);
  } catch {
    /* invalid escapes: keep as given */
  }
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  return path;
};

/** A landing URL: lower-case host, path without query/fragment, decoded, no trailing slash (except "/"). */
export function landing(url: string): { host: string; path: string; clean_url: string } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  return { host, path: cleanPath(u.pathname), clean_url: `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}${u.pathname}` };
}
/** GA4 landingPage (a path) in the same form as landing().path; null for GA4's "(not set)" and other non-paths. */
export const gaPath = (p: string): string | null => (p.startsWith("/") ? cleanPath(p.split(/[?#]/)[0]!) : null);
export const URL_RULE =
  "Landing URLs: host lower-cased, query string and fragment dropped (removes UTM and click ids), path percent-decoded, trailing '/' removed except the root. GA4's landingPage is a path without host, so pages are joined to GA4 on the path alone.";

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const;
export type Utm = Record<(typeof UTM_KEYS)[number], string | null>;
/** UTM values of a click: the link's own query, then url_tags (Meta: url_tags replace or are appended to the URL's parameters). */
export function utmOf(link: string | null, urlTags: string | null): Utm {
  const out: Utm = { utm_source: null, utm_medium: null, utm_campaign: null };
  const take = (q: URLSearchParams) => {
    for (const k of UTM_KEYS) {
      const v = q.get(k);
      if (v !== null && v.trim() !== "") out[k] = v.trim();
    }
  };
  if (link) {
    try {
      take(new URL(link).searchParams);
    } catch {
      /* not a URL */
    }
  }
  if (urlTags) take(new URLSearchParams(urlTags.replace(/^\?/, "")));
  return out;
}
export const isDynamic = (v: string | null) => !!v && /\{\{[^}]*\}\}/.test(v);
export const utmKey = (v: string) => v.trim().toLowerCase();
export const UTM_RULE =
  "Meta clicks are matched to GA4 by UTM only (GA4 has no Meta dimensions): utm_source and utm_campaign from the creative link plus url_tags (url_tags win) must equal GA4's sessionManualSource and sessionManualCampaignName, compared case-insensitively after trimming. Values with Meta dynamic parameters ({{...}}) are not resolved: Meta's developer documentation checked does not define them, so those campaigns are listed as unmatched.";

// ------------------------------------------------------------------------------------------------ lists
export const listOf = <T extends z.ZodType>(item: T) => z.object({ total: z.number().int(), returned: z.number().int(), truncated: z.boolean().describe("More items exist than are shown (raise limit)."), items: z.array(item) });
export function capList<T>(xs: T[], limit: number) {
  return { total: xs.length, returned: Math.min(limit, xs.length), truncated: xs.length > limit, items: xs.slice(0, limit) };
}
export const limitField = z.number().int().min(1).max(500).default(50).describe("Most items shown per list (every list reports its total).");

export const CoverageOut = z.object({
  sources: z.array(z.object({ source: z.string(), rows_read: z.number().int(), complete: z.boolean().describe("False when a row cap stopped the read."), note: z.string().nullable() })),
  not_checked: z.array(z.object({ source: z.string(), reason: z.string() })),
  notes: z.array(z.string()),
});
export type Coverage = z.infer<typeof CoverageOut>;
export const newCoverage = (): Coverage => ({ sources: [], not_checked: [], notes: [] });

export { ratio, round };
export const r2 = (n: number) => round(n, 2)!;

// ------------------------------------------------------------------------------------------------ Google Ads fetchers
export const ADS_ROW_CAP = 10_000;
const between = (p: { start_date: string; end_date: string }) => `segments.date BETWEEN ${lit.date(p.start_date)} AND ${lit.date(p.end_date)}`;

export interface AdsTerm {
  search_term: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  conversion_value: number;
}
/**
 * Search terms (search_term_view) for the dates, summed per normalised term across campaigns and ad groups. Reads up to
 * 10,000 rows by cost (GAQL's page limit); `complete` is false when that cap was reached.
 */
export async function adsSearchTerms(ads: GoogleAdsClient, p: { start_date: string; end_date: string }, o: { convertingOnly?: boolean } = {}): Promise<{ terms: Map<string, AdsTerm>; rows: number; complete: boolean }> {
  const q = new Gaql()
    .select("search_term_view.search_term", "metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value")
    .from("search_term_view")
    .where(between(p))
    .where(o.convertingOnly && "metrics.conversions > 0")
    .orderBy("metrics.cost_micros", "DESC")
    .limit(ADS_ROW_CAP);
  const rows = await ads.query(q, { maxRows: ADS_ROW_CAP });
  const terms = new Map<string, AdsTerm>();
  for (const r of rows) {
    const text = str(r, "search_term_view.search_term");
    if (!text) continue;
    const k = normTerm(text);
    const t = terms.get(k) ?? { search_term: text, impressions: 0, clicks: 0, cost: 0, conversions: 0, conversion_value: 0 };
    t.impressions += num(pick(r, "metrics.impressions"));
    t.clicks += num(pick(r, "metrics.clicks"));
    t.cost += fromMicros(pick(r, "metrics.cost_micros"));
    t.conversions += num(pick(r, "metrics.conversions"));
    t.conversion_value += num(pick(r, "metrics.conversions_value"));
    terms.set(k, t);
  }
  return { terms, rows: rows.length, complete: rows.length < ADS_ROW_CAP };
}

/** Account cost per day (customer resource, segments.date), in the account's currency. */
export async function adsDailyCost(ads: GoogleAdsClient, p: { start_date: string; end_date: string }): Promise<Map<string, number>> {
  const rows = await ads.query(new Gaql().select("segments.date", "metrics.cost_micros").from("customer").where(between(p)).orderBy("segments.date"), { maxRows: 1_000 });
  const out = new Map<string, number>();
  for (const r of rows) {
    const d = str(r, "segments.date");
    if (d) out.set(d, (out.get(d) ?? 0) + fromMicros(pick(r, "metrics.cost_micros")));
  }
  return out;
}
export const adsBetween = between;

// ------------------------------------------------------------------------------------------------ Meta fetchers
/**
 * Ads used per account. MetaAdsClient.list stops at 5,000 rows, so one more than this (5,000) is asked for: getting all
 * 5,000 back means the account has more ads than are used, and `truncated` is set.
 */
export const META_AD_CAP = 4_999;
const obj = (v: unknown): MetaRow => (v && typeof v === "object" && !Array.isArray(v) ? (v as MetaRow) : {});
const txt = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** The landing link of a creative: object_story_spec link (or call-to-action link), else the first asset_feed_spec link URL. */
export function creativeLink(creative: MetaRow): string | null {
  const oss = obj(creative.object_story_spec);
  for (const k of ["link_data", "video_data", "template_data", "photo_data"]) {
    const d = obj(oss[k]);
    const l = txt(d.link) ?? txt(obj(obj(d.call_to_action).value).link);
    if (l) return l;
  }
  const feed = obj(creative.asset_feed_spec);
  const urls = Array.isArray(feed.link_urls) ? feed.link_urls : [];
  for (const u of urls) {
    const l = txt(obj(u).website_url);
    if (l) return l;
  }
  return null;
}

export interface MetaAd {
  ad_id: string;
  campaign_id: string;
  effective_status: string | null;
  link: string | null;
  url_tags: string | null;
  utm: Utm;
}
/** Every ad of the account (up to META_AD_CAP; `truncated` when it has more) with its creative link, url_tags and the UTM values they produce. */
export async function metaAds(m: MetaAdsClient): Promise<{ ads: MetaAd[]; truncated: boolean }> {
  const rows = await m.list(`${m.adAccountId}/ads`, { fields: "id,campaign_id,effective_status,creative{url_tags,object_story_spec,asset_feed_spec}" }, META_AD_CAP + 1);
  const ads = rows.slice(0, META_AD_CAP).map((r) => {
    const c = obj(r.creative);
    const link = creativeLink(c);
    const urlTags = txt(c.url_tags);
    return { ad_id: String(r.id ?? ""), campaign_id: String(r.campaign_id ?? ""), effective_status: txt(r.effective_status), link, url_tags: urlTags, utm: utmOf(link, urlTags) };
  });
  return { ads, truncated: rows.length > META_AD_CAP };
}

export interface MetaCampaign {
  campaign_id: string;
  name: string | null;
  spend: number;
  clicks: number;
  link_clicks: number;
  conversions: number;
}
/** Campaign-level insights for the dates (ad account zone, unified attribution, default conversion types). */
export async function metaCampaigns(m: MetaAdsClient, p: { start_date: string; end_date: string }, tz: string | null): Promise<{ campaigns: MetaCampaign[]; truncated: boolean }> {
  const r = await fetchInsights(m, { objectPath: m.adAccountId, level: "campaign", period: rangeParams(p, tz) });
  return {
    campaigns: r.rows.map((row) => {
      const b = baseOf(row, DEFAULT_CONVERSION_TYPES);
      return { campaign_id: String(row.campaign_id ?? ""), name: txt(row.campaign_name), spend: b.spend, clicks: b.clicks, link_clicks: b.inline_link_clicks, conversions: b.conversions };
    }),
    truncated: r.truncated,
  };
}
export const META_CONVERSIONS = DEFAULT_CONVERSION_TYPES;

/** Account spend per day (insights, time_increment=1). */
export async function metaDailySpend(m: MetaAdsClient, p: { start_date: string; end_date: string }, tz: string | null): Promise<Map<string, number>> {
  const r = await fetchInsights(m, { objectPath: m.adAccountId, level: "account", period: rangeParams(p, tz), daily: true });
  const out = new Map<string, number>();
  for (const row of r.rows) {
    const d = txt(row.date_start);
    if (d) out.set(d, (out.get(d) ?? 0) + baseOf(row, []).spend);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ Search Console
export const GSC_QUERY_CAP = 25_000;
export interface GscQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}
/**
 * Web search queries for the dates (final data), merged per normalised query: clicks and impressions summed, position
 * weighted by impressions, CTR recomputed. Up to 25,000 rows; `truncated` when more exist.
 */
export async function gscQueries(gsc: GscClient, p: { start_date: string; end_date: string }): Promise<{ queries: Map<string, GscQuery>; rows: number; truncated: boolean }> {
  const r = await gsc.searchAnalytics({ startDate: p.start_date, endDate: p.end_date, dimensions: ["query"], type: "web", dataState: "final" }, { maxRows: GSC_QUERY_CAP, partial: true });
  const acc = new Map<string, { query: string; clicks: number; impressions: number; posImpr: number; posKnown: number }>();
  for (const row of r.rows) {
    const q = row.keys[0];
    if (!q) continue;
    const k = normTerm(q);
    const a = acc.get(k) ?? { query: q, clicks: 0, impressions: 0, posImpr: 0, posKnown: 0 };
    a.clicks += row.clicks;
    a.impressions += row.impressions;
    if (row.position !== null) {
      a.posImpr += row.position * row.impressions;
      a.posKnown += row.impressions;
    }
    acc.set(k, a);
  }
  const queries = new Map<string, GscQuery>();
  for (const [k, a] of acc) queries.set(k, { query: a.query, clicks: a.clicks, impressions: a.impressions, ctr: round(ratio(a.clicks, a.impressions)), position: a.posKnown ? round(a.posImpr / a.posKnown, 2) : null });
  return { queries, rows: r.rows.length, truncated: r.truncated };
}
export const GSC_NOTES = [
  "Search Console dates are Pacific Time.",
  "Search Console leaves anonymised (rare) queries out of query rows, so a term with no query row may still have had organic impressions.",
];
export const GscQueryOut = z.object({ query: z.string(), clicks: z.number(), impressions: z.number(), ctr: z.number().nullable(), position: z.number().nullable() });
