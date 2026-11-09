import { describe, expect, it } from "vitest";
import { ToolError } from "../../mcp/errors";
import { dataQuality, dimFilterInput, metricFilterInput, num, quotaOf, resolvePeriod, shapeRows, suggest, toDimensionFilter, toMetricFilter, totalsOf, zoneNotes } from "../../platforms/ga4/report";
import { reportOf } from "./fake-ga4";

// 2026-11-10 11:30 UTC is already 2026-11-11 00:30 in Auckland (UTC+13 in November).
const NOW = new Date("2026-11-10T11:30:00Z");

describe("resolvePeriod", () => {
  it("resolves named periods to explicit dates in the property's zone", () => {
    expect(resolvePeriod({ date_range: "LAST_7_DAYS" }, "Pacific/Auckland", NOW)).toEqual({ start_date: "2026-11-04", end_date: "2026-11-10", label: "LAST_7_DAYS" });
    expect(resolvePeriod({ date_range: "LAST_7_DAYS" }, "America/Los_Angeles", NOW)).toEqual({ start_date: "2026-11-03", end_date: "2026-11-09", label: "LAST_7_DAYS" });
    expect(resolvePeriod({ date_range: "TODAY" }, "Pacific/Auckland", NOW)).toMatchObject({ start_date: "2026-11-11", end_date: "2026-11-11" });
    expect(resolvePeriod({ date_range: "YESTERDAY" }, "Pacific/Auckland", NOW)).toMatchObject({ start_date: "2026-11-10", end_date: "2026-11-10" });
    expect(resolvePeriod({ date_range: "LAST_28_DAYS" }, "UTC", NOW)).toMatchObject({ start_date: "2026-10-13", end_date: "2026-11-09" });
    expect(resolvePeriod({ date_range: "THIS_MONTH" }, "UTC", NOW)).toMatchObject({ start_date: "2026-11-01", end_date: "2026-11-10" });
    expect(resolvePeriod({ date_range: "LAST_MONTH" }, "UTC", NOW)).toMatchObject({ start_date: "2026-10-01", end_date: "2026-10-31" });
    expect(resolvePeriod({ date_range: "LAST_MONTH" }, "UTC", new Date("2026-03-15T12:00:00Z"))).toMatchObject({ start_date: "2026-02-01", end_date: "2026-02-28" });
  });

  it("checks explicit dates: order, together, not after today in the property zone", () => {
    expect(resolvePeriod({ date_range: "LAST_28_DAYS", start_date: "2026-11-01", end_date: "2026-11-11" }, "Pacific/Auckland", NOW)).toMatchObject({ label: "2026-11-01..2026-11-11" });
    const fut = () => resolvePeriod({ date_range: "LAST_28_DAYS", start_date: "2026-11-01", end_date: "2026-11-11" }, "America/Los_Angeles", NOW);
    expect(fut).toThrow(/in the future \(today is 2026-11-10 in the property's time zone, America\/Los_Angeles\)/);
    expect(() => resolvePeriod({ date_range: "LAST_28_DAYS", start_date: "2026-11-05", end_date: "2026-11-01" }, "UTC", NOW)).toThrow(ToolError);
    let msg = "";
    try {
      resolvePeriod({ date_range: "LAST_28_DAYS", start_date: "2026-11-05" }, "UTC", NOW);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("together");
  });

  it("with an unknown zone, sends GA's relative form and refuses calendar months", () => {
    expect(resolvePeriod({ date_range: "LAST_28_DAYS" }, null, NOW)).toEqual({ start_date: "28daysAgo", end_date: "yesterday", label: "LAST_28_DAYS" });
    expect(() => resolvePeriod({ date_range: "THIS_MONTH" }, null, NOW)).toThrow(/time zone is unknown/);
  });

  it("notes a zone change since connect", () => {
    expect(zoneNotes("Europe/Berlin", "Europe/Berlin")).toEqual([]);
    expect(zoneNotes("Europe/Berlin", "Europe/London")[0]).toContain("now reports in Europe/London");
  });
});

describe("filters", () => {
  it("maps dimension filters (negate, in_list, empty, and/or) and metric filters (int vs double, between)", () => {
    const d = [
      dimFilterInput.parse({ field: "country", match: "exact", value: "Germany" }),
      dimFilterInput.parse({ field: "pagePath", match: "partial_regexp", value: "^/blog", negate: true, case_sensitive: true }),
      dimFilterInput.parse({ field: "eventName", match: "in_list", values: ["a", "b"] }),
      dimFilterInput.parse({ field: "sessionCampaignName", match: "empty" }),
    ];
    expect(toDimensionFilter(d, "or")).toEqual({
      orGroup: {
        expressions: [
          { filter: { fieldName: "country", stringFilter: { matchType: "EXACT", value: "Germany", caseSensitive: false } } },
          { notExpression: { filter: { fieldName: "pagePath", stringFilter: { matchType: "PARTIAL_REGEXP", value: "^/blog", caseSensitive: true } } } },
          { filter: { fieldName: "eventName", inListFilter: { values: ["a", "b"], caseSensitive: false } } },
          { filter: { fieldName: "sessionCampaignName", emptyFilter: {} } },
        ],
      },
    });
    expect(toDimensionFilter([d[0]!])).toEqual({ filter: { fieldName: "country", stringFilter: { matchType: "EXACT", value: "Germany", caseSensitive: false } } });
    expect(toDimensionFilter([])).toBeUndefined();
    expect(toMetricFilter([metricFilterInput.parse({ field: "sessions", op: "gte", value: 10 }), metricFilterInput.parse({ field: "engagementRate", op: "between", value: 0.25, to_value: 1 })])).toEqual({
      andGroup: {
        expressions: [
          { filter: { fieldName: "sessions", numericFilter: { operation: "GREATER_THAN_OR_EQUAL", value: { int64Value: "10" } } } },
          { filter: { fieldName: "engagementRate", betweenFilter: { fromValue: { doubleValue: 0.25 }, toValue: { int64Value: "1" } } } },
        ],
      },
    });
  });

  it("refuses filters with missing or extra values", () => {
    expect(dimFilterInput.safeParse({ field: "country", match: "exact" }).success).toBe(false);
    expect(dimFilterInput.safeParse({ field: "country", match: "in_list", value: "x" }).success).toBe(false);
    expect(dimFilterInput.safeParse({ field: "country", match: "empty", value: "x" }).success).toBe(false);
    expect(metricFilterInput.safeParse({ field: "sessions", op: "between", value: 1 }).success).toBe(false);
    expect(metricFilterInput.safeParse({ field: "sessions", op: "gt", value: 1, to_value: 3 }).success).toBe(false);
    expect(dimFilterInput.safeParse({ field: "bad name", match: "exact", value: "x" }).success).toBe(false);
  });
});

describe("response shaping", () => {
  it("keys rows by header, parses numbers, never turns missing or text into 0, keeps (not set) and (other)", () => {
    const res = reportOf(["country"], ["sessions", "totalRevenue"], [
      [["(not set)"], ["12", "3.5"]],
      [["(other)"], ["", "abc"]],
      [["DE"], ["7", undefined]],
    ]);
    expect(shapeRows(res)).toEqual([
      { dimensions: { country: "(not set)" }, metrics: { sessions: 12, totalRevenue: 3.5 } },
      { dimensions: { country: "(other)" }, metrics: { sessions: null, totalRevenue: null } },
      { dimensions: { country: "DE" }, metrics: { sessions: 7, totalRevenue: null } },
    ]);
    expect(num("1e3")).toBe(1000);
    expect(num("NaN")).toBeNull();
  });

  it("totals: first TOTAL row, and per range when a dateRange column exists", () => {
    const res = reportOf(["country", "dateRange"], ["sessions"], [], { totals: [{ dimensionValues: [{ value: "RESERVED_TOTAL" }, { value: "date_range_0" }], metricValues: [{ value: "10" }] }, { dimensionValues: [{ value: "RESERVED_TOTAL" }, { value: "date_range_1" }], metricValues: [{ value: "4" }] }] });
    expect(totalsOf(res)).toEqual({ totals: { sessions: 10 }, totals_by_range: { date_range_0: { sessions: 10 }, date_range_1: { sessions: 4 } } });
    expect(totalsOf(reportOf([], ["sessions"], []))).toEqual({ totals: null, totals_by_range: null });
  });

  it("data quality notes for sampling, thresholding, (other), empty reason and low quota", () => {
    const q = dataQuality({ samplingMetadatas: [{ samplesReadCount: "250", samplingSpaceSize: "1000" }], subjectToThresholding: true, dataLossFromOtherRow: true, emptyReason: "No data" }, { tokensPerHour: { consumed: 39_000, remaining: 1_000 } }, ["first"]);
    expect(q).toMatchObject({ sampled: true, sampling: [{ date_range_index: 0, samples_read: 250, sampling_space_size: 1000, percent_of_events: 25 }], subject_to_thresholding: true, other_row: true, empty_reason: "No data" });
    expect(q.notes[0]).toBe("first");
    expect(q.notes.join(" ")).toMatch(/based on 25% of events.*thresholding.*'\(other\)'.*No data.*quota for this property is low/);
    expect(dataQuality(undefined, undefined)).toEqual({ sampled: false, sampling: [], subject_to_thresholding: false, other_row: false, empty_reason: null, notes: [] });
    expect(quotaOf({ tokensPerDay: { remaining: 5 } })).toEqual({ tokens_per_day_remaining: 5, tokens_per_hour_remaining: null, tokens_per_project_per_hour_remaining: null });
  });

  it("suggests close names", () => {
    const list = ["sessions", "sessionKeyEventRate", "engagedSessions", "keyEvents", "totalUsers"].map((apiName) => ({ apiName, uiName: apiName }));
    expect(suggest("session", list)[0]).toBe("sessions");
    expect(suggest("keyevent", list)).toContain("keyEvents");
    expect(suggest("zzz", list)).toEqual([]);
  });
});
