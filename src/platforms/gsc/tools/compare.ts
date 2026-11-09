import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { GscClient, SaRequest } from "../client";
import {
  type FilterInput,
  MetricsSchema,
  type Metrics,
  PERIODS,
  PT,
  type Period,
  PeriodSchema,
  SEARCH_TYPES,
  type SearchType,
  accountId,
  addDays,
  analyticsNotes,
  checkDates,
  filterGroups,
  filterSchema,
  gscRead,
  latestDataDate,
  metrics,
  pacificToday,
  resolvePeriod,
  validateQuery,
  ymd,
} from "./common";

// Two searchAnalytics.query calls per period (rows by query or page, and Google's totals), joined by key. Keys past the
// scan limit in one period are unknown there, never zero.

const days = (p: { start_date: string; end_date: string }) => Math.round((Date.parse(`${p.end_date}T00:00:00Z`) - Date.parse(`${p.start_date}T00:00:00Z`)) / 86_400_000) + 1;
const diff = (a: number | null, b: number | null, d = 4) => (a === null || b === null ? null : Math.round((a - b) * 10 ** d) / 10 ** d);

const Mover = z.object({
  key: z.string(),
  status: z.enum(["both", "new", "lost", "beyond_cap"]).describe("both: in both periods; new/lost: absent from the other period's complete list; beyond_cap: the other period was cut at scan_limit, so its value is unknown."),
  clicks_current: z.number().nullable(),
  clicks_previous: z.number().nullable(),
  clicks_change: z.number().nullable(),
  impressions_current: z.number().nullable(),
  impressions_previous: z.number().nullable(),
  impressions_change: z.number().nullable(),
  position_current: z.number().nullable(),
  position_previous: z.number().nullable(),
  position_change: z.number().nullable().describe("current minus previous: negative means it moved up."),
});
type MoverT = z.infer<typeof Mover>;
const Side = PeriodSchema.extend({ totals: MetricsSchema, rows_read: z.number(), truncated: z.boolean() });

async function readSide(gsc: GscClient, base: Omit<SaRequest, "startDate" | "endDate">, p: Period, scan: number) {
  const req = { ...base, startDate: p.start_date, endDate: p.end_date };
  const rows = await gsc.searchAnalytics(req, { maxRows: scan, partial: true });
  const totals = await gsc.searchAnalytics({ ...req, dimensions: [] }, { maxRows: 1, partial: true });
  const map = new Map<string, Metrics>();
  for (const r of rows.rows) map.set(r.keys[0] ?? "", metrics(r));
  return { map, truncated: rows.truncated, totals: metrics(totals.rows[0]), rowsRead: rows.rows.length };
}

