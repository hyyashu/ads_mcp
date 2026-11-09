import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditContainer, customHtmlTags, recogniseGa4, recogniseGoogleAds, recogniseMetaPixel } from "../../platforms/gtm";
import { externalHosts, measurementIds, metaPixel } from "../../platforms/gtm/model";
import type { GtmContainerInfo, GtmTag, GtmVersion } from "../../platforms/gtm/types";
import { FakeGtm, type GtmHarness, gtmHarness, seedContainer } from "./support/fake-gtm";

const NOW = new Date("2026-11-10T12:00:00Z");
const web: GtmContainerInfo = { publicId: "GTM-ABC123", usageContext: ["web"], tagIds: ["GTM-ABC123"] };
const T = (x: Partial<GtmTag>): GtmTag => ({ tagId: x.tagId ?? "1", name: x.name ?? `tag ${x.tagId ?? "1"}`, type: "img", firingTriggerId: ["31"], ...x });
const base = (tags: GtmTag[], extra: Partial<GtmVersion> = {}): GtmVersion => ({ containerVersionId: "5", tag: tags, trigger: [{ triggerId: "31", name: "Thanks" }], ...extra });
const audit = (v: GtmVersion | null, c = web) => auditContainer({ container: c, live: v, checked_at: NOW.toISOString() }, NOW);
const rules = (v: GtmVersion | null, c = web) => audit(v, c).findings.map((f) => f.rule);
const GA = T({ tagId: "90", name: "GA", type: "googtag", parameter: [{ type: "template", key: "tagId", value: "G-ZZZ9999" }] });

describe("recognisers", () => {
  it("Meta pixel base code with single or double quotes, events, ids", () => {
    expect(metaPixel(`<script src="https://connect.facebook.net/en_US/fbevents.js"></script><script>fbq("init", "555666777");fbq("track","Purchase")</script>`)).toEqual({ base: true, events: true, pixelIds: ["555666777"] });
    expect(metaPixel(`fbq('track', 'Lead');`)).toEqual({ base: false, events: true, pixelIds: [] });
    expect(metaPixel(`<div>nothing</div>`)).toEqual({ base: false, events: false, pixelIds: [] });
  });
  it("Measurement IDs in nested lists and maps and gtag configs; not GTM- ids", () => {
    expect(measurementIds([{ list: [{ map: [{ value: "x G-NESTED12 y" }] }] }, "GTM-ABCDEF"])).toEqual(["G-NESTED12"]);
    expect(recogniseGa4(base([]), { tagIds: ["G-FROMTAG1"] }).measurement_ids).toEqual(["G-FROMTAG1"]);
    expect(recogniseGa4(base([], { gtagConfig: [{ type: "googtag", parameter: [{ key: "tagId", value: "G-GTAGCFG1" }] }] }), {}).measurement_ids).toEqual(["G-GTAGCFG1"]);
  });
  it("external hosts in custom HTML", () => {
    expect(externalHosts(`<script src="//cdn.example.com/a.js"></script><img src='https://px.ads.example/t?x=1'> http://Track.Example.org/`)).toEqual(["cdn.example.com", "px.ads.example", "track.example.org"]);
  });
  it("Google Ads tags and ids; custom HTML inventory", () => {
    const v = base([T({ tagId: "1", type: "awct", parameter: [{ type: "template", key: "googleConversionId", value: "123" }, { type: "template", key: "googleConversionLabel", value: "L" }] }), T({ tagId: "2", type: "sp" }), T({ tagId: "3", type: "html", parameter: [{ type: "template", key: "html", value: "<script src='https://x.example/a.js'></script> AW-4455" }] })]);
    expect(recogniseGoogleAds(v)).toMatchObject({ conversion_tags: [{ tag_id: "1", conversion_id: "123", conversion_label: "L", paused: false }], remarketing_tags: [{ tag_id: "2" }], conversion_ids: ["AW-4455"] });
    expect(customHtmlTags(v)).toEqual([{ tag_id: "3", name: "tag 3", paused: false, external_hosts: ["x.example"] }]);
    expect(recogniseMetaPixel(v)).toEqual([]);
  });
});

