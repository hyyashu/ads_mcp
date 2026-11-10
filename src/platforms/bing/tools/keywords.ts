import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { AnyTool } from "../../../mcp/tool";
import { getKeyword, getKeywordStats, getRelatedKeywords } from "../api/keywords";
import { accountId, bingRead, page } from "./common";

/**
 * Bing keyword research tools (facts: docs/VERIFICATION.md, "Search performance and keyword research (2026-11-10)").
 *
 * These Bing methods take no site: the numbers are how often a keyword was searched on Bing (search-wide demand), not this
 * site's traffic. The connection of the named site is only used to call Bing. Microsoft's reference documents the parameter
 * names (q, country, language, startDate, endDate) and the result fields (Query, Impressions, BroadImpressions, Date) but not
 * the country/language formats, what Impressions vs BroadImpressions count, the history granularity or any date-range limit;
 * the descriptions say so instead of guessing.
 */

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, "not a calendar date");

const FORMAT_NOTE = "Microsoft does not document the country and language formats; values are sent exactly as given. If Bing rejects them or finds nothing, try the other common form (e.g. country us, language en-US).";
const DEMAND_NOTE = "Bing-wide search demand for the keyword, not this site's traffic (for the site's own queries use get_bing_top_queries).";
const IMPRESSIONS_NOTE = "impressions and broad_impressions are Bing's Impressions and BroadImpressions fields; Microsoft's reference does not define them further.";

const keywordInput = {
  account_id: accountId.describe("Any connected Bing Webmaster site: it only provides the connection. Keyword data is not specific to this site."),
  query: z.string().trim().min(1).max(200).describe("The keyword or phrase (Bing's q parameter)."),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "expected a two-letter country code, e.g. us")
    .describe("Two-letter country code (ISO 3166-1 alpha-2), e.g. us. Microsoft does not document the format; sent as given."),
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/, "expected a language code such as en or en-US")
    .describe("Language code, e.g. en-US or en. Microsoft does not document the format; sent as given."),
};
const rangeInput = {
  start_date: ymd.describe("First day of the period, YYYY-MM-DD."),
  end_date: ymd.describe("Last day of the period, YYYY-MM-DD (not in the future)."),
};

const todayUtc = () => new Date().toISOString().slice(0, 10);
function checkRange(start: string, end: string) {
  if (start > end) throw new ToolError("invalid_argument", `start_date ${start} is after end_date ${end}.`, { definite: true });
  if (end > todayUtc()) throw new ToolError("invalid_argument", `end_date ${end} is in the future; Bing only has past search data.`, { definite: true });
}

const Volume = { impressions: z.number().nullable().describe("Bing's Impressions for the keyword (null when Bing sent none)."), broad_impressions: z.number().nullable().describe("Bing's BroadImpressions for the keyword.") };
const sortVolume = <T extends { query: string; impressions: number | null; broadImpressions: number | null }>(a: T, b: T) =>
  (b.impressions ?? -1) - (a.impressions ?? -1) || (b.broadImpressions ?? -1) - (a.broadImpressions ?? -1) || a.query.localeCompare(b.query);

