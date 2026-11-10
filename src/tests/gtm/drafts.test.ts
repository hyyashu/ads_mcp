import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SERVER_WS_DESCRIPTION } from "../../platforms/gtm/client";
import { FakeGtm, type GtmHarness, gtmHarness, seedContainer } from "./support/fake-gtm";

let f: FakeGtm;
let kit: GtmHarness;
const fake = new Proxy({} as FakeGtm, { get: (_t, p) => (f as never)[p] });
beforeAll(async () => {
  f = new FakeGtm();
  kit = await gtmHarness("GTMW", fake);
});
beforeEach(() => {
  f = new FakeGtm();
  seedContainer(f);
});
const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const approve = (id: string, by = kit.second) => kit.approveAs(id, by);
const writes = () => f.writes();
const ours = () => f.addWorkspace("JackOfAds", SERVER_WS_DESCRIPTION);
const defaultWsId = () => f.workspaces.find((w) => w.ws.name === "Default Workspace")!.ws.workspaceId!;
/** No call path touches the Default Workspace except reads. */
const neverWritesDefault = () => expect(f.writes().filter((c) => c.path.includes(`/workspaces/${defaultWsId()}`))).toEqual([]);

describe("create_gtm_trigger", () => {
  it("plan is read-only; creates the JackOfAds workspace on execute, then the trigger with the documented shape", async () => {
    const r = await run("create_gtm_trigger", { name: "Checkout", type: "pageview", conditions: [{ variable: "Page Path", operator: "startsWith", value: "/checkout", negate: true }] });
    expect(r.approval).toMatchObject({ risk: "write" });
    expect(r.approval!.summary).toContain("Tag Manager workspace 'JackOfAds' will be created first");
    expect(r.approval!.summary).toContain('{{Page Path}} startsWith "/checkout" (not)');
    expect(r.approval!.summary).toContain("Draft only");
    expect(writes()).toEqual([]);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    const [mk, trig] = writes();
    expect(mk).toMatchObject({ method: "POST", path: "accounts/1/containers/2/workspaces", body: { name: "JackOfAds", description: SERVER_WS_DESCRIPTION } });
    expect(trig!.path).toBe(`accounts/1/containers/2/workspaces/${f.server()!.ws.workspaceId}/triggers`);
    expect(trig!.body).toEqual({
      name: "Checkout",
      type: "pageview",
      filter: [{ type: "startsWith", parameter: [{ type: "template", key: "arg0", value: "{{Page Path}}" }, { type: "template", key: "arg1", value: "/checkout" }, { type: "boolean", key: "negate", value: "true" }] }],
      notes: "Created by JackOfAds.",
    });
    expect(done.result).toMatchObject({ name: "Checkout", type: "pageview", workspace_created: true, similar_trigger_ids: [] });
    neverWritesDefault();
  });

  it("customEvent uses the enabled Event built-in by its listed name; refused when it is not enabled", async () => {
    ours();
    const r = await run("create_gtm_trigger", { name: "Purchase event", type: "customEvent", event_name: "purchase" });
    await approve(r.approval!.approval_id);
    expect(writes()[0]!.body).toMatchObject({ type: "customEvent", customEventFilter: [{ type: "equals", parameter: [{ key: "arg0", value: "{{Event}}" }, { key: "arg1", value: "purchase" }] }] });
    f.server()!.builtIns = f.server()!.builtIns.filter((b) => b.type !== "event");
    expect((await run("create_gtm_trigger", { name: "P2", type: "customEvent", event_name: "purchase" })).error?.message).toContain("Enable the built-in variable Event");
  });

  it("linkClick wait-for-tags fields, regex ignore_case; refusals", async () => {
    ours();
    const r = await run("create_gtm_trigger", { name: "PDF links", type: "linkClick", wait_for_tags_ms: 2000, check_validation: true, conditions: [{ variable: "Page URL", operator: "matchRegex", value: "\\.pdf$", ignore_case: true }] });
    await approve(r.approval!.approval_id);
    expect(writes()[0]!.body).toMatchObject({ waitForTags: { type: "boolean", value: "true" }, waitForTagsTimeout: { type: "template", value: "2000" }, checkValidation: { type: "boolean", value: "true" } });
    expect((writes()[0]!.body as { filter: { parameter: unknown[] }[] }).filter[0]!.parameter).toContainEqual({ type: "boolean", key: "ignore_case", value: "true" });
    const bad = async (args: Record<string, unknown>) => (await run("create_gtm_trigger", { name: "X", type: "pageview", ...args })).error;
    expect((await bad({ conditions: [{ variable: "Page URL", operator: "contains", value: "x", ignore_case: true }] }))?.code).toBe("invalid_argument");
    expect((await bad({ conditions: [{ variable: "Page URL", operator: "matchRegex", value: "(" }] }))?.message).toContain("not a valid regular expression");
    expect((await bad({ conditions: [{ variable: "Page URL", operator: "matchRegex", value: "a(?=b)" }] }))?.message).toContain("lookarounds");
    expect((await bad({ conditions: [{ variable: "No Such Var", operator: "contains", value: "x" }] }))?.message).toContain("{{No Such Var}}");
    expect((await bad({ name: "thank YOU page" }))?.message).toContain("already exists");
    expect((await bad({ wait_for_tags_ms: 100 }))?.code).toBe("invalid_argument");
    expect((await bad({ event_name: "x" }))?.code).toBe("invalid_argument");
    expect(writes()).toHaveLength(1);
  });

  it("reports a trigger with the same type and conditions", async () => {
    ours();
    const r = await run("create_gtm_trigger", { name: "Thanks 2", type: "pageview", conditions: [{ variable: "Page Path", operator: "contains", value: "/thanks" }] });
    expect(r.approval!.summary).toContain("trigger(s) 31 already have the same type");
    expect((await approve(r.approval!.approval_id)).result).toMatchObject({ similar_trigger_ids: ["31"] });
  });

  it("someone else creates a JackOfAds-named workspace between plan and execute → conflict, nothing sent", async () => {
    const r = await run("create_gtm_trigger", { name: "New", type: "domReady" });
    f.addWorkspace("JackOfAds", "hand made");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect(writes()).toEqual([]);
  });

  it("the latest version changes after the plan → the snapshot differs and nothing is sent", async () => {
    const r = await run("create_gtm_trigger", { name: "New", type: "domReady" });
    f.addVersion({ containerVersionId: "42", trigger: [{ triggerId: "77", name: "New", type: "click" }] });
    expect((await approve(r.approval!.approval_id)).status).toBe("failed");
    expect(writes()).toEqual([]);
  });

  it("an unconfirmed create is unknown_outcome; verify then reports applied; not_applied when absent", async () => {
    ours();
    const r = await run("create_gtm_trigger", { name: "Ghost", type: "windowLoaded" });
    f.failAfter.push({ re: /\/triggers$/, method: "POST" });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("unknown_outcome");
    expect(await kit.verify(done)).toEqual({ outcome: "applied" });
    const r2 = await run("create_gtm_trigger", { name: "Ghost 2", type: "windowLoaded" });
    f.dropWrites = true;
    const d2 = await approve(r2.approval!.approval_id);
    expect(d2.status).toBe("unknown_outcome");
    expect(await kit.verify(d2)).toEqual({ outcome: "not_applied" });
  });

  it("workspace limit reached: Google's refusal with guidance, definite failure", async () => {
    f.addWorkspace("A");
    f.addWorkspace("B");
    const r = await run("create_gtm_trigger", { name: "New", type: "domReady" });
    expect(r.approval!.summary).toContain("already has 3 workspaces");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect((done.result as { error: { message: string } }).error.message).toContain("Default Workspace and 2 more");
  });
});