export const compareSearchPeriods = gscRead({
  name: "compare_search_periods",
  title: "Compare search periods",
  description:
    "Compares two periods of Google Search data for a site, by query or by page: risers and fallers by clicks, new and lost keys, with the change in clicks, impressions and position, plus the change in Google's totals. The previous period defaults to the same length immediately before. A key missing from a period that was cut at scan_limit is reported as beyond_cap (unknown), never as zero. Dates are Pacific Time.",
  input: z.object({
    account_id: accountId,
    dimension: z.enum(["query", "page"]),
    type: z.enum(SEARCH_TYPES).default("web"),
    period: z.enum(PERIODS).default("last_28_days").describe("The current period, ending on the latest day with final data. Ignored when start_date and end_date are given."),
    start_date: ymd.optional().describe("Current period start, YYYY-MM-DD Pacific Time (with end_date)."),
    end_date: ymd.optional(),
    previous_start_date: ymd.optional().describe("Previous period start (with previous_end_date). Default: same length immediately before the current period."),
    previous_end_date: ymd.optional(),
    filters: z.array(filterSchema).max(10).default([]),
    scan_limit: z.number().int().min(1000).max(25_000).default(5000).describe("Rows read per period (top keys by clicks)."),
    min_impressions: z.number().int().min(0).max(1_000_000).default(10).describe("Leave out keys with fewer impressions than this in both periods."),
    limit: z.number().int().min(1).max(200).default(25).describe("Most keys per list."),
  }),
  output: z.object({
    site_url: z.string(),
    type: z.string(),
    dimension: z.string(),
    current: Side,
    previous: Side,
    periods_equal_length: z.boolean(),
    totals_change: z.object({ clicks: z.number(), impressions: z.number(), ctr: z.number().nullable(), position: z.number().nullable() }),
    risers: z.array(Mover),
    fallers: z.array(Mover),
    new: z.array(Mover),
    lost: z.array(Mover),
    counts: z.object({ risers: z.number(), fallers: z.number(), new: z.number(), lost: z.number() }).describe("How many keys each list has before limit is applied."),
    beyond_cap: z.number().describe("Keys whose value in the other period is unknown because that period was cut at scan_limit."),
    notes: z.array(z.string()),
  }),
  handler: async (a, ctx) => {
    const gsc = ctx.services.gsc;
    const type = a.type as SearchType;
    validateQuery({ dimensions: [a.dimension], type, filters: a.filters as FilterInput[], aggregation: "auto", dataState: "final" });
    const today = pacificToday();
    const prevGiven = a.previous_start_date !== undefined || a.previous_end_date !== undefined;
    if (prevGiven) {
      if (a.previous_start_date === undefined || a.previous_end_date === undefined) throw new ToolError("invalid_argument", "Give both previous_start_date and previous_end_date, or neither.");
      checkDates(a.previous_start_date, a.previous_end_date, today, "previous period");
    }
    const { period: cur, notes: periodNotes } = await resolvePeriod(gsc, a, type);
    const notes = [...periodNotes];
    let prev: Period;
    if (prevGiven) {
      prev = { start_date: a.previous_start_date!, end_date: a.previous_end_date!, time_zone: PT, end_basis: "explicit" };
      if (prev.end_date >= cur.start_date) throw new ToolError("invalid_argument", `The previous period (${prev.start_date} to ${prev.end_date}) must end before the current one starts (${cur.start_date}).`);
    } else {
      const end = addDays(cur.start_date, -1);
      prev = { start_date: addDays(end, -(days(cur) - 1)), end_date: end, time_zone: PT, end_basis: "explicit" };
      checkDates(prev.start_date, prev.end_date, today, "previous period (same length before the current one)");
    }
    if (cur.end_basis === "explicit") {
      const latest = await latestDataDate(gsc, type, today);
      if (latest && cur.end_date > latest) notes.push(`The current period ends after ${latest}, the latest day with final data, so its last days can look like a drop.`);
    }

    const base = { dimensions: [a.dimension], type, ...filterGroups(a.filters as FilterInput[]), aggregationType: "auto", dataState: "final" };
    const c = await readSide(gsc, base, cur, a.scan_limit);
    const p = await readSide(gsc, base, prev, a.scan_limit);

    const movers: MoverT[] = [];
    let beyond = 0;
    for (const key of new Set([...c.map.keys(), ...p.map.keys()])) {
      const x = c.map.get(key);
      const y = p.map.get(key);
      if (Math.max(x?.impressions ?? 0, y?.impressions ?? 0) < a.min_impressions) continue;
      let status: MoverT["status"] = "both";
      if (!y) status = p.truncated ? "beyond_cap" : "new";
      if (!x) status = c.truncated ? "beyond_cap" : "lost";
      if (status === "beyond_cap") {
        beyond++;
        continue;
      }
      // A side that is absent from a complete list had no clicks or impressions there.
      const xc = x ?? metrics(undefined);
      const yc = y ?? metrics(undefined);
      movers.push({
        key,
        status,
        clicks_current: xc.clicks,
        clicks_previous: yc.clicks,
        clicks_change: xc.clicks - yc.clicks,
        impressions_current: xc.impressions,
        impressions_previous: yc.impressions,
        impressions_change: xc.impressions - yc.impressions,
        position_current: x ? xc.position : null,
        position_previous: y ? yc.position : null,
        position_change: x && y ? diff(xc.position, yc.position, 2) : null,
      });
    }
    const up = (m: MoverT) => (m.clicks_change ?? 0) > 0 || ((m.clicks_change ?? 0) === 0 && (m.impressions_change ?? 0) > 0);
    const down = (m: MoverT) => (m.clicks_change ?? 0) < 0 || ((m.clicks_change ?? 0) === 0 && (m.impressions_change ?? 0) < 0);
    const byChange = (s: 1 | -1) => (m: MoverT, n: MoverT) => s * ((n.clicks_change ?? 0) - (m.clicks_change ?? 0)) || s * ((n.impressions_change ?? 0) - (m.impressions_change ?? 0)) || m.key.localeCompare(n.key);
    const risers = movers.filter((m) => m.status === "both" && up(m)).sort(byChange(1));
    const fallers = movers.filter((m) => m.status === "both" && down(m)).sort(byChange(-1));
    const added = movers.filter((m) => m.status === "new").sort((m, n) => (n.clicks_current ?? 0) - (m.clicks_current ?? 0) || (n.impressions_current ?? 0) - (m.impressions_current ?? 0) || m.key.localeCompare(n.key));
    const lost = movers.filter((m) => m.status === "lost").sort((m, n) => (n.clicks_previous ?? 0) - (m.clicks_previous ?? 0) || (n.impressions_previous ?? 0) - (m.impressions_previous ?? 0) || m.key.localeCompare(n.key));

    if (c.truncated || p.truncated) notes.push(`Only the top ${a.scan_limit.toLocaleString("en-US")} ${a.dimension === "query" ? "queries" : "pages"} by clicks were read in ${c.truncated && p.truncated ? "each period" : c.truncated ? "the current period" : "the previous period"}; ${beyond} key(s) whose other side lies past that limit are counted in beyond_cap, not compared.`);
    const equal = days(cur) === days(prev);
    if (!equal) notes.push(`The periods differ in length (${days(cur)} vs ${days(prev)} days), so raw changes are not like for like.`);
    notes.push("position_change is current minus previous: negative means the key moved up.");

    return {
      site_url: gsc.siteUrl,
      type,
      dimension: a.dimension,
      current: { ...cur, totals: c.totals, rows_read: c.rowsRead, truncated: c.truncated },
      previous: { ...prev, totals: p.totals, rows_read: p.rowsRead, truncated: p.truncated },
      periods_equal_length: equal,
      totals_change: { clicks: c.totals.clicks - p.totals.clicks, impressions: c.totals.impressions - p.totals.impressions, ctr: diff(c.totals.ctr, p.totals.ctr), position: diff(c.totals.position, p.totals.position, 2) },
      risers: risers.slice(0, a.limit),
      fallers: fallers.slice(0, a.limit),
      new: added.slice(0, a.limit),
      lost: lost.slice(0, a.limit),
      counts: { risers: risers.length, fallers: fallers.length, new: added.length, lost: lost.length },
      beyond_cap: beyond,
      notes: analyticsNotes(type, "final", notes),
    };
  },
});
