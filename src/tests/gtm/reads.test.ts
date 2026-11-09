import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "../../mcp/errors";
import { GoogleApiHttp } from "../../platforms/gapi/http";
import { GtmClient, SERVER_WS_DESCRIPTION, gtmIdOrFail } from "../../platforms/gtm/client";
import { RateLimiter } from "../../security/rate-limit";
import { C, FakeGtm, type GtmHarness, gtmHarness, seedContainer } from "./support/fake-gtm";

let f: FakeGtm;
let kit: GtmHarness;
const fake = new Proxy({} as FakeGtm, { get: (_t, p) => (f as never)[p] });
beforeAll(async () => {
  f = new FakeGtm();
  kit = await gtmHarness("GTMR", fake);
});
beforeEach(() => {
  f = new FakeGtm();
  seedContainer(f);
});
const run = (name: string, args: Record<string, unknown> = {}) => kit.run(name, args);
const client = () => new GtmClient({ http: new GoogleApiHttp({ fetch: (u, i) => f.fetch(u, i), sleep: async () => {} }), getAccessToken: async () => "t", containerPath: C });

describe("GtmClient basics", () => {
  it("ids must be digits before reaching a URL", () => {
    for (const bad of ["../1", "1/../2", "abc", "", "1".repeat(21)]) expect(() => gtmIdOrFail(bad, "tag")).toThrow(ToolError);
    expect(() => client().workspaceUrl("../../x")).toThrow(/digits/);
  });

  it("findServerWorkspace: none, ours, a foreign one, several", async () => {
    expect(await client().findServerWorkspace()).toBeNull();
    f.addWorkspace("JackOfAds", SERVER_WS_DESCRIPTION);
    expect((await client().findServerWorkspace())?.name).toBe("JackOfAds");
    f.addWorkspace("JackOfAds", SERVER_WS_DESCRIPTION);
    await expect(client().findServerWorkspace()).rejects.toMatchObject({ code: "conflict" });
    f.workspaces.pop();
    f.workspaces.at(-1)!.ws.description = "someone else's";
    await expect(client().findServerWorkspace()).rejects.toMatchObject({ code: "conflict" });
  });

  it("a never-published container has no live version; Google's 403 quota is quota_exceeded", async () => {
    f.liveId = null;
    expect(await client().liveVersion()).toBeNull();
    f.failNext.push({ re: /versions:live/, status: 403, body: { error: { code: 403, message: "Quota exceeded", errors: [{ reason: "rateLimitExceeded" }] } } });
    await expect(client().liveVersion()).rejects.toMatchObject({ code: "quota_exceeded" });
  });

  it("the server-wide Tag Manager limiter refuses before anything is sent", async () => {
    const limited = await gtmHarness("GTMLIM", fake, { gtmLimiter: new RateLimiter(1, 0.0001) });
    expect((await limited.run("get_gtm_live_version", {})).ok).toBe(true);
    const n = f.calls.length;
    const r = await limited.run("get_gtm_live_version", {});
    expect(r.error?.code).toBe("quota_exceeded");
    expect(f.calls.length).toBe(n);
  });
});

describe("list_gtm_containers", () => {
  it("lists the containers of the connected container's account and marks this one", async () => {
    const r = await run("list_gtm_containers");
    expect(r.data).toMatchObject({ account_path: "accounts/1", truncated: false, containers: [{ path: C, public_id: "GTM-ABC123", usage_context: ["web"], domain_names: ["shop.example"], is_this_container: true }, { path: "accounts/1/containers/3", is_this_container: false }] });
  });
  it("pages and reports truncation at limit", async () => {
    f.pageSize = 1;
    f.otherContainers.push({ path: "accounts/1/containers/4", containerId: "4", name: "Three" });
    const r = await run("list_gtm_containers", { limit: 2 });
    expect(r.data.containers).toHaveLength(2);
    expect(r.data.truncated).toBe(true);
  });
});

