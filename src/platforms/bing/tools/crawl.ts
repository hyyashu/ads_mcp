import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { AnyTool } from "../../../mcp/tool";
import type { Change } from "../../../policy/change-set";
import { CRAWL_ISSUE_NAMES, CRAWL_RATE_HOURS, type CrawlIssueName, type CrawlSettings, type CrawlStatsDay, getCrawlIssues, getCrawlSettings, getCrawlStats, saveCrawlSettings } from "../api/crawl";
import { accountId, bingRead, bingWrite, page, readBack } from "./common";

// Facts: docs/VERIFICATION.md, "Crawl, sitemaps and backlinks (2026-11-10)".

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), "not a real date");

// ------------------------------------------------------------------------------------------------ get_bing_crawl_stats
const count = (what: string) => z.number().nullable().describe(what);
const CrawlDay = z.object({
  date: z.string().describe("Calendar day of the row (YYYY-MM-DD, the day Bing stamped on it)."),
  crawled_pages: count("CrawledPages: pages Bingbot crawled."),
  crawl_errors: count("CrawlErrors: crawl attempts that ended in an error."),
  in_index: count("InIndex: pages of the site in Bing's index."),
  in_links: count("InLinks: inbound links Bing knows to the site."),
  code_2xx: count("Code2xx: crawled URLs that answered with a 2xx (success) status."),
  code_301: count("Code301: crawled URLs that answered 301 (permanent redirect)."),
  code_302: count("Code302: crawled URLs that answered 302 (temporary redirect)."),
  code_4xx: count("Code4xx: crawled URLs that answered with a 4xx (client error, e.g. 404) status."),
  code_5xx: count("Code5xx: crawled URLs that answered with a 5xx (server error) status."),
  all_other_codes: count("AllOtherCodes: crawled URLs that answered with any other status."),
  blocked_by_robots_txt: count("BlockedByRobotsTxt: URLs Bingbot did not fetch because robots.txt disallows them."),
  contains_malware: count("ContainsMalware: URLs Bing flagged as containing malware."),
  dns_failures: count("DnsFailures: crawl attempts that failed because the host name did not resolve."),
  connection_timeout: count("ConnectionTimeout: crawl attempts that timed out connecting to the server."),
});
const crawlDayOut = (d: CrawlStatsDay): z.infer<typeof CrawlDay> => ({
  date: d.date,
  crawled_pages: d.crawledPages,
  crawl_errors: d.crawlErrors,
  in_index: d.inIndex,
  in_links: d.inLinks,
  code_2xx: d.code2xx,
  code_301: d.code301,
  code_302: d.code302,
  code_4xx: d.code4xx,
  code_5xx: d.code5xx,
  all_other_codes: d.allOtherCodes,
  blocked_by_robots_txt: d.blockedByRobotsTxt,
  contains_malware: d.containsMalware,
  dns_failures: d.dnsFailures,
  connection_timeout: d.connectionTimeout,
});