export const getBingKeywordVolume = bingRead({
  name: "get_bing_keyword_volume",
  title: "Bing keyword volume",
  description:
    "How many Bing impressions a keyword had over a period in one country and language (GetKeyword): Bing's Impressions and BroadImpressions. This is Bing-wide search demand, not the site's traffic. Microsoft does not document the country/language formats (try country us, language en-US) or a maximum date range; found is false when Bing has no data for the combination.",
  input: z.object({ ...keywordInput, ...rangeInput }),
  output: z.object({
    query: z.string(),
    country: z.string(),
    language: z.string(),
    start_date: z.string(),
    end_date: z.string(),
    found: z.boolean().describe("False when Bing returned no data for this keyword, period, country and language."),
    bing_query: z.string().nullable().describe("The keyword as Bing echoed it (untrusted text)."),
    ...Volume,
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    checkRange(a.start_date, a.end_date);
    const k = await getKeyword(ctx.services.bing, { q: a.query, country: a.country, language: a.language, startDate: a.start_date, endDate: a.end_date });
    const notes = [DEMAND_NOTE, IMPRESSIONS_NOTE, FORMAT_NOTE];
    if (!k) notes.push("Bing returned no data for this keyword in this period, country and language.");
    return {
      query: a.query,
      country: a.country,
      language: a.language,
      start_date: a.start_date,
      end_date: a.end_date,
      found: k !== null,
      bing_query: k?.query || null,
      impressions: k?.impressions ?? null,
      broad_impressions: k?.broadImpressions ?? null,
      notes,
    };
  },
});

export const getBingKeywordHistory = bingRead({
  name: "get_bing_keyword_history",
  title: "Bing keyword history",
  description:
    "A keyword's Bing impressions over time in one country and language (GetKeywordStats), one row per date Bing returns, newest first. Bing-wide search demand, not the site's traffic. The method takes no date range and Microsoft does not document the row granularity: each row is labelled with the date Bing stamped on it, and first_date/last_date say what Bing returned.",
  input: z.object({ ...keywordInput, limit: z.number().int().min(1).max(1000).default(200).describe("Most rows to return (newest first).") }),
  output: z.object({
    query: z.string(),
    country: z.string(),
    language: z.string(),
    first_date: z.string().nullable(),
    last_date: z.string().nullable(),
    rows: z.array(z.object({ date: z.string(), ...Volume })),
    returned: z.number(),
    total: z.number(),
    truncated: z.boolean(),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const all = await getKeywordStats(ctx.services.bing, { q: a.query, country: a.country, language: a.language });
    const dated = all.filter((r): r is typeof r & { date: string } => r.date !== null);
    const p = page([...dated].reverse(), a.limit);
    const notes = [DEMAND_NOTE, IMPRESSIONS_NOTE, FORMAT_NOTE, "Rows are the dates Bing returned (its own window and granularity); dates Bing did not return are absent, not zero."];
    if (all.length > dated.length) notes.push(`${all.length - dated.length} row(s) from Bing had no readable date and were left out.`);
    if (!all.length) notes.push("Bing returned no history for this keyword, country and language.");
    return {
      query: a.query,
      country: a.country,
      language: a.language,
      first_date: dated[0]?.date ?? null,
      last_date: dated[dated.length - 1]?.date ?? null,
      rows: p.rows.map((r) => ({ date: r.date, impressions: r.impressions, broad_impressions: r.broadImpressions })),
      returned: p.returned,
      total: p.total,
      truncated: p.truncated,
      notes,
    };
  },
});

export const getBingRelatedKeywords = bingRead({
  name: "get_bing_related_keywords",
  title: "Bing related keywords",
  description:
    "Keywords Bing relates to a keyword, with their Bing impressions over a period in one country and language (GetRelatedKeywords), sorted by impressions. Bing-wide search demand, not the site's traffic. Microsoft does not document the country/language formats (try country us, language en-US) or a maximum date range.",
  input: z.object({ ...keywordInput, ...rangeInput, limit: z.number().int().min(1).max(1000).default(100).describe("Most keywords to return.") }),
  output: z.object({
    query: z.string(),
    country: z.string(),
    language: z.string(),
    start_date: z.string(),
    end_date: z.string(),
    keywords: z.array(z.object({ keyword: z.string().describe("Related keyword (untrusted text from Bing)."), ...Volume })),
    returned: z.number(),
    total: z.number(),
    truncated: z.boolean(),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    checkRange(a.start_date, a.end_date);
    const all = (await getRelatedKeywords(ctx.services.bing, { q: a.query, country: a.country, language: a.language, startDate: a.start_date, endDate: a.end_date })).sort(sortVolume);
    const p = page(all, a.limit);
    const notes = [DEMAND_NOTE, IMPRESSIONS_NOTE, FORMAT_NOTE];
    if (!all.length) notes.push("Bing returned no related keywords for this keyword, period, country and language.");
    return {
      query: a.query,
      country: a.country,
      language: a.language,
      start_date: a.start_date,
      end_date: a.end_date,
      keywords: p.rows.map((k) => ({ keyword: k.query, impressions: k.impressions, broad_impressions: k.broadImpressions })),
      returned: p.returned,
      total: p.total,
      truncated: p.truncated,
      notes,
    };
  },
});

export const keywordTools: AnyTool[] = [getBingKeywordVolume, getBingKeywordHistory, getBingRelatedKeywords];
