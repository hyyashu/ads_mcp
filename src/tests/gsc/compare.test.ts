import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeGsc, guardBodies, gscHarness, type GscHarness } from "./fake-gsc";

const fake = new FakeGsc();
guardBodies(fake);
let kit: GscHarness;
beforeAll(async () => {
  fake.reset();
  kit = await gscHarness("GSCC", fake);
});
beforeEach(() => {
  fake.reset();
  // A fixed "now" (2026-11-10 in Pacific Time) so the explicit dates below never age out of the 16-month window.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T20:00:00Z"));
});
afterEach(() => vi.useRealTimers());

type R = [string, number, number, number];
const row = ([k, c, i, p]: R) => ({ keys: [k], clicks: c, impressions: i, ctr: c / i, position: p });
/** Answers per period: rows by key (first page only, cut to rowLimit) and totals. */
function periods(cur: R[], prev: R[], totals = { cur: [100, 1000, 5], prev: [80, 1000, 6] }) {
  fake.sa = (_s, b) => {
    const isCur = b.startDate === "2026-10-15";
    if (b.startRow > 0) return {};
    if (b.dimensions?.[0] === "date") return { rows: [{ keys: ["2026-11-06"], clicks: 1, impressions: 1 }] };
    if ((b.dimensions ?? []).length === 0) {
      const [c, i, p] = isCur ? totals.cur : totals.prev;
      return { rows: [{ keys: [], clicks: c, impressions: i, ctr: c! / i!, position: p }] };
    }
    return { rows: (isCur ? cur : prev).slice(0, b.rowLimit).map(row) };
  };
}
const args = { dimension: "query", start_date: "2026-10-15", end_date: "2026-10-28", min_impressions: 0 };
const sa = () => fake.calls.filter((c) => c.parts[2] === "searchAnalytics").map((c) => c.body);