describe("get_gtm_live_version", () => {
  it("maps the live version with trigger names; unknown (built-in) trigger ids keep name null", async () => {
    const r = await run("get_gtm_live_version");
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ live: true, version_id: "41", name: "Consent update", counts: { tags: 4, triggers: 2, variables: 1, built_in_variables: 3 } });
    const ga = r.data.tags.find((t: { tag_id: string }) => t.tag_id === "12");
    expect(ga).toMatchObject({ name: "GA4 - add_to_cart", type: "gaawe", type_label: null, firing_triggers: [{ trigger_id: "31", name: "Thank you page" }] });
    expect(ga.parameters.find((p: { key: string }) => p.key === "eventSettingsTable")).toMatchObject({ type: "list", value: "[]" });
    expect(r.data.tags.find((t: { tag_id: string }) => t.tag_id === "10").firing_triggers).toEqual([{ trigger_id: "2147479553", name: null }]);
    expect(r.data.tags.find((t: { tag_id: string }) => t.tag_id === "13").type_label).toBe("Google Ads Conversion Tracking");
    expect(r.data.triggers[0].conditions).toEqual([{ list: "filter", text: '{{Page Path}} contains "/thanks"' }]);
  });

  it("custom HTML is cut at 1,000 characters, or 20,000 with include_html", async () => {
    f.versions[0]!.tag![3]!.parameter![0]!.value = "x".repeat(25_000);
    const short = await run("get_gtm_live_version");
    const p = short.data.tags.find((t: { tag_id: string }) => t.tag_id === "14").parameters[0];
    expect(p.value_truncated).toBe(true);
    expect(p.value.length).toBeLessThan(1_100);
    const long = await run("get_gtm_live_version", { include_html: true });
    expect(long.data.tags.find((t: { tag_id: string }) => t.tag_id === "14").parameters[0].value.startsWith("x".repeat(20_000))).toBe(true);
  });

  it("limit applies per kind with truncated flags; a never-published container reads as live:false; custom templates", async () => {
    f.versions[0]!.customTemplate = [{ templateId: "7", name: "Consent Mode", templateData: "___", galleryReference: { owner: "google", repository: "consent", version: "abc", isModified: false } }];
    const r = await run("get_gtm_live_version", { limit: 2 });
    expect(r.data.tags).toHaveLength(2);
    expect(r.data.tags_truncated).toBe(true);
    expect(r.data.triggers_truncated).toBe(false);
    expect(r.data.custom_templates).toEqual([{ template_id: "7", name: "Consent Mode", gallery: { owner: "google", repository: "consent", version: "abc", is_modified: false } }]);
    f.liveId = null;
    expect((await run("get_gtm_live_version")).data).toMatchObject({ live: false, version_id: null, tags: [], note: expect.stringContaining("Nothing has been published") });
  });
});