const HTML = `<script src="https://connect.facebook.net/en_US/fbevents.js"></script><script>fbq('init', '1234567890'); document.write('x')</script>`;

describe("create_gtm_tag", () => {
  it("like_existing copies type and parameters, replaces chosen ones, and sends nothing else", async () => {
    const w = ours();
    w.tags.find((t) => t.tagId === "12")!.scheduleStartMs = "1700000000000";
    w.tags.find((t) => t.tagId === "12")!.parentFolderId = "8";
    const r = await run("create_gtm_tag", { name: "GA4 - purchase", tag: { kind: "like_existing", like_tag_id: "12", parameters: [{ key: "eventName", value: "purchase" }, { key: "sendEcommerceData", value: "true" }] }, firing_trigger_ids: ["31"], consent: { status: "needed", types: ["analytics_storage"] } });
    expect(r.approval).toMatchObject({ risk: "high_impact", change_set: { changes: [{ field: "tag", effect: "create" }, { field: "parameter.eventName", after: "purchase" }, { field: "parameter.sendEcommerceData" }] } });
    expect(r.approval!.summary).toContain('type gaawe like tag "GA4 - add_to_cart" (id 12), with eventName = "purchase" (was "add_to_cart")');
    expect(r.approval!.summary).toContain('fires on: "Thank you page" (id 31)');
    expect(writes()).toEqual([]);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    const body = writes()[0]!.body as Record<string, unknown>;
    expect(body).toEqual({
      name: "GA4 - purchase",
      type: "gaawe",
      parameter: [{ type: "template", key: "eventName", value: "purchase" }, { type: "template", key: "measurementIdOverride", value: "G-ABC1234" }, { type: "boolean", key: "sendEcommerceData", value: "true" }, { type: "list", key: "eventSettingsTable", list: [] }],
      firingTriggerId: ["31"],
      paused: false,
      consentSettings: { consentStatus: "needed", consentType: { type: "list", list: [{ type: "template", value: "analytics_storage" }] } },
      notes: "Created by JackOfAds.",
    });
    expect(done.result).toMatchObject({ name: "GA4 - purchase", type: "gaawe", workspace_created: false, next_step: expect.stringContaining("create_gtm_version") });
    neverWritesDefault();
  });

  it("custom HTML: full code and hosts in the summary, high_impact; refused in a non-web container", async () => {
    const r = await run("create_gtm_tag", { name: "Meta Pixel - v2", tag: { kind: "custom_html", html: HTML }, firing_trigger_ids: ["32"] });
    expect(r.approval!.risk).toBe("high_impact");
    expect(r.approval!.summary).toContain(HTML);
    expect(r.approval!.summary).toContain("hosts found: connect.facebook.net");
    expect(r.approval!.summary).toContain("contains <script>, document.write");
    expect(r.approval!.change_set!.changes).toContainEqual(expect.objectContaining({ field: "parameter.html", after: HTML, effect: "create" }));
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(writes().map((c) => c.path)).toEqual(["accounts/1/containers/2/workspaces", `accounts/1/containers/2/workspaces/${f.server()!.ws.workspaceId}/tags`]);
    expect(writes()[1]!.body).toMatchObject({ type: "html", parameter: [{ type: "template", key: "html", value: HTML }] });
    f.container.usageContext = ["android"];
    expect((await run("create_gtm_tag", { name: "X", tag: { kind: "custom_html", html: "<p/>" }, firing_trigger_ids: ["32"] })).error?.message).toContain("web containers");
  });

  it("refusals: html reference, unknown / list / html keys, bad boolean or integer, unknown var, built-in var ok, unknown trigger, name clash", async () => {
    ours();
    f.server()!.tags.push({ tagId: "20", name: "Num", type: "img", parameter: [{ type: "integer", key: "n", value: "1" }, { type: "template", key: "url", value: "https://x" }], firingTriggerId: ["31"] });
    const like = (parameters: unknown[], extra: Record<string, unknown> = {}, id = "12") => run("create_gtm_tag", { name: "New", tag: { kind: "like_existing", like_tag_id: id, parameters }, firing_trigger_ids: ["31"], ...extra });
    expect((await like([], {}, "14")).error?.message).toContain("use kind custom_html");
    expect((await like([{ key: "nope", value: "x" }])).error?.message).toContain("not a top-level parameter");
    expect((await like([{ key: "eventSettingsTable", value: "x" }])).error?.message).toContain("only template, boolean and integer");
    expect((await like([{ key: "html", value: "x" }])).error?.code).toBe("invalid_argument");
    expect((await like([{ key: "sendEcommerceData", value: "yes" }])).error?.message).toContain("boolean");
    expect((await like([{ key: "n", value: "1.5" }], {}, "20")).error?.message).toContain("integer");
    expect((await like([{ key: "eventName", value: "{{Nope}}" }])).error?.message).toContain("{{Nope}}");
    expect((await like([{ key: "eventName", value: "{{Page Path}} {{Order value}}" }])).approval).toBeDefined();
    expect((await like([], { firing_trigger_ids: ["2147479553"] })).error?.message).toContain("create a Page View trigger");
    expect((await like([], { name: "ga4 - ADD_TO_CART" })).error?.message).toContain("already exists");
    expect((await like([], {}, "999")).error?.code).toBe("not_found");
    expect((await like([], { blocking_trigger_ids: ["31"] })).error?.code).toBe("invalid_argument");
    expect((await run("create_gtm_tag", { name: "New", tag: { kind: "custom_html", html: "x".repeat(4001) }, firing_trigger_ids: ["31"] })).error?.code).toBe("invalid_argument");
    expect(writes()).toEqual([]);
  });

  it("drift on the reference tag → conflict, no tag sent; workspace created but base changed → conflict with the workspace reported", async () => {
    const w = ours();
    const r = await run("create_gtm_tag", { name: "New", tag: { kind: "like_existing", like_tag_id: "12", parameters: [] }, firing_trigger_ids: ["31"] });
    w.tags.find((t) => t.tagId === "12")!.parameter![0]!.value = "changed";
    expect((await approve(r.approval!.approval_id)).status).toBe("failed");
    expect(writes()).toEqual([]);

    f.workspaces = f.workspaces.filter((x) => x !== w);
    const r2 = await run("create_gtm_tag", { name: "New", tag: { kind: "like_existing", like_tag_id: "12", parameters: [] }, firing_trigger_ids: ["31"] });
    // the new workspace will not match the latest version the approval saw
    f.onRequest = (c) => {
      if (c.method === "POST" && c.path.endsWith("/workspaces")) queueMicrotask(() => (f.server()!.tags.find((t) => t.tagId === "12")!.name = "Renamed"));
    };
    const done = await approve(r2.approval!.approval_id);
    f.onRequest = undefined;
    expect(done.status).toBe("failed");
    expect((done.result as { error: { message: string } }).error.message).toContain("workspace was created");
    expect(writes().map((c) => c.path)).toEqual(["accounts/1/containers/2/workspaces"]);
  });

  it("read-back mismatch and a 500 after sending are unknown_outcome; verify applied / not_applied; duplicates dedupe", async () => {
    ours();
    const args = { name: "Pixel", tag: { kind: "custom_html", html: "<p>hi</p>" }, firing_trigger_ids: ["32"] };
    const r = await run("create_gtm_tag", args);
    expect((await run("create_gtm_tag", args)).approval!.approval_id).toBe(r.approval!.approval_id);
    f.failAfter.push({ re: /\/tags$/, method: "POST" });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("unknown_outcome");
    expect(await kit.verify(done)).toEqual({ outcome: "applied" });
    const r2 = await run("create_gtm_tag", { ...args, name: "Pixel 2" });
    f.dropWrites = true;
    const d2 = await approve(r2.approval!.approval_id);
    expect(d2.status).toBe("unknown_outcome");
    expect(await kit.verify(d2)).toEqual({ outcome: "not_applied" });
  });
});