describe("compare_search_periods", () => {
  it("defaults to the same length immediately before and classifies risers, fallers, new and lost", async () => {
    periods(
      [["up", 50, 500, 3], ["down", 5, 100, 9], ["fresh", 7, 70, 4], ["flat", 3, 30, 5]],
      [["up", 10, 400, 6.5], ["down", 20, 200, 4], ["gone", 9, 90, 2], ["flat", 3, 30, 5]],
    );
    const res = await kit.run("compare_search_periods", args);
    expect(res.ok).toBe(true);
    const d = res.data as any;
    expect(d.previous).toMatchObject({ start_date: "2026-10-01", end_date: "2026-10-14", rows_read: 4, truncated: false });
    expect(d.periods_equal_length).toBe(true);
    expect(d.risers.map((m: any) => m.key)).toEqual(["up"]);
    expect(d.risers[0]).toMatchObject({ status: "both", clicks_change: 40, impressions_change: 100, position_change: -3.5 });
    expect(d.fallers.map((m: any) => m.key)).toEqual(["down"]);
    expect(d.new[0]).toMatchObject({ key: "fresh", status: "new", clicks_previous: 0, position_previous: null, position_change: null });
    expect(d.lost[0]).toMatchObject({ key: "gone", status: "lost", clicks_current: 0, clicks_change: -9 });
    expect(d.counts).toEqual({ risers: 1, fallers: 1, new: 1, lost: 1 });
    expect(d.totals_change).toEqual({ clicks: 20, impressions: 0, ctr: 0.02, position: -1 });
    expect(d.beyond_cap).toBe(0);
    // explicit current dates: a date probe, then rows + totals for each period
    const firstPages = sa().filter((b) => b.startRow === 0);
    expect(firstPages.map((b) => `${b.startDate}:${(b.dimensions ?? []).join()}`)).toEqual([`${firstPages[0]?.startDate}:date`, "2026-10-15:query", "2026-10-15:", "2026-10-01:query", "2026-10-01:"]);
    expect(d.notes.join(" ")).not.toContain("ends after");
  });

  it("flags explicit dates that run past the latest day with final data", async () => {
    periods([], []);
    const d = (await kit.run("compare_search_periods", { ...args, end_date: "2026-11-08" })).data as any;
    expect(d.notes.join(" ")).toContain("ends after 2026-11-06, the latest day with final data");
  });

  it("a key missing from a period cut at scan_limit is beyond_cap with no values, never zero", async () => {
    const many = (n: number, prefix: string): R[] => Array.from({ length: n }, (_, i) => [`${prefix}${i}`, 1000 - i, 2000, 3]);
    periods(many(1000, "k").concat([["tail", 1, 10, 9]]), [...many(1000, "k"), ["tail", 50, 60, 2], ["rare", 1, 10, 3]]);
    const d = (await kit.run("compare_search_periods", { ...args, scan_limit: 1000 })).data as any;
    expect(d.current.truncated).toBe(true);
    expect(d.previous.truncated).toBe(true);
    expect(d.new).toEqual([]);
    expect(d.lost).toEqual([]);
    expect(d.notes.join(" ")).toMatch(/top 1,000 queries .* each period/);
    const all = [...d.risers, ...d.fallers, ...d.new, ...d.lost].map((m: any) => m.key);
    expect(all).not.toContain("tail");
  });

  it("only the current period cut: keys only in the previous period are beyond_cap", async () => {
    periods([["a", 9, 90, 1], ["b", 8, 80, 1]], [["c", 5, 50, 1]]);
    // scan_limit minimum is 1000, so emulate a cut by returning more rows than asked for in the current period only
    const orig = fake.sa;
    fake.sa = (s, b) => (b.startDate === "2026-10-15" && b.dimensions?.[0] === "query" && b.startRow === 0 ? { rows: Array.from({ length: b.rowLimit }, (_, i) => row([`x${i}`, 1, 10, 1])) } : orig(s, b));
    const d = (await kit.run("compare_search_periods", { ...args, scan_limit: 1000 })).data as any;
    expect(d.current.truncated).toBe(true);
    expect(d.previous.truncated).toBe(false);
    expect(d.beyond_cap).toBe(1); // "c": unknown in the current period
    expect(d.lost).toEqual([]);
    expect(d.new.length).toBe(25); // limited, with the full count reported
    expect(d.counts.new).toBe(1000);
  });

  it("only the previous period cut: a key only in the current period is beyond_cap, not new with zero previous clicks", async () => {
    periods([["fresh", 9, 90, 1]], []);
    const orig = fake.sa;
    fake.sa = (s, b) => (b.startDate === "2026-10-01" && b.dimensions?.[0] === "query" && b.startRow === 0 ? { rows: Array.from({ length: b.rowLimit }, (_, i) => row([`x${i}`, 1, 10, 1])) } : orig(s, b));
    const d = (await kit.run("compare_search_periods", { ...args, scan_limit: 1000 })).data as any;
    expect(d.current.truncated).toBe(false);
    expect(d.previous.truncated).toBe(true);
    expect(d.beyond_cap).toBe(1); // "fresh": unknown in the previous period
    expect(d.new).toEqual([]);
    expect([...d.risers, ...d.fallers, ...d.new, ...d.lost].map((m: any) => m.key)).not.toContain("fresh");
    expect(d.counts.lost).toBe(1000);
    expect(d.notes.join(" ")).toContain("in the previous period");
  });

  it("refuses last_365_days and last_16_months with the default previous period before calling Google; explicit previous dates work", async () => {
    periods([], []);
    for (const period of ["last_365_days", "last_16_months"]) {
      const res = await kit.run("compare_search_periods", { dimension: "page", period });
      expect(res.error?.code, period).toBe("invalid_argument");
      expect(res.error!.message).toContain("previous_start_date and previous_end_date");
    }
    expect(fake.calls).toHaveLength(0);
    // last_180_days with its default previous period fits in 16 months
    expect((await kit.run("compare_search_periods", { dimension: "page", period: "last_180_days" })).ok).toBe(true);
    // 2026-11-06 is the probe's latest day; last_365_days starts 2025-11-07, so the previous period must end before it
    const d = (await kit.run("compare_search_periods", { dimension: "page", period: "last_365_days", previous_start_date: "2025-07-15", previous_end_date: "2025-11-06" })).data as any;
    expect(d.current).toMatchObject({ start_date: "2025-11-07", end_date: "2026-11-06" });
    expect(d.periods_equal_length).toBe(false);
  });

  it("drops keys under min_impressions and flags unequal periods; refuses overlap and Discover queries", async () => {
    periods([["small", 1, 3, 1], ["big", 9, 90, 1]], [["big", 1, 50, 1]]);
    const d = (await kit.run("compare_search_periods", { ...args, min_impressions: 10, previous_start_date: "2026-09-01", previous_end_date: "2026-09-30" })).data as any;
    expect(d.new).toEqual([]);
    expect(d.periods_equal_length).toBe(false);
    expect(d.notes.join(" ")).toContain("14 vs 30 days");
    expect((await kit.run("compare_search_periods", { ...args, previous_start_date: "2026-10-10", previous_end_date: "2026-10-20" })).error?.code).toBe("invalid_argument");
    expect((await kit.run("compare_search_periods", { ...args, previous_start_date: "2026-10-10" })).error?.code).toBe("invalid_argument");
    fake.calls = [];
    expect((await kit.run("compare_search_periods", { ...args, type: "discover" })).error?.code).toBe("invalid_argument");
    expect(fake.calls).toHaveLength(0);
  });

  it("a named period uses the probe's end date and the previous period before it", async () => {
    periods([], []);
    const d = (await kit.run("compare_search_periods", { dimension: "page", period: "last_7_days" })).data as any;
    expect(d.current).toMatchObject({ start_date: "2026-10-31", end_date: "2026-11-06", end_basis: "latest_final_data" });
    expect(d.previous).toMatchObject({ start_date: "2026-10-24", end_date: "2026-10-30" });
  });
});