describe("list_gtm_tags / triggers / variables", () => {
  it("without a server workspace: the latest version, labelled", async () => {
    const r = await run("list_gtm_tags");
    expect(r.data).toMatchObject({ source: "latest_version", workspace: null, version_id: "41", truncated: false });
    expect(r.data.tags).toHaveLength(4);
  });

  it("default is the JackOfAds workspace; explicit workspace ids; foreign ids are not_found", async () => {
    const w = f.addWorkspace("JackOfAds", SERVER_WS_DESCRIPTION);
    w.tags.push({ tagId: "99", name: "Draft", type: "html", parameter: [], firingTriggerId: ["31"] });
    const r = await run("list_gtm_tags");
    expect(r.data).toMatchObject({ source: "workspace", workspace: { workspace_id: w.ws.workspaceId, name: "JackOfAds" } });
    expect(r.data.tags.map((t: { tag_id: string }) => t.tag_id)).toContain("99");
    expect(r.data.tags.find((t: { tag_id: string }) => t.tag_id === "99").firing_triggers).toEqual([{ trigger_id: "31", name: "Thank you page" }]);
    const def = f.workspaces[0]!.ws.workspaceId!;
    expect((await run("list_gtm_tags", { workspace_id: def })).data.tags).toHaveLength(4);
    expect((await run("list_gtm_tags", { workspace_id: "999999" })).error?.code).toBe("not_found");
    expect((await run("list_gtm_tags", { workspace_id: "../1" })).error?.code).toBe("invalid_argument");
  });

  it("follows nextPageToken across pages and reports truncation at limit", async () => {
    const def = f.workspaces[0]!.ws.workspaceId!;
    f.pageSize = 1;
    const all = await run("list_gtm_tags", { workspace_id: def });
    expect(all.data.tags).toHaveLength(4);
    expect(f.calls.filter((c) => c.path.endsWith("/tags")).length).toBe(4);
    const cut = await run("list_gtm_tags", { workspace_id: def, limit: 3 });
    expect(cut.data).toMatchObject({ truncated: true });
    expect(cut.data.tags).toHaveLength(3);
  });

  it("triggers render conditions as text; variables come with enabled built-ins", async () => {
    const t = await run("list_gtm_triggers");
    expect(t.data.triggers.map((x: { name: string }) => x.name)).toEqual(["Thank you page", "All pages (custom)"]);
    const def = f.workspaces[0]!.ws.workspaceId!;
    const v = await run("list_gtm_variables", { workspace_id: def });
    expect(v.data.variables).toEqual([{ variable_id: "50", name: "Order value", type: "v", parameters: [{ key: "name", type: "template", value: "ecommerce.value", value_truncated: false }], parameters_truncated: false }]);
    expect(v.data.built_in_variables.map((b: { name: string }) => b.name)).toEqual(["Page Path", "Page URL", "Event"]);
    expect(f.calls.some((c) => c.path.endsWith("/built_in_variables"))).toBe(true);
  });
});

describe("get_gtm_workspace_status", () => {
  it("no server workspace: status null", async () => {
    const r = await run("get_gtm_workspace_status");
    expect(r.data).toMatchObject({ status: null, workspaces: [{ name: "Default Workspace", is_server_workspace: false }] });
  });

  it("flags ours, maps changes of each kind and merge conflicts (incl. deleted in base)", async () => {
    const w = f.addWorkspace("JackOfAds", SERVER_WS_DESCRIPTION);
    w.tags.push({ tagId: "99", name: "New", type: "html" });
    w.tags[0]!.paused = true;
    w.triggers = w.triggers.filter((t) => t.triggerId !== "32");
    f.conflicts = [{ entityInWorkspace: { changeStatus: "updated", tag: { tagId: "13", name: "Ads purchase" } } }, { entityInWorkspace: { changeStatus: "updated", variable: { variableId: "50", name: "Order value" } }, entityInBaseVersion: { variable: { variableId: "50", name: "Order value" } } }];
    const r = await run("get_gtm_workspace_status");
    expect(r.data.workspaces.find((x: { name: string }) => x.name === "JackOfAds").is_server_workspace).toBe(true);
    expect(r.data.status.changes).toEqual(
      expect.arrayContaining([
        { kind: "tag", id: "99", name: "New", change_status: "added" },
        { kind: "tag", id: "10", name: "GA4 config", change_status: "updated" },
        { kind: "trigger", id: "32", name: "All pages (custom)", change_status: "deleted" },
      ]),
    );
    expect(r.data.status.conflicts).toEqual([
      { kind: "tag", id: "13", name: "Ads purchase", in_workspace: "updated", deleted_in_base: true },
      { kind: "variable", id: "50", name: "Order value", in_workspace: "updated", deleted_in_base: false },
    ]);
    expect(r.data.note).toContain("Merge conflicts");
  });

  it("a foreign JackOfAds workspace is reported, never treated as ours", async () => {
    f.addWorkspace("JackOfAds", "made by hand");
    const r = await run("get_gtm_workspace_status");
    expect(r.data.status).toBeNull();
    expect(r.data.note).toContain("did not create");
    expect((await run("list_gtm_tags")).error?.code).toBe("conflict");
  });
});