describe("audit rules", () => {
  it("no_live_version / no_tags", () => {
    expect(rules(null)).toEqual(["no_live_version"]);
    expect(rules(base([]))).toContain("no_tags");
    expect(rules(base([GA]))).not.toContain("no_tags");
  });
  it("tag_never_fires, except setup / teardown tags", () => {
    expect(audit(base([GA, T({ tagId: "2", firingTriggerId: [] })])).findings.find((f) => f.rule === "tag_never_fires")?.entities).toEqual([{ kind: "tag", id: "2", name: "tag 2" }]);
    expect(rules(base([GA, T({ tagId: "2", name: "Setup", firingTriggerId: [] }), T({ tagId: "3", setupTag: [{ tagName: "Setup" }] })]))).not.toContain("tag_never_fires");
  });
  it("tag_blocks_itself", () => {
    expect(rules(base([GA, T({ tagId: "2", blockingTriggerId: ["31"] })]))).toContain("tag_blocks_itself");
    expect(rules(base([GA, T({ tagId: "2", blockingTriggerId: ["32"] })]))).not.toContain("tag_blocks_itself");
  });
  it("paused_tags, schedule_ended, schedule_not_started, live_only_tags", () => {
    const r = rules(base([GA, T({ tagId: "2", paused: true }), T({ tagId: "3", scheduleEndMs: String(NOW.getTime() - 1) }), T({ tagId: "4", scheduleStartMs: String(NOW.getTime() + 1000) }), T({ tagId: "5", liveOnly: true })]));
    expect(r).toEqual(expect.arrayContaining(["paused_tags", "schedule_ended", "schedule_not_started", "live_only_tags"]));
    expect(rules(base([GA, T({ tagId: "3", scheduleEndMs: String(NOW.getTime() + 1) })]))).not.toEqual(expect.arrayContaining(["paused_tags", "schedule_ended", "schedule_not_started", "live_only_tags"]));
  });
  it("duplicate_tags ignores paused copies", () => {
    const p = [{ type: "template", key: "url", value: "https://x" }];
    expect(rules(base([GA, T({ tagId: "2", parameter: p }), T({ tagId: "3", parameter: p })]))).toContain("duplicate_tags");
    expect(rules(base([GA, T({ tagId: "2", parameter: p }), T({ tagId: "3", parameter: p, paused: true })]))).not.toContain("duplicate_tags");
    expect(rules(base([GA, T({ tagId: "2", parameter: p }), T({ tagId: "3", parameter: p, firingTriggerId: ["32"] })]))).not.toContain("duplicate_tags");
  });
  it("trigger_ref_unknown (info) and unused_triggers", () => {
    const f = audit(base([T({ tagId: "2", firingTriggerId: ["2147479553"] }), GA], { trigger: [{ triggerId: "31", name: "Thanks" }, { triggerId: "40", name: "Unused" }] })).findings;
    expect(f.find((x) => x.rule === "trigger_ref_unknown")?.severity).toBe("info");
    expect(f.find((x) => x.rule === "unused_triggers")?.entities).toEqual([{ kind: "trigger", id: "40", name: "Unused" }]);
    expect(rules(base([GA]))).not.toContain("unused_triggers");
  });
  it("consent_needed_without_types", () => {
    expect(rules(base([GA, T({ tagId: "2", consentSettings: { consentStatus: "needed" } })]))).toContain("consent_needed_without_types");
    expect(rules(base([GA, T({ tagId: "2", consentSettings: { consentStatus: "needed", consentType: { type: "list", list: [{ type: "template", value: "ad_storage" }] } } })]))).not.toContain("consent_needed_without_types");
  });
  it("GA4: none, one, several", () => {
    expect(rules(base([T({ tagId: "2" })]), { usageContext: ["web"] })).toContain("no_ga4_measurement_id");
    expect(rules(base([GA]))).not.toContain("no_ga4_measurement_id");
    expect(rules(base([GA, T({ tagId: "3", parameter: [{ type: "template", key: "m", value: "G-OTHER123" }] })]))).toContain("ga4_multiple_ids");
  });
  it("Google Ads conversion: missing, all paused, present; remarketing info", () => {
    expect(rules(base([GA]))).toEqual(expect.arrayContaining(["no_google_ads_conversion_tag", "no_google_ads_remarketing"]));
    expect(rules(base([GA, T({ tagId: "2", type: "awct", paused: true })]))).toContain("google_ads_conversion_paused");
    const ok = rules(base([GA, T({ tagId: "2", type: "awct" }), T({ tagId: "3", type: "sp", firingTriggerId: ["32"] })]));
    expect(ok).not.toEqual(expect.arrayContaining(["no_google_ads_conversion_tag"]));
    expect(ok).not.toContain("google_ads_conversion_paused");
    expect(ok).not.toContain("no_google_ads_remarketing");
    expect(rules(base([GA, T({ tagId: "2", type: "html", parameter: [{ type: "template", key: "html", value: "gtag('config','AW-123')" }] })]))).not.toContain("no_google_ads_conversion_tag");
  });
  it("Meta pixel: present, absent, events without base, duplicated base, several ids", () => {
    const h = (id: string, html: string, x: Partial<GtmTag> = {}) => T({ tagId: id, type: "html", parameter: [{ type: "template", key: "html", value: html }], ...x });
    const baseCode = (pid: string, q = "'") => `<script src="https://connect.facebook.net/en_US/fbevents.js"></script><script>fbq(${q}init${q}, ${q}${pid}${q});</script>`;
    expect(rules(base([GA]))).toContain("no_meta_pixel");
    expect(rules(base([GA, h("2", baseCode("1234567"))]))).toContain("meta_pixel_present");
    expect(rules(base([GA, h("2", "fbq('track', 'Purchase')")]))).toContain("meta_pixel_event_without_base");
    expect(rules(base([GA, h("2", baseCode("1234567")), h("3", "fbq('track', 'Purchase')")]))).not.toContain("meta_pixel_event_without_base");
    expect(rules(base([GA, h("2", baseCode("1234567")), h("3", baseCode("1234567", '"'), { firingTriggerId: ["32"] })]))).toContain("meta_pixel_base_duplicated");
    expect(rules(base([GA, h("2", baseCode("1234567")), h("3", baseCode("1234567"), { paused: true })]))).not.toContain("meta_pixel_base_duplicated");
    expect(rules(base([GA, h("2", baseCode("1234567")), h("3", baseCode("7654321"), { firingTriggerId: ["32"] })]))).toContain("meta_pixel_multiple_ids");
    expect(rules(base([GA, h("2", baseCode("1234567"))]))).toContain("custom_html_inventory");
  });
  it("a non-web container skips the web rules", () => {
    const r = rules(base([T({ tagId: "2" })]), { usageContext: ["android"] });
    expect(r).toContain("non_web_container");
    expect(r).not.toContain("no_ga4_measurement_id");
    expect(r).not.toContain("no_meta_pixel");
  });
  it("findings sort by severity; include_info false hides info; more than 5,000 tags is refused", () => {
    const res = audit(base([GA, T({ tagId: "2", paused: true }), T({ tagId: "3", firingTriggerId: [] })]));
    expect(res.findings.map((x) => x.severity)).toEqual([...res.findings.map((x) => x.severity)].sort((a, b) => ["high", "medium", "info"].indexOf(a) - ["high", "medium", "info"].indexOf(b)));
    expect(res.findings[0]!.severity).toBe("high");
    expect(auditContainer({ container: web, live: base([GA]), checked_at: "x" }, NOW, { includeInfo: false }).findings.every((f) => f.severity !== "info")).toBe(true);
    expect(() => audit(base(Array.from({ length: 5001 }, (_, i) => T({ tagId: String(i) }))))).toThrow(/5000/);
  });
});

