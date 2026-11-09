import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GA4_EDIT } from "../../platforms/gapi/scopes";
import { type FakeGa4, type Ga4Harness, fakeGa4, ga4Harness } from "./fake-ga4";

let f: FakeGa4;
let kit: Ga4Harness;
const NOW = new Date("2026-11-10T11:30:00Z");

beforeAll(async () => {
  f = fakeGa4();
  kit = await ga4Harness("G4A", f);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => f.reset());

describe("get_ga4_ads_links", () => {
  it("formats customer ids, drops the creator email, notes an empty list", async () => {
    f.adsLinks = [{ name: "properties/123/googleAdsLinks/55", customerId: "1234567890", canManageClients: false, adsPersonalizationEnabled: true, createTime: "2025-01-01T00:00:00Z", updateTime: "2025-02-01T00:00:00Z", creatorEmailAddress: "someone@example.com" }];
    const r = await kit.run("get_ga4_ads_links", {});
    expect(r.data).toEqual({ property: "properties/123", links: [{ link_id: "55", customer_id: "123-456-7890", can_manage_clients: false, ads_personalization_enabled: true, create_time: "2025-01-01T00:00:00Z", update_time: "2025-02-01T00:00:00Z" }], returned: 1, note: null });
    expect(JSON.stringify(r.data)).not.toContain("someone@example.com");
    f.adsLinks = [];
    expect((await kit.run("get_ga4_ads_links", {})).data).toMatchObject({ links: [], note: expect.stringContaining("No Google Ads accounts are linked") });
  });
});

describe("get_ga4_attribution_settings (v1alpha)", () => {
  it("maps each documented enum to days and plain words, from the v1alpha URL", async () => {
    f.attribution = {
      name: "properties/123/attributionSettings",
      acquisitionConversionEventLookbackWindow: "ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_7_DAYS",
      otherConversionEventLookbackWindow: "OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_90_DAYS",
      reportingAttributionModel: "PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN",
      adsWebConversionDataExportScope: "GOOGLE_PAID_CHANNELS",
    };
    const r = await kit.run("get_ga4_attribution_settings", {});
    expect(r.data).toMatchObject({ api_version: "v1alpha", reporting_attribution_model: "PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN", acquisition_lookback_days: 7, other_conversion_lookback_days: 90, ads_web_conversion_data_export_scope: "GOOGLE_PAID_CHANNELS" });
    expect((r.data as any).explanation[0]).toBe("Key events are credited by data-driven attribution across paid and organic channels, looking back 90 days.");
    expect(f.calls.at(-1)!.path).toBe("/v1alpha/properties/123/attributionSettings");
    for (const [w, d] of [["OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS", 30], ["OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_60_DAYS", 60]] as const) {
      f.attribution = { otherConversionEventLookbackWindow: w, acquisitionConversionEventLookbackWindow: "ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS", reportingAttributionModel: "GOOGLE_PAID_CHANNELS_LAST_CLICK" };
      expect((await kit.run("get_ga4_attribution_settings", {})).data).toMatchObject({ other_conversion_lookback_days: d, acquisition_lookback_days: 30 });
    }
  });

  it("an unknown value passes through raw with null days", async () => {
    f.attribution = { otherConversionEventLookbackWindow: "OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_120_DAYS", reportingAttributionModel: "SOMETHING_NEW" };
    const r = await kit.run("get_ga4_attribution_settings", {});
    expect(r.data).toMatchObject({ reporting_attribution_model: "SOMETHING_NEW", other_conversion_lookback_days: null, raw: { other_conversion_lookback_window: "OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_120_DAYS" } });
    expect((r.data as any).explanation[0]).toBe("Reporting attribution model: SOMETHING_NEW.");
  });
});

describe("get_ga4_change_history", () => {
  it("declares the edit scope and refuses on a read-only connection without calling Google", async () => {
    expect(kit.deps.registry.get("get_ga4_change_history")!.permissions.platformPermissions).toEqual([GA4_EDIT]);
    const r = await kit.run("get_ga4_change_history", { account_id: kit.readAccountId });
    expect(r.error).toMatchObject({ code: "platform_permission_denied" });
    expect(r.error!.message).toContain("Reconnect Google Analytics with changes allowed");
    expect(f.calls).toHaveLength(0);
  });

  it("queries the property's account, extracts resource kinds, cuts long values, reports truncation", async () => {
    const big = "x".repeat(1500);
    f.history = () => ({
      changeHistoryEvents: [
        {
          id: "e1",
          changeTime: "2026-11-09T08:00:00Z",
          actorType: "USER",
          userActorEmail: "admin@shop.example",
          changesFiltered: false,
          changes: [
            { resource: "properties/123/customDimensions/4", action: "CREATED", resourceAfterChange: { customDimension: { parameterName: "plan_type", displayName: "Plan" } } },
            { resource: "properties/123/conversionEvents/9", action: "DELETED", resourceBeforeChange: { conversionEvent: { eventName: big } } },
          ],
        },
      ],
      nextPageToken: "more",
    });
    const r = await kit.run("get_ga4_change_history", { days: 7, resource_types: ["CUSTOM_DIMENSION", "CONVERSION_EVENT"], actions: ["CREATED", "DELETED"], limit: 1 });
    expect(r.ok).toBe(true);
    const c = f.calls.find((x) => x.path.endsWith(":searchChangeHistoryEvents"))!;
    expect(c.path).toBe("/v1beta/accounts/77:searchChangeHistoryEvents");
    expect(c.body).toEqual({ property: "properties/123", earliestChangeTime: "2026-11-03T11:30:00.000Z", resourceType: ["CUSTOM_DIMENSION", "CONVERSION_EVENT"], action: ["CREATED", "DELETED"], pageSize: 1 });
    const d = r.data as any;
    expect(d).toMatchObject({ account: "accounts/77", returned: 1, truncated: true, events: [{ id: "e1", actor_type: "USER", actor_email: "admin@shop.example" }] });
    expect(d.events[0].changes[0]).toEqual({ resource: "properties/123/customDimensions/4", action: "CREATED", resource_kind: "customDimension", before: null, after: '{"parameterName":"plan_type","displayName":"Plan"}' });
    expect(d.events[0].changes[1]).toMatchObject({ resource_kind: "conversionEvent", after: null });
    expect(d.events[0].changes[1].before).toHaveLength(1001);
  });

  it("a property without a readable account is unsupported", async () => {
    f.property = { ...f.property, account: undefined, parent: "properties/1" };
    expect((await kit.run("get_ga4_change_history", {})).error).toMatchObject({ code: "unsupported" });
  });
});