export const getBingCrawlStats = bingRead({
  name: "get_bing_crawl_stats",
  title: "Bing crawl statistics",
  description:
    "Daily crawl statistics Bing reports for the site over its own window of about the last 6 months (updated daily; no other date range is available, start_date/end_date only filter it): pages crawled, crawl errors, pages in Bing's index, inbound links, and crawled URLs by HTTP status (2xx, 301, 302, 4xx, 5xx, other), plus URLs blocked by robots.txt, flagged for malware, DNS failures and connection timeouts. One row per day, newest first. Microsoft does not describe the fields; each field's description gives the meaning read from its name. Do not add days together for in_index or in_links: they are counts on that day.",
  input: z.object({
    account_id: accountId,
    start_date: day.optional().describe("Only days on or after this date (YYYY-MM-DD)."),
    end_date: day.optional().describe("Only days on or before this date (YYYY-MM-DD)."),
    limit: z.number().int().min(1).max(400).default(200).describe("Most recent days to return."),
  }),
  output: z.object({
    site_url: z.string(),
    first_day: z.string().nullable().describe("Oldest day Bing returned (before filtering)."),
    last_day: z.string().nullable().describe("Newest day Bing returned (before filtering)."),
    days: z.array(CrawlDay),
    returned: z.number(),
    total: z.number(),
    truncated: z.boolean(),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    if (a.start_date && a.end_date && a.start_date > a.end_date) throw new ToolError("invalid_argument", "start_date is after end_date.");
    const bing = ctx.services.bing;
    const all = await getCrawlStats(bing);
    const inRange = all.filter((d) => (!a.start_date || d.date >= a.start_date) && (!a.end_date || d.date <= a.end_date));
    const p = page(inRange, a.limit);
    const notes = ["Bing returns about the last 6 months of daily rows and updates them daily; it takes no date range.", "Field meanings are read from Bing's field names: Microsoft's reference lists the fields without descriptions."];
    if (all.length && (a.start_date || a.end_date) && !inRange.length) notes.push(`No Bing crawl data in the requested range; Bing has ${all[all.length - 1]!.date} to ${all[0]!.date}.`);
    return { site_url: bing.siteUrl, first_day: all.at(-1)?.date ?? null, last_day: all[0]?.date ?? null, days: p.rows.map(crawlDayOut), returned: p.returned, total: p.total, truncated: p.truncated, notes };
  },
});

// ----------------------------------------------------------------------------------------------- get_bing_crawl_issues
const ISSUE_MEANING: Record<CrawlIssueName, string> = {
  Code301: "answered 301 (permanent redirect)",
  Code302: "answered 302 (temporary redirect)",
  Code4xx: "answered with a 4xx client error (e.g. 404 not found)",
  Code5xx: "answered with a 5xx server error",
  BlockedByRobotsTxt: "blocked by robots.txt",
  ContainsMalware: "flagged as containing malware",
  ImportantUrlBlockedByRobotsTxt: "an important URL blocked by robots.txt",
  DnsErrors: "the host name failed to resolve (DNS error)",
  TimeOutErrors: "the request timed out",
};

export const getBingCrawlIssues = bingRead({
  name: "get_bing_crawl_issues",
  title: "Bing crawl issues",
  description:
    "URLs of the site where Bingbot ran into a crawl issue: the HTTP status it got, how many inbound links the URL has, and the issues decoded from Bing's flags (Code301, Code302, Code4xx, Code5xx, BlockedByRobotsTxt, ContainsMalware, ImportantUrlBlockedByRobotsTxt, DnsErrors, TimeOutErrors; one URL can have several). Sorted by inbound links (most first), with a count per issue over the whole list. Bing notes it may take a few days before a fixed issue disappears from this list.",
  input: z.object({
    account_id: accountId,
    issue: z.enum(CRAWL_ISSUE_NAMES).optional().describe("Only URLs with this issue."),
    limit: z.number().int().min(1).max(1000).default(200),
  }),
  output: z.object({
    site_url: z.string(),
    urls: z.array(
      z.object({
        url: z.string().describe("URL as Bing reports it (untrusted text)."),
        http_code: z.number().nullable().describe("HTTP status Bingbot got."),
        in_links: z.number().nullable().describe("Inbound links Bing knows to this URL."),
        issues: z.array(z.enum(CRAWL_ISSUE_NAMES)),
        unrecognized_issues: z.array(z.string()).describe("Issue flags Bing set that its documentation does not name (normally empty)."),
      }),
    ),
    issue_counts: z.record(z.string(), z.number()).describe("URLs per issue over the whole list (before the issue filter and limit)."),
    issue_meanings: z.record(z.string(), z.string()),
    returned: z.number(),
    total: z.number(),
    truncated: z.boolean(),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const bing = ctx.services.bing;
    const all = await getCrawlIssues(bing);
    const issue_counts: Record<string, number> = {};
    for (const u of all) for (const i of u.issues) issue_counts[i] = (issue_counts[i] ?? 0) + 1;
    const sorted = all.filter((u) => !a.issue || u.issues.includes(a.issue)).sort((x, y) => (y.inLinks ?? -1) - (x.inLinks ?? -1) || x.url.localeCompare(y.url));
    const p = page(sorted, a.limit);
    return {
      site_url: bing.siteUrl,
      urls: p.rows.map((u) => ({ url: u.url, http_code: u.httpCode, in_links: u.inLinks, issues: u.issues, unrecognized_issues: u.unrecognized })),
      issue_counts,
      issue_meanings: ISSUE_MEANING,
      returned: p.returned,
      total: p.total,
      truncated: p.truncated,
      notes: ["It may take a few days before a fixed issue disappears from this list (Bing).", "Issue meanings are read from the flag names: Microsoft's reference lists them without descriptions."],
    };
  },
});

// -------------------------------------------------------------------------------------------- get_bing_crawl_settings
/** Bing's help page: the default is five per hour, Bing's own (algorithmic) baseline crawl rate for the site. */
export const BASELINE_RATE = 5;
/** Highest value this server sets: the Crawl Control grid's levels (the API documents no range). */
export const MAX_RATE = 10;
const relative = (r: number) => (r === BASELINE_RATE ? "baseline" : r > BASELINE_RATE ? "faster than baseline" : "slower than baseline");

const CRAWL_NOTES = [
  `crawl_rate holds Bing's 24 hourly values in Bing's order (hour 0 = the first value). Bing's API does not say which time zone the hours are in; Bing Webmaster Tools shows them in a time zone the user picks.`,
  `Bing's help: the default is ${BASELINE_RATE} per hour, Bing's own baseline for the site; higher means Bingbot visits more often, lower less often. The API documents no minimum or maximum.`,
  "crawl_boost_available and crawl_boost_enabled are reported as Bing returns them; Microsoft does not describe crawl boost.",
];

const SettingsOut = z.object({
  site_url: z.string(),
  crawl_rate: z.array(z.object({ hour: z.number().int(), rate: z.number().int(), relative: z.string() })),
  crawl_boost_available: z.boolean().nullable(),
  crawl_boost_enabled: z.boolean().nullable(),
  notes: z.array(z.string()),
});
const settingsOut = (siteUrl: string, s: CrawlSettings): z.infer<typeof SettingsOut> => ({
  site_url: siteUrl,
  crawl_rate: s.crawlRate.map((rate, hour) => ({ hour, rate, relative: relative(rate) })),
  crawl_boost_available: s.crawlBoostAvailable,
  crawl_boost_enabled: s.crawlBoostEnabled,
  notes: s.crawlRate.length === CRAWL_RATE_HOURS ? CRAWL_NOTES : [...CRAWL_NOTES, `Bing returned ${s.crawlRate.length} hourly values instead of ${CRAWL_RATE_HOURS}.`],
});

export const getBingCrawlSettings = bingRead({
  name: "get_bing_crawl_settings",
  title: "Bing crawl settings",
  description: `The site's Bing Crawl Control settings: the crawl rate for each of the 24 hours of the day (${BASELINE_RATE} is Bing's baseline for the site; higher = Bingbot visits more often, lower = less often) and whether crawl boost is available and enabled. Bing's API does not say which time zone the hours are in.`,
  input: z.object({ account_id: accountId }),
  output: SettingsOut,
  handler: async (_a, ctx) => settingsOut(ctx.services.bing.siteUrl, await getCrawlSettings(ctx.services.bing)),
});

// ----------------------------------------------------------------------------------------- update_bing_crawl_settings
const rate = z.number().int().min(1).max(MAX_RATE);
const updateInput = z
  .object({
    account_id: accountId,
    hours: z
      .array(z.object({ hour: z.number().int().min(0).max(CRAWL_RATE_HOURS - 1).describe("Position in Bing's 24 hourly values (0–23)."), rate: rate.describe(`New crawl rate for that hour (1–${MAX_RATE}; ${BASELINE_RATE} = Bing's baseline).`) }))
      .min(1)
      .max(CRAWL_RATE_HOURS)
      .refine((h) => new Set(h.map((x) => x.hour)).size === h.length, "each hour at most once")
      .optional()
      .describe("Hours to change. Hours not listed keep their current rate."),
    all_hours_rate: rate.optional().describe(`Set every hour to this rate (1–${MAX_RATE}). Not together with hours.`),
    crawl_boost_enabled: z.boolean().optional().describe("Turn crawl boost on or off. Only when Bing reports it as available for the site."),
  })
  .refine((a) => a.hours !== undefined || a.all_hours_rate !== undefined || a.crawl_boost_enabled !== undefined, "give hours, all_hours_rate or crawl_boost_enabled")
  .refine((a) => !(a.hours !== undefined && a.all_hours_rate !== undefined), "give hours or all_hours_rate, not both");
type UpdateIn = z.infer<typeof updateInput>;

interface SettingsSnap {
  site_url: string;
  crawl_rate: number[];
  crawl_boost_available: boolean | null;
  crawl_boost_enabled: boolean | null;
  ajax_enabled: boolean | null;
}
const snapOf = (siteUrl: string, s: CrawlSettings): SettingsSnap => ({ site_url: siteUrl, crawl_rate: s.crawlRate, crawl_boost_available: s.crawlBoostAvailable, crawl_boost_enabled: s.crawlBoostEnabled, ajax_enabled: s.ajaxEnabled });
const fromSnap = (s: SettingsSnap): CrawlSettings => ({ crawlRate: [...s.crawl_rate], crawlBoostAvailable: s.crawl_boost_available, crawlBoostEnabled: s.crawl_boost_enabled, ajaxEnabled: s.ajax_enabled });

/** The settings after applying the request on top of `live` (every field the request does not name is kept). */
function target(a: UpdateIn, live: CrawlSettings): CrawlSettings {
  const crawlRate = a.all_hours_rate !== undefined ? live.crawlRate.map(() => a.all_hours_rate!) : [...live.crawlRate];
  for (const h of a.hours ?? []) crawlRate[h.hour] = h.rate;
  return { ...live, crawlRate, crawlBoostEnabled: a.crawl_boost_enabled ?? live.crawlBoostEnabled };
}
const sameSettings = (x: CrawlSettings, y: CrawlSettings) => x.crawlRate.length === y.crawlRate.length && x.crawlRate.every((v, i) => v === y.crawlRate[i]) && x.crawlBoostEnabled === y.crawlBoostEnabled;
const hh = (i: number) => String(i).padStart(2, "0");
const onOff = (b: boolean | null) => (b === null ? "unknown" : b ? "on" : "off");

export const updateBingCrawlSettings = bingWrite({
  name: "update_bing_crawl_settings",
  title: "Change Bing crawl settings",
  risk: "high_impact",
  description: `Changes the site's Bing Crawl Control settings after approval by a person: the crawl rate of chosen hours (or of every hour) on Bing's scale (${BASELINE_RATE} = Bing's baseline for the site; 1–${MAX_RATE} accepted here, higher = Bingbot visits more often), and/or crawl boost on or off (only where Bing reports it as available). Every setting not named keeps its current value. Faster crawling adds load to the web server; slower crawling can delay Bing picking up new and changed pages. Bing's API does not say which time zone the 24 hours are in. The approval shows each changed hour before and after.`,
  input: updateInput,
  output: z.object({
    site_url: z.string(),
    crawl_rate: z.array(z.number().int()).describe("All 24 hourly values as read back from Bing after the change."),
    crawl_boost_enabled: z.boolean().nullable(),
    changed: z.array(z.string()).describe("Settings that changed, e.g. crawl_rate_hour_03, crawl_boost_enabled."),
  }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    const live = await getCrawlSettings(bing);
    if (live.crawlRate.length !== CRAWL_RATE_HOURS) throw new ToolError("unsupported", `Bing returned ${live.crawlRate.length} hourly crawl rates instead of ${CRAWL_RATE_HOURS}, so this server cannot tell which hour is which. Nothing was requested; change the settings in Bing Webmaster Tools.`);
    if (a.crawl_boost_enabled !== undefined && live.crawlBoostAvailable !== true && a.crawl_boost_enabled !== live.crawlBoostEnabled)
      throw new ToolError("invalid_argument", "Bing does not report crawl boost as available for this site, so it cannot be turned on or off here.", { definite: true });
    const next = target(a, live);
    const changes: Change[] = [];
    const parts: string[] = [];
    next.crawlRate.forEach((after, i) => {
      const before = live.crawlRate[i]!;
      if (before === after) return;
      changes.push({ resource: "bing_crawl_settings", id: bing.siteUrl, name: null, field: `crawl_rate_hour_${hh(i)}`, before, after, unit: "text", effect: after > before ? "enable" : "pause" });
      parts.push(`hour ${hh(i)}: ${before} → ${after} (${after > before ? "faster" : "slower"}; ${relative(after)})`);
    });
    if (next.crawlBoostEnabled !== live.crawlBoostEnabled) {
      changes.push({ resource: "bing_crawl_settings", id: bing.siteUrl, name: null, field: "crawl_boost_enabled", before: live.crawlBoostEnabled, after: next.crawlBoostEnabled, unit: "status", effect: next.crawlBoostEnabled ? "enable" : "pause" });
      parts.push(`crawl boost: ${onOff(live.crawlBoostEnabled)} → ${onOff(next.crawlBoostEnabled)}`);
    }
    if (!changes.length) throw new ToolError("invalid_argument", "Nothing would change: the crawl settings already have these values.", { definite: true });
    const faster = changes.some((c) => c.effect === "enable");
    const slower = changes.some((c) => c.effect === "pause");
    const summary =
      `Change Bing Crawl Control for ${bing.siteUrl}: ${parts.join("; ")}. ` +
      `This changes how often Bingbot crawls the whole site (${BASELINE_RATE} is Bing's baseline; hours are Bing's 24 hourly slots, and Bing's API does not say which time zone they are in).` +
      (faster ? " Faster crawling adds load to the web server." : "") +
      (slower ? " Slower crawling can delay Bing picking up new and changed pages." : "") +
      " All other hours and settings stay as they are.";
    return { summary, changes, snapshot: snapOf(bing.siteUrl, live) };
  },
  execute: async (a, ctx, run) => {
    const bing = ctx.services.bing;
    const before = fromSnap(run.snapshot as SettingsSnap);
    const want = target(a, before);
    await saveCrawlSettings(bing, want);
    const got = await readBack(() => getCrawlSettings(bing));
    if (!sameSettings(got, want)) throw new ToolError("unknown_outcome", "Bing accepted the request but the crawl settings do not read back as requested. Check get_bing_crawl_settings before trying again.");
    const changed = [...got.crawlRate.flatMap((v, i) => (v !== before.crawlRate[i] ? [`crawl_rate_hour_${hh(i)}`] : [])), ...(got.crawlBoostEnabled !== before.crawlBoostEnabled ? ["crawl_boost_enabled"] : [])];
    return { site_url: bing.siteUrl, crawl_rate: got.crawlRate, crawl_boost_enabled: got.crawlBoostEnabled, changed };
  },
  verify: async (a, ctx, run) => {
    const snap = run.snapshot as SettingsSnap | null;
    if (!snap?.crawl_rate) return { outcome: "indeterminate", detail: "no snapshot of the settings before the change" };
    const before = fromSnap(snap);
    const live = await getCrawlSettings(ctx.services.bing);
    if (sameSettings(live, target(a, before))) return { outcome: "applied" };
    if (sameSettings(live, before)) return { outcome: "not_applied" };
    return { outcome: "indeterminate", detail: "the crawl settings match neither the requested values nor the values before the request" };
  },
});

export const crawlTools: AnyTool[] = [getBingCrawlStats, getBingCrawlIssues, getBingCrawlSettings, updateBingCrawlSettings];
