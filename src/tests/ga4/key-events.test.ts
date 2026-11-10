import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteTool } from "../../mcp/tool";
import { type FakeGa4, type Ga4Harness, fakeGa4, ga4Harness, reportOf } from "./fake-ga4";

let f: FakeGa4;
let kit: Ga4Harness;
const NOW = new Date("2026-11-10T11:30:00Z");

beforeAll(async () => {
  f = fakeGa4();
  kit = await ga4Harness("G4K", f);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  f.reset();
  f.keyEvents = [{ name: "properties/123/keyEvents/1", eventName: "purchase", countingMethod: "ONCE_PER_EVENT", deletable: true, custom: false, createTime: "2025-01-01T00:00:00Z" }];
  f.adsLinks = [{ name: "properties/123/googleAdsLinks/1", customerId: "1234567890" }, { name: "properties/123/googleAdsLinks/2", customerId: "2234567890" }];
});
const counts = (rows: [string, string, string][]) => () => reportOf(["eventName"], ["eventCount", "keyEvents"], rows.map(([n, e, k]) => [[n], [e, k]]));
const tool = (n: string) => kit.deps.registry.get(n) as WriteTool;

describe("create_key_event", () => {
  it("plans without sending anything: summary names the 28-day count and linked Ads accounts; high impact", async () => {
    f.report = counts([["sign_up", "1234", "0"]]);
    const r = await kit.run("create_key_event", { event_name: "sign_up", default_value: { value: 10, currency_code: "EUR" } });
    expect(r.approval).toMatchObject({ risk: "high_impact", change_set: { changes: [{ resource: "key_event", field: "key_event", before: null, after: "sign_up", effect: "create" }] } });
    expect(r.approval!.summary).toBe(
      'Mark event "sign_up" as a key event (counted once per event, default value 10 EUR). It was recorded 1,234 times in the last 28 days. Key events count from now on, not retroactively. 2 Google Ads accounts are linked to this property: if they import GA4 key events, this can change what Smart Bidding optimises for.',
    );
    expect(f.dataCalls(":runReport")[0]!.body).toMatchObject({ dateRanges: [{ startDate: "2026-10-13", endDate: "2026-11-09" }], dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: ["sign_up"] } } } });
    expect(f.mutations()).toHaveLength(0);
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(done.result).toMatchObject({ event_name: "sign_up", counting_method: "ONCE_PER_EVENT", default_value: { value: 10, currency_code: "EUR" }, created: true });
    const post = f.mutations();
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({ method: "POST", path: "/v1beta/properties/123/keyEvents", body: { eventName: "sign_up", countingMethod: "ONCE_PER_EVENT", defaultValue: { numericValue: 10, currencyCode: "EUR" } } });
  });

  it("an event never seen says it will count nothing; no Ads link, no Ads sentence", async () => {
    f.adsLinks = [];
    const r = await kit.run("create_key_event", { event_name: "lead", counting_method: "ONCE_PER_SESSION" });
    expect(r.approval!.summary).toBe('Mark event "lead" as a key event (counted once per session). It was not recorded in the last 28 days: it will count nothing until the site sends it. Key events count from now on, not retroactively.');
  });

  it("refuses a duplicate, and the 30-key-event limit only on Standard properties", async () => {
    expect((await kit.run("create_key_event", { event_name: "purchase" })).error!.message).toContain("already a key event (id 1)");
    f.keyEvents = Array.from({ length: 30 }, (_, i) => ({ name: `properties/123/keyEvents/${i + 10}`, eventName: `e${i}` }));
    expect((await kit.run("create_key_event", { event_name: "lead" })).error!.message).toContain("already has 30 key events");
    f.property.serviceLevel = "GOOGLE_ANALYTICS_360";
    expect((await kit.run("create_key_event", { event_name: "lead" })).ok).toBe(true);
    expect(f.mutations()).toHaveLength(0);
  });

  it("drift between plan and approval is a conflict and nothing is sent", async () => {
    const r = await kit.run("create_key_event", { event_name: "lead" });
    f.keyEvents.push({ name: "properties/123/keyEvents/77", eventName: "other" });
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("failed");
    expect(f.mutations()).toHaveLength(0);
  });

  it("a create that does not read back is unknown_outcome; verify tells the three outcomes", async () => {
    const r = await kit.run("create_key_event", { event_name: "lead" });
    f.dropWrites = true;
    expect((await kit.approveAs(r.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");
    expect(f.mutations()).toHaveLength(1);
    const snap = { key_events: ["purchase"] };
    const args = { account_id: kit.accountId, event_name: "lead", counting_method: "ONCE_PER_EVENT" };
    expect(await tool("create_key_event").verify(args, await kit.ctx(), { snapshot: snap })).toEqual({ outcome: "not_applied" });
    f.keyEvents.push({ name: "properties/123/keyEvents/5", eventName: "lead" });
    expect(await tool("create_key_event").verify(args, await kit.ctx(), { snapshot: snap })).toEqual({ outcome: "applied" });
    f.keyEvents = [{ name: "properties/123/keyEvents/6", eventName: "x" }];
    expect((await tool("create_key_event").verify(args, await kit.ctx(), { snapshot: snap })).outcome).toBe("indeterminate");
  });

  it("refuses on a read-only connection (pipeline), before planning", async () => {
    const r = await kit.run("create_key_event", { account_id: kit.readAccountId, event_name: "lead" });
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});

describe("remove_key_event", () => {
  it("destructive: summary with 28-day key events and Ads consequence, DELETE once, read back", async () => {
    f.report = counts([["purchase", "600", "512"]]);
    f.adsLinks = f.adsLinks.slice(0, 1);
    const r = await kit.run("remove_key_event", { event_name: "purchase" });
    expect(r.approval).toMatchObject({ risk: "destructive", change_set: { changes: [{ before: "purchase", after: null, effect: "remove" }] } });
    expect(r.approval!.summary).toBe(
      'Stop counting "purchase" as a key event. It recorded 512 key events in the last 28 days. From now on GA4 will not count it as a key event (reports from before stay). 1 Google Ads account is linked: any conversion it imports from this key event will stop receiving data. This cannot be undone through the API; create_key_event can re-mark it, but the gap is not back-filled.',
    );
    const done = await kit.approveAs(r.approval!.approval_id, kit.second);
    expect(done).toMatchObject({ status: "executed", result: { removed: true, event_name: "purchase", key_event_id: "1" } });
    expect(f.mutations()).toEqual([expect.objectContaining({ method: "DELETE", path: "/v1beta/properties/123/keyEvents/1" })]);
    expect(f.keyEvents).toHaveLength(0);
  });

  it("not found lists the key events; not deletable is refused", async () => {
    const nf = await kit.run("remove_key_event", { event_name: "lead" });
    expect(nf.error).toMatchObject({ code: "not_found" });
    expect(nf.error!.message).toContain("Key events: purchase");
    f.keyEvents[0]!.deletable = false;
    expect((await kit.run("remove_key_event", { event_name: "purchase" })).error!.message).toContain("not deletable");
  });

  it("a counting-method change after planning is a conflict; a delete that does not read back is unknown_outcome; verify", async () => {
    f.keyEvents = [{ name: "properties/123/keyEvents/2", eventName: "generate_lead", countingMethod: "ONCE_PER_EVENT", deletable: true, createTime: "2025-01-01T00:00:00Z" }];
    const r = await kit.run("remove_key_event", { event_name: "generate_lead" });
    f.keyEvents[0]!.countingMethod = "ONCE_PER_SESSION";
    expect((await kit.approveAs(r.approval!.approval_id, kit.second)).status).toBe("failed");
    expect(f.mutations()).toHaveLength(0);

    const r2 = await kit.run("remove_key_event", { event_name: "generate_lead" });
    expect(r2.error).toBeUndefined();
    f.dropWrites = true;
    expect((await kit.approveAs(r2.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");
    expect(f.mutations()).toHaveLength(1);
    const snap = { name: "properties/123/keyEvents/2", event_name: "generate_lead", counting_method: "ONCE_PER_SESSION", default_value: null, create_time: "2025-01-01T00:00:00Z" };
    const args = { account_id: kit.accountId, event_name: "generate_lead" };
    expect(await tool("remove_key_event").verify(args, await kit.ctx(), { snapshot: snap })).toEqual({ outcome: "not_applied" });
    f.keyEvents[0]!.countingMethod = "ONCE_PER_EVENT";
    expect((await tool("remove_key_event").verify(args, await kit.ctx(), { snapshot: snap })).outcome).toBe("indeterminate");
    f.keyEvents = [];
    expect(await tool("remove_key_event").verify(args, await kit.ctx(), { snapshot: snap })).toEqual({ outcome: "applied" });
  });

  it("a key event name of another property can never be deleted through the client", async () => {
    const { services } = (await kit.ctx()) as unknown as { services: { ga4: import("../../platforms/ga4/client").Ga4Client } };
    await expect(services.ga4.deleteKeyEvent("properties/999/keyEvents/1")).rejects.toMatchObject({ code: "invalid_argument" });
    expect(f.mutations()).toHaveLength(0);
  });
});
