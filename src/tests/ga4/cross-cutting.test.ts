import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ga4Tools } from "../../platforms/ga4";
import * as api from "../../platforms/ga4/api";
import { GA4_EDIT, GA4_READONLY } from "../../platforms/gapi/scopes";
import { type FakeGa4, type Ga4Harness, fakeGa4, ga4Harness, quotaError } from "./fake-ga4";

let f: FakeGa4;
let kit: Ga4Harness;

beforeAll(async () => {
  f = fakeGa4();
  kit = await ga4Harness("G4X", f);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T11:30:00Z"));
});
afterAll(() => vi.useRealTimers());
beforeEach(() => f.reset());

const ALL = [
  "list_ga4_properties",
  "get_ga4_metadata",
  "run_ga4_report",
  "run_ga4_pivot_report",
  "run_ga4_funnel_report",
  "get_ga4_realtime",
  "get_traffic_by_channel",
  "get_campaign_traffic",
  "get_landing_page_performance",
  "get_google_ads_traffic_in_ga4",
  "get_conversion_events",
  "get_ga4_ads_links",
  "get_ga4_attribution_settings",
  "get_ga4_change_history",
  "create_key_event",
  "remove_key_event",
  "create_custom_dimension",
  "create_ga4_audience",
];

/** One valid call per tool, against the default fake state. */
const ARGS: Record<string, Record<string, unknown>> = {
  run_ga4_report: { metrics: ["sessions"] },
  run_ga4_pivot_report: { metrics: ["sessions"], pivots: [{ dimensions: ["country"], limit: 5 }] },
  run_ga4_funnel_report: { steps: [{ name: "a", event_name: "a" }, { name: "b", event_name: "b" }] },
  get_conversion_events: {},
  create_key_event: { event_name: "lead" },
  remove_key_event: { event_name: "purchase" },
  create_custom_dimension: { parameter_name: "p", display_name: "P", scope: "EVENT" },
  create_ga4_audience: { display_name: "A", description: "d", membership_duration_days: 30, include_events: ["a"] },
};

describe("GA4 tools: shared rules", () => {
  it("all 18 tools are registered with the documented scopes", () => {
    expect(ga4Tools.map((t) => t.name).sort()).toEqual([...ALL].sort());
    for (const t of ga4Tools) {
      const want = t.kind === "write" || t.name === "get_ga4_change_history" ? (t.kind === "write" ? [GA4_READONLY, GA4_EDIT] : [GA4_EDIT]) : [GA4_READONLY];
      expect(t.permissions.platformPermissions, t.name).toEqual(want);
      expect(t.platform, t.name).toBe("google_analytics");
    }
  });

  it("every Data API report request carries returnPropertyQuota: true", async () => {
    f.keyEvents = [{ name: "properties/123/keyEvents/1", eventName: "purchase", deletable: true }];
    for (const n of ALL.filter((x) => !x.startsWith("create_") && !x.startsWith("remove_"))) await kit.run(n, ARGS[n] ?? {});
    const runs = f.dataCalls().filter((c) => /:run\w*Report$/.test(c.path));
    expect(new Set(runs.map((c) => c.path.split(":")[1]))).toEqual(new Set(["runReport", "runPivotReport", "runRealtimeReport", "runFunnelReport"]));
    for (const c of runs) expect(c.body.returnPropertyQuota, c.path).toBe(true);
  });

  it("planning a write never sends a mutation", async () => {
    f.keyEvents = [{ name: "properties/123/keyEvents/1", eventName: "purchase", deletable: true }];
    for (const n of ALL.filter((x) => x.startsWith("create_") || x.startsWith("remove_"))) {
      const r = await kit.run(n, ARGS[n]!);
      expect(r.approval?.status, n).toBe("pending_approval");
    }
    expect(f.mutations()).toEqual([]);
  });

  it("write tools refuse on a read-only connection before any request", async () => {
    for (const n of ALL.filter((x) => x.startsWith("create_") || x.startsWith("remove_"))) {
      const r = await kit.run(n, { ...ARGS[n], account_id: kit.readAccountId });
      expect(r.ok, n).toBe(false);
    }
    expect(f.calls).toEqual([]);
  });

  it("429 RESOURCE_EXHAUSTED on a Data call is quota_exceeded and sent once", async () => {
    f.fail[":runReport"] = { status: 429, body: quotaError };
    const r = await kit.run("get_traffic_by_channel", {});
    expect(r.error).toMatchObject({ code: "quota_exceeded" });
    expect(f.dataCalls(":runReport")).toHaveLength(1);
  });

  it("the helpers for combined tools are exported from ga4/api", () => {
    for (const k of ["runGa4Report", "resolvePeriod", "reportPeriod", "fetchCampaignTraffic", "fetchLandingPages", "fetchGoogleAdsTraffic", "fetchChannelTraffic", "fetchKeyEventCounts", "eventCountsLast28Days", "validateFields"] as const) expect(typeof api[k], k).toBe("function");
  });
});