describe("update_gtm_tag", () => {
  it("PUT carries the raw tag with only the requested fields changed and the fingerprint just read", async () => {
    const w = ours();
    const t = w.tags.find((x) => x.tagId === "12")!;
    t.monitoringMetadata = { type: "map", map: [] };
    t.someFutureField = { keep: true };
    const r = await run("update_gtm_tag", { tag_id: "12", paused: true, parameters: [{ key: "eventName", value: "begin_checkout" }] });
    expect(r.approval!.summary).toContain('parameter.eventName "add_to_cart" → "begin_checkout"');
    expect(r.approval!.change_set!.changes.map((c) => [c.field, c.effect])).toEqual([["paused", "pause"], ["parameter.eventName", "create"]]);
    const fp = t.fingerprint;
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    const put = writes()[0]!;
    expect(put).toMatchObject({ method: "PUT", path: `accounts/1/containers/2/workspaces/${w.ws.workspaceId}/tags/12`, query: { fingerprint: fp } });
    expect(put.body).toMatchObject({ name: "GA4 - add_to_cart", paused: true, monitoringMetadata: { type: "map", map: [] }, someFutureField: { keep: true }, firingTriggerId: ["31"] });
    expect((put.body as { parameter: { key: string; value?: string }[] }).parameter[0]).toEqual({ type: "template", key: "eventName", value: "begin_checkout" });
    expect(done.result).toMatchObject({ changed_fields: ["paused", "parameter.eventName"] });
  });

  it("each field alone; built-in trigger ids already on the tag are kept; no-op refused", async () => {
    ours();
    for (const args of [{ name: "GA config v2" }, { tag_firing_option: "oncePerLoad" }, { notes: "n" }, { consent: { status: "notNeeded" } }, { firing_trigger_ids: ["2147479553", "32"] }, { blocking_trigger_ids: ["31"] }]) {
      const r = await run("update_gtm_tag", { tag_id: "10", ...args });
      expect(r.approval, JSON.stringify(args)).toBeDefined();
      expect((await approve(r.approval!.approval_id)).status, JSON.stringify(args)).toBe("executed");
    }
    expect((await run("update_gtm_tag", { tag_id: "10", paused: false })).error?.message).toContain("Nothing would change");
    expect((await run("update_gtm_tag", { tag_id: "10" })).error?.code).toBe("invalid_argument");
    expect((await run("update_gtm_tag", { tag_id: "10", firing_trigger_ids: ["555"] })).error?.message).toContain("Unknown trigger");
  });

  it("html only on custom HTML tags, shown before and after; parameters cannot carry html", async () => {
    ours();
    expect((await run("update_gtm_tag", { tag_id: "12", html: "<p/>" })).error?.message).toContain("Custom HTML tag");
    expect((await run("update_gtm_tag", { tag_id: "14", parameters: [{ key: "html", value: "<p/>" }] })).error?.code).toBe("invalid_argument");
    const r = await run("update_gtm_tag", { tag_id: "14", html: "<script src='https://evil.example/x.js'></script>" });
    expect(r.approval!.risk).toBe("high_impact");
    expect(r.approval!.summary).toContain("Code before:\n<script>!function");
    expect(r.approval!.summary).toContain("evil.example");
  });

  it("no server workspace: created from the latest version, then the tag updated in it; tag only elsewhere is not_found", async () => {
    const r = await run("update_gtm_tag", { tag_id: "13", paused: true });
    expect(r.approval!.summary).toContain("will be created first");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(done.result).toMatchObject({ workspace_created: true });
    expect(writes().map((c) => c.method)).toEqual(["POST", "PUT"]);
    f.ws(defaultWsId())!.tags.push({ tagId: "300", name: "Draft elsewhere", type: "img" });
    expect((await run("update_gtm_tag", { tag_id: "300", paused: true })).error).toMatchObject({ code: "not_found", message: expect.stringContaining("another workspace") });
    neverWritesDefault();
  });

  it("drift → conflict; a 412 from Google is a definite failure, not unknown_outcome", async () => {
    const w = ours();
    const r = await run("update_gtm_tag", { tag_id: "13", notes: "drift test" });
    w.tags.find((t) => t.tagId === "13")!.name = "Changed elsewhere";
    expect((await approve(r.approval!.approval_id)).status).toBe("failed");
    const r2 = await run("update_gtm_tag", { tag_id: "13", notes: "x" });
    f.failNext.push({ re: /\/tags\/13$/, method: "PUT", status: 412, body: { error: { code: 412, status: "FAILED_PRECONDITION", message: "Fingerprint mismatch" } } });
    const done = await approve(r2.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect((done.result as { error: { code: string } }).error.code).toBe("conflict");
  });

  it("verify: applied / not_applied / indeterminate", async () => {
    const w = ours();
    const r = await run("update_gtm_tag", { tag_id: "13", paused: true, notes: "verify test" });
    f.failAfter.push({ re: /\/tags\/13$/, method: "PUT" });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("unknown_outcome");
    expect(await kit.verify(done)).toEqual({ outcome: "applied" });
    const t13 = w.tags.find((t) => t.tagId === "13")!;
    delete t13.paused; // back to exactly what was approved
    delete t13.notes;
    expect(await kit.verify(done)).toEqual({ outcome: "not_applied" });
    w.tags.find((t) => t.tagId === "13")!.name = "Other";
    expect((await kit.verify(done)).outcome).toBe("indeterminate");
  });
});