describe("audit_gtm_container tool", () => {
  let f: FakeGtm;
  let kit: GtmHarness;
  const fake = new Proxy({} as FakeGtm, { get: (_t, p) => (f as never)[p] });
  beforeAll(async () => {
    f = new FakeGtm();
    kit = await gtmHarness("GTMA", fake);
  });
  beforeEach(() => {
    f = new FakeGtm();
    seedContainer(f);
  });

  it("audits the live version with 2 requests and recognises the seeded tags", async () => {
    const r = await kit.run("audit_gtm_container", {});
    expect(r.ok).toBe(true);
    expect(f.calls.map((c) => c.path)).toEqual(["accounts/1/containers/2", "accounts/1/containers/2/versions:live"]);
    expect(r.data.recognised).toMatchObject({ ga4_measurement_ids: ["G-ABC1234"], google_ads_conversion_tags: [{ tag_id: "13", conversion_id: "987654" }], meta_pixel: [{ tag_id: "14", pixel_ids: ["1234567890"], has_base_code: true }], custom_html_tags: [{ tag_id: "14", external_hosts: ["connect.facebook.net"] }] });
    expect(r.data.tag_type_counts).toContainEqual({ type: "awct", label: "Google Ads Conversion Tracking", count: 1 });
    expect(r.data.limits.join(" ")).toContain("Measurement IDs");
    expect(r.data.findings.map((x: { rule: string }) => x.rule)).toContain("trigger_ref_unknown");
  });

  it("never published → no_live_version", async () => {
    f.liveId = null;
    const r = await kit.run("audit_gtm_container", {});
    expect(r.data.findings.map((x: { rule: string }) => x.rule)).toEqual(["no_live_version"]);
  });
});
