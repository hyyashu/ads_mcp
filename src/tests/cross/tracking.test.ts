import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema } from "../../db";
import { snippetTargets } from "../../platforms/cross/tracking";
import { ga4Answer } from "./ga4-fixture";
import { type CrossHarness, crossHarness } from "./harness";

const snippet = (sendTo: string) => [{ type: "WEBPAGE", pageFormat: "HTML", eventSnippet: `<script>gtag('event', 'conversion', {'send_to': '${sendTo}'});</script>` }];

describe("audit_tracking_setup", () => {
  let h: CrossHarness;
  beforeAll(async () => {
    h = await crossHarness("XT");
    h.ga4.streams = [
      { name: "properties/123/dataStreams/1", type: "WEB_DATA_STREAM", displayName: "Web", webStreamData: { measurementId: "G-ABC1234" } },
      { name: "properties/123/dataStreams/2", type: "WEB_DATA_STREAM", displayName: "New site", webStreamData: { measurementId: "G-NEW9999" } },
    ];
    h.ga4.keyEvents = [
      { name: "properties/123/keyEvents/1", eventName: "add_to_cart", createTime: "2024-01-01T00:00:00Z", countingMethod: "ONCE_PER_EVENT" },
      { name: "properties/123/keyEvents/2", eventName: "purchase", createTime: "2024-01-01T00:00:00Z", countingMethod: "ONCE_PER_EVENT" },
    ];
    h.ga4.report = ga4Answer({ eventName: { rows: [{ dims: ["add_to_cart"], m: { eventCount: 100, keyEvents: 100 } }] } });
    h.google.search.customer = [{ customer: { conversionTrackingSetting: { conversionTrackingId: "987654" } } }];
    h.google.search.conversion_action = [
      { conversionAction: { id: "1", name: "Purchase", type: "WEBPAGE", tagSnippets: snippet("AW-987654/abcDEF") } },
      { conversionAction: { id: "2", name: "Lead", type: "WEBPAGE", tagSnippets: snippet("AW-987654/zzzLead") } },
      { conversionAction: { id: "3", name: "Offline", type: "UPLOAD_CLICKS" } },
    ];
    h.meta.pixels = [{ id: "1234567890", name: "Main", last_fired_time: "2026-11-08T10:00:00+0000" }, { id: "555", name: "Old" }];
  });

  it("reads send_to pairs from event snippets", () => {
    expect(snippetTargets(snippet("AW-1/a-b_C"))).toEqual([{ id: "1", label: "a-b_C" }]);
    expect(snippetTargets(undefined)).toEqual([]);
  });

  it("lists each conversion with where it is defined and where it is missing", async () => {
    const env = await h.run("audit_tracking_setup", { account_id: h.ids.gtm });
    expect(env.error).toBeUndefined();
    const d = env.data;
    const by = (kind: string, id: string) => d.conversions.find((c: { kind: string; id: string }) => c.kind === kind && c.id === id);
    expect(by("ga4_measurement_id", "G-ABC1234")).toMatchObject({ status: "ok", defined_in: ["google_analytics", "google_tag_manager"] });
    expect(by("ga4_measurement_id", "G-NEW9999")).toMatchObject({ status: "gap", missing_in: ["google_tag_manager"] });
    expect(by("ga4_key_event", "add_to_cart")).toMatchObject({ status: "ok", defined_in: ["google_analytics", "google_tag_manager"] });
    expect(by("ga4_key_event", "add_to_cart").details.join(" ")).toContain("GA4 - add_to_cart");
    const purchase = by("ga4_key_event", "purchase");
    expect(purchase).toMatchObject({ status: "gap", missing_in: ["google_tag_manager"] });
    expect(purchase.details.join(" ")).toContain("No events named purchase");
    expect(by("google_ads_conversion_action", "1")).toMatchObject({ status: "ok", name: "Purchase" });
    expect(by("google_ads_conversion_action", "2")).toMatchObject({ status: "gap", missing_in: ["google_tag_manager"] });
    expect(by("google_ads_conversion_action", "3")).toMatchObject({ status: "not_applicable" });
    expect(by("meta_pixel", "1234567890")).toMatchObject({ status: "ok", defined_in: ["meta_ads", "google_tag_manager"] });
    expect(by("meta_pixel", "555")).toMatchObject({ status: "gap", missing_in: ["google_tag_manager"] });
    expect(d.summary).toEqual({ checked: 8, ok: 4, gaps: 4 });
    expect(d.conversions[0].status).toBe("gap");
    expect(d.container).toMatchObject({ public_id: "GTM-ABC123", live_version_id: "41" });
    expect(d.coverage.not_checked).toEqual([]);
    expect(h.google.queries.some((q) => q.includes("conversion_action.tag_snippets"))).toBe(true);
  });

  it("flags a container tag that matches no conversion action of the account", async () => {
    h.google.search.conversion_action = [{ conversionAction: { id: "2", name: "Lead", type: "WEBPAGE", tagSnippets: snippet("AW-987654/zzzLead") } }];
    const d = (await h.run("audit_tracking_setup", { account_id: h.ids.gtm })).data;
    const orphan = d.conversions.find((c: { kind: string }) => c.kind === "gtm_google_ads_tag");
    expect(orphan).toMatchObject({ id: "13", name: "Ads purchase", status: "gap", missing_in: ["google_ads"] });
  });

  it("an explicit id of another workspace is not_found; unlinked sources are listed as not checked", async () => {
    expect((await h.run("audit_tracking_setup", { account_id: h.ids.gtm, property_account_id: h.ids.foreignProp })).error).toMatchObject({ code: "not_found" });
    await h.db.delete(schema.accountLink).where(eq(schema.accountLink.tenantId, h.tenantId));
    const d = (await h.run("audit_tracking_setup", { account_id: h.ids.gtm })).data;
    expect(d.coverage.not_checked.map((x: { source: string }) => x.source)).toEqual(["google_analytics", "google_ads", "meta_ads"]);
    expect(d.conversions).toEqual([]);
  });
});
