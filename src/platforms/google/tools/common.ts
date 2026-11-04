import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { asText, platformTools } from "../../core/tool-defs";
import type { GoogleAdsClient } from "../client";
import { DURING, Gaql, isRealDate, lit, pick } from "../gaql";
import type { GoogleServices } from "../services";

export const ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

export const accountId = z.string().min(1).describe("Connected Google Ads account id, as listed in your connections.");
export const campaignIds = z.array(z.string().regex(/^\d{1,20}$/, "numeric campaign id")).max(50).describe("Limit to these campaign ids (up to 50).");

/** Either a named period (evaluated in the account's own time zone by Google) or an explicit start/end date. */
export const dateFields = {
  date_range: z.enum(DURING).default("LAST_30_DAYS").describe("Named period, evaluated in the account's time zone."),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, "not a real date").optional().describe("Explicit start date (YYYY-MM-DD). Use with end_date; overrides date_range."),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, "not a real date").optional().describe("Explicit end date (YYYY-MM-DD)."),
};
export const datesOk = (v: { start_date?: string; end_date?: string }) => (v.start_date === undefined) === (v.end_date === undefined);
export const datesMsg = { message: "start_date and end_date must be given together" };

export function dateClause(v: { date_range: string; start_date?: string; end_date?: string }): string {
  if (v.start_date && v.end_date) {
    if (v.start_date > v.end_date) throw new ToolError("invalid_argument", "start_date must not be after end_date");
    return `segments.date BETWEEN ${lit.date(v.start_date)} AND ${lit.date(v.end_date)}`;
  }
  return `segments.date DURING ${lit.enumOf(v.date_range, DURING)}`;
}

export const nullable = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** Division that returns null instead of NaN/Infinity, so a metric is never reported as a number it is not. */
export const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
export const round = (n: number | null, digits = 4): number | null => (n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

const google = platformTools<GoogleServices>("google_ads", {
  read: { platformPermissions: [ADS_SCOPE], notes: "The Google Cloud project that issued the OAuth credentials needs Google Ads API access (Explorer, Basic or Standard). Developer tokens were sunset on 2026-09-09." },
  write: { platformPermissions: [ADS_SCOPE], notes: "Requires write access to the account for the connected Google user, and Google Ads API access on the Cloud project." },
});
/** Declares a Google Ads read tool with the standard scope and platform permission documentation. */
export const googleRead = google.read;
/** Declares a Google Ads write tool. Writes never run directly: the pipeline queues an approval first. */
export const googleWrite = google.write;

export const Money = z.number().describe("In the account's currency (micros converted to units).");


// ---------------------------------------------------------------------------------------------------------------
// Helpers shared by the tool files. Keep one definition of each: copies drift apart (this has already caused bugs).


/** A Google Ads numeric resource id (campaign, ad group, ad, criterion, shared set). */
export const idSchema = z.string().regex(/^\d{1,20}$/, "numeric id");

/** A field from a GAQL row as a string, or null when absent. */
/** A GAQL field (snake_case path, read from Google's camelCase JSON) as text, or null when absent. */
export const str = (row: Record<string, unknown>, field: string): string | null => asText(pick(row, field));

/** Currency units to micros, rounded to the nearest micro. */
export const toMicros = (units: number): number => Math.round(units * 1_000_000);

/** Sorted, de-duplicated copy: the stable form used in plan snapshots. */
export const sortedUnique = (xs: string[]): string[] => [...new Set(xs)].sort();

// Keyword input shared by campaign/ad group keywords and shared negative lists. Limits confirmed in the v26 KeywordInfo reference:
// text is at most 80 characters and 10 words; match types are BROAD, PHRASE and EXACT.
export const matchTypeSchema = z.enum(["BROAD", "PHRASE", "EXACT"]);
export const keywordText = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters").refine((t) => t.split(/\s+/).length <= 10, "at most 10 words");
export const keywordItem = z.object({ text: keywordText, match_type: matchTypeSchema });

/** Identity of a keyword for duplicate detection: Google treats text case-insensitively. */
export const keywordKey = (text: string, matchType: string): string => `${text.trim().toLowerCase()}|${matchType}`;

/** Splits requested keywords into those to add and the keys that already exist. Repeats inside the request are dropped. */
export function splitNewKeywords<T extends { text: string; match_type: string }>(items: T[], existing: { text: string; matchType: string }[]): { toAdd: T[]; skipped: string[] } {
  const have = new Set(existing.map((m) => keywordKey(m.text, m.matchType)));
  const seen = new Set<string>();
  const toAdd: T[] = [];
  const skipped = new Set<string>();
  for (const it of items) {
    const k = keywordKey(it.text, it.match_type);
    if (seen.has(k)) continue;
    seen.add(k);
    if (have.has(k)) skipped.add(k);
    else toAdd.push(it);
  }
  return { toAdd, skipped: [...skipped].sort() };
}

/** Status of a campaign or ad group, or null if it does not exist in this account. */
export async function entityStatus(ads: GoogleAdsClient, resource: "campaign" | "ad_group", id: string): Promise<string | null> {
  const [r] = await ads.query(new Gaql().select(`${resource}.id`, `${resource}.status`).from(resource).where(`${resource}.id = ${lit.id(id)}`).limit(1), { maxRows: 1 });
  return r ? str(r, `${resource}.status`) : null;
}

/**
 * The campaign or ad group must exist and not be removed. A campaign id passed where an ad group id belongs (and the reverse)
 * is called out, because it is the most common mistake: keywords and ads attach to ad groups, not campaigns.
 * `noun` names what attaches ("Keywords", "Ads") in that message.
 */
export async function requireParent(ads: GoogleAdsClient, level: "campaign" | "ad_group", id: string, noun = "Keywords"): Promise<string> {
  const status = await entityStatus(ads, level, id);
  const label = level === "ad_group" ? "ad group" : "campaign";
  if (status === null) {
    const other = await entityStatus(ads, level === "ad_group" ? "campaign" : "ad_group", id);
    if (other !== null) {
      throw new ToolError("invalid_argument", level === "ad_group" ? `${id} is a campaign id, not an ad group id. ${noun} attach to ad groups: use get_campaign_structure to find them.` : `${id} is an ad group id, not a campaign id.`);
    }
    throw new ToolError("not_found", `No ${label} ${id} in this account.`);
  }
  if (status === "REMOVED") throw new ToolError("invalid_argument", `The ${label} is removed.`);
  return status;
}
