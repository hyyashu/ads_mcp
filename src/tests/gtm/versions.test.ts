import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../security/canonical";
import { diffVersions } from "../../platforms/gtm/diff";
import { SERVER_WS_DESCRIPTION } from "../../platforms/gtm/client";
import type { GtmTag, GtmVersion } from "../../platforms/gtm/types";
import type { ChangeSet } from "../../policy/change-set";
import { changeTableForTest } from "../../web/routes";
import { FakeGtm, type GtmHarness, gtmHarness, seedContainer } from "./support/fake-gtm";

let f: FakeGtm;
let kit: GtmHarness;
const fake = new Proxy({} as FakeGtm, { get: (_t, p) => (f as never)[p] });
beforeAll(async () => {
  f = new FakeGtm();
  kit = await gtmHarness("GTMV", fake);
});
beforeEach(() => {
  f = new FakeGtm();
  seedContainer(f);
});
const run = (name: string, args: Record<string, unknown>) => kit.run(name, args);
const approve = (id: string, by = kit.second) => kit.approveAs(id, by);
const ours = () => f.addWorkspace("JackOfAds", SERVER_WS_DESCRIPTION);
let n = 0;
const uniq = (s: string) => `${s} ${++n}`;

describe("create_gtm_version", () => {
  it("refuses with no workspace, no changes, or merge conflicts", async () => {
    expect((await run("create_gtm_version", { name: uniq("v") })).error?.message).toContain("No pending JackOfAds changes");
    ours();
    expect((await run("create_gtm_version", { name: uniq("v") })).error?.message).toContain("Nothing to version");
    f.server()!.tags.push({ tagId: "99", name: "New", type: "html" });
    f.conflicts = [{ entityInWorkspace: { changeStatus: "updated", tag: { tagId: "13", name: "Ads purchase" } } }];
    const r = await run("create_gtm_version", { name: uniq("v") });
    expect(r.error).toMatchObject({ code: "conflict", message: expect.stringContaining('tag "Ads purchase"') });
    expect(f.writes()).toEqual([]);
  });

  it("summary lists the changes; success reads the version back; the workspace is gone", async () => {
    const w = ours();
    w.tags.push({ tagId: "99", name: "Meta Pixel - v2", type: "html", firingTriggerId: ["32"] });
    w.tags.find((t) => t.tagId === "12")!.paused = true;
    const name = uniq("Add purchase tracking");
    const r = await run("create_gtm_version", { name, notes: "why" });
    expect(r.approval).toMatchObject({ risk: "write" });
    expect(r.approval!.summary).toContain('added tag "Meta Pixel - v2" (custom HTML)');
    expect(r.approval!.summary).toContain('updated tag "GA4 - add_to_cart"');
    expect(r.approval!.summary).toContain("The live site does not change");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(f.writes()[0]).toMatchObject({ method: "POST", path: `accounts/1/containers/2/workspaces/${w.ws.workspaceId}:create_version`, body: { name, notes: "why\nCreated by JackOfAds after approval." } });
    expect(done.result).toMatchObject({ version_id: "42", name, compiler_error: false, counts: { tags: 5, triggers: 2, variables: 1 }, new_workspace_path: null });
    expect(f.server()).toBeUndefined();
    expect(await kit.verify(done)).toEqual({ outcome: "applied" });
  });

  it("drift between plan and execute → conflict; sync problems and compiler errors are definite when the workspace is still there", async () => {
    const w = ours();
    w.tags.push({ tagId: "99", name: "New", type: "img" });
    const r = await run("create_gtm_version", { name: uniq("v") });
    w.tags.push({ tagId: "98", name: "Another", type: "img" });
    expect((await approve(r.approval!.approval_id)).status).toBe("failed");
    expect(f.writes()).toEqual([]);

    f.createVersionAnswer = () => ({ syncStatus: { mergeConflict: true, syncError: false } });
    const r2 = await run("create_gtm_version", { name: uniq("v") });
    const d2 = await approve(r2.approval!.approval_id);
    expect(d2.status).toBe("failed");
    expect((d2.result as { error: { code: string } }).error.code).toBe("conflict");

    f.createVersionAnswer = () => ({ compilerError: true });
    const d3 = await approve((await run("create_gtm_version", { name: uniq("v") })).approval!.approval_id);
    expect(d3.status).toBe("failed");
    expect((d3.result as { error: { message: string } }).error.message).toContain("compiler error");
    expect(await kit.verify(d3)).toEqual({ outcome: "not_applied" });
  });

  it("reports newWorkspacePath and leaves it alone; a 500 after sending is unknown_outcome", async () => {
    const w = ours();
    w.tags.push({ tagId: "99", name: "New", type: "img" });
    f.createVersionAnswer = (ws) => {
      f.workspaces = f.workspaces.filter((x) => x !== ws);
      const v = f.addVersion({ containerVersionId: "42", name: "named" });
      return { containerVersion: v, compilerError: false, newWorkspacePath: "accounts/1/containers/2/workspaces/777" };
    };
    const d = await approve((await run("create_gtm_version", { name: "named" })).approval!.approval_id);
    expect(d.result).toMatchObject({ new_workspace_path: "accounts/1/containers/2/workspaces/777" });
    f.createVersionAnswer = undefined;
    const w2 = ours();
    w2.tags.push({ tagId: "97", name: "New2", type: "img" });
    f.failAfter.push({ re: /:create_version$/ });
    const d2 = await approve((await run("create_gtm_version", { name: uniq("v") })).approval!.approval_id);
    expect(d2.status).toBe("unknown_outcome");
    expect(await kit.verify(d2)).toEqual({ outcome: "applied" });
  });
});

const T = (x: Partial<GtmTag>): GtmTag => ({ tagId: "1", name: "t", type: "img", firingTriggerId: ["31"], fingerprint: "1", ...x });
const V = (id: string, tags: GtmTag[], extra: Partial<GtmVersion> = {}): GtmVersion => ({ containerVersionId: id, tag: tags, trigger: [{ triggerId: "31", name: "Thanks", type: "pageview" }], ...extra });

describe("diffVersions", () => {
  it("added / removed / changed by id, deterministic order, html in full, paused effects", () => {
    const html = "<script>" + "y".repeat(3000) + "</script>";
    const d = diffVersions(V("1", [T({ tagId: "2", name: "B" }), T({ tagId: "3", name: "A", paused: false }), T({ tagId: "4", name: "Gone" })]), V("2", [T({ tagId: "2", name: "B renamed" }), T({ tagId: "3", name: "A", paused: true, fingerprint: "99" }), T({ tagId: "5", name: "Pixel", type: "html", parameter: [{ type: "template", key: "html", value: html }] })]));
    expect(d.entries.map((e) => [e.status, e.id, e.name])).toEqual([["changed", "3", "A"], ["changed", "2", "B renamed"], ["removed", "4", "Gone"], ["added", "5", "Pixel"]]);
    expect(d.entries[1]!.fields).toEqual([{ field: "name", before: "B", after: "B renamed" }]);
    const rows = d.rows.map((r) => [r.id, r.field, r.effect]);
    expect(rows).toEqual([["3", "paused", "pause"], ["2", "name", "neutral"], ["4", "tag", "remove"], ["5", "tag", "create"], ["5", "parameter.html", "create"]]);
    expect(d.rows.find((r) => r.field === "parameter.html")!.after).toBe(html);
  });

  it("fingerprint-only differences are not changes; list/map params as canonical JSON; long cells capped; sha stable across key order", () => {
    expect(diffVersions(V("1", [T({ fingerprint: "1" })]), V("2", [T({ fingerprint: "2", path: "x" })])).entries).toEqual([]);
    const d = diffVersions(V("1", [T({ parameter: [{ type: "map", key: "m", map: [{ type: "template", key: "a", value: "1" }] }, { type: "template", key: "u", value: "a" }] })]), V("2", [T({ parameter: [{ type: "map", key: "m", map: [{ type: "template", key: "a", value: "2" }] }, { type: "template", key: "u", value: "z".repeat(5000) }] })]));
    expect(d.entries[0]!.fields[0]).toEqual({ field: "parameter.m", before: '[{"key":"a","type":"template","value":"1"}]', after: '[{"key":"a","type":"template","value":"2"}]' });
    expect(String(d.rows[1]!.after).length).toBeLessThan(2100);
    expect(String(d.rows[1]!.after)).toContain("more chars");
    const a = diffVersions(null, V("2", [{ name: "x", tagId: "1", type: "img" }]));
    const b = diffVersions(null, V("2", [{ type: "img", tagId: "1", name: "x" }]));
    expect(a.sha256).toBe(b.sha256);
  });

  it("triggers, variables, built-ins and coarse kinds; template code changes by hash", () => {
    const d = diffVersions(
      V("1", [], { variable: [{ variableId: "5", name: "V", type: "v" }], builtInVariable: [{ type: "pageUrl", name: "Page URL" }], customTemplate: [{ name: "Consent", templateData: "old" }], folder: [{ name: "F" }] }),
      V("2", [], { trigger: [{ triggerId: "31", name: "Thanks", type: "pageview" }, { triggerId: "40", name: "New", type: "click" }], variable: [], builtInVariable: [{ type: "pageUrl", name: "Page URL" }, { type: "event", name: "Event" }], customTemplate: [{ name: "Consent", templateData: "new" }], zone: [{ name: "Z" }] }),
    );
    expect(d.entries.map((e) => `${e.kind}:${e.status}:${e.name}`)).toEqual(["trigger:added:New", "variable:removed:V", "built_in_variable:added:Event"]);
    expect(d.coarse.map((c) => `${c.kind}:${c.status}:${c.name}`)).toEqual(["folder:removed:F", "custom_template:changed:Consent", "zone:added:Z"]);
    expect(d.coarse[1]!.detail).toMatch(/^code changed \(sha256 [0-9a-f]{12} → [0-9a-f]{12}\)$/);
  });
});

describe("publish_gtm_version", () => {
  const prepare = (tags?: GtmTag[], id = "42") => {
    const live = f.versions[0]!;
    const next = f.addVersion({ ...JSON.parse(JSON.stringify(live)), containerVersionId: id, name: "Add pixel", fingerprint: undefined, tag: tags ?? [...(live.tag ?? []), { tagId: "60", name: "Meta Pixel - v2", type: "html", parameter: [{ type: "template", key: "html", value: "<script src='https://connect.facebook.net/x.js'></script>" }], firingTriggerId: ["32"] }] });
    next.fingerprint = `fp-${id}`;
    return next;
  };

  it("destructive, full diff in the change set, requester cannot approve, publishes with the version fingerprint", async () => {
    prepare();
    const r = await run("publish_gtm_version", { version_id: "42" });
    expect(r.approval!.risk).toBe("destructive");
    expect(r.approval!.summary).toContain("PUBLISH to the LIVE website: container GTM-ABC123, shop.example, web. Version 42 \"Add pixel\" replaces live version 41 \"Consent update\"");
    expect(r.approval!.summary).toContain("Tags: 1 added, 0 changed, 0 removed.");
    expect(r.approval!.summary).toContain('Added custom HTML "Meta Pixel - v2" runs on pages matched by All pages (custom) (32) and loads from connect.facebook.net');
    expect(r.approval!.summary).toContain("to roll back, publish version 41 again");
    expect(r.approval!.change_set!.changes).toContainEqual(expect.objectContaining({ field: "parameter.html", after: "<script src='https://connect.facebook.net/x.js'></script>" }));
    // the approval page renders every row with the code escaped
    const page = changeTableForTest(r.approval!.change_set as ChangeSet, "destructive");
    expect(page).toContain("&lt;script src=");
    expect(page).not.toContain("<script src=");
    await expect(approve(r.approval!.approval_id, kit.owner)).rejects.toMatchObject({ code: "permission_denied" });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(f.writes()).toEqual([expect.objectContaining({ method: "POST", path: "accounts/1/containers/2/versions/42:publish", query: { fingerprint: "fp-42" }, body: undefined })]);
    expect(done.result).toEqual({ published_version_id: "42", previous_live_version_id: "41", compiler_error: false, rollback_hint: "To undo, publish version 41 with publish_gtm_version." });
    expect(await kit.verify(done)).toEqual({ outcome: "applied" });
  });

  it("refusals: already live, deleted, more than 300 rows, html above 20,000 characters", async () => {
    expect((await run("publish_gtm_version", { version_id: "41" })).error?.message).toContain("already live");
    prepare().deleted = true;
    expect((await run("publish_gtm_version", { version_id: "42" })).error?.message).toContain("deleted");
    f.versions.pop();
    prepare(Array.from({ length: 301 }, (_, i) => ({ tagId: String(1000 + i), name: `t${i}`, type: "img" })));
    expect((await run("publish_gtm_version", { version_id: "42" })).error?.message).toContain("more than one approval page can show (300)");
    f.versions.pop();
    prepare([{ tagId: "70", name: "Big", type: "html", parameter: [{ type: "template", key: "html", value: "x".repeat(20_001) }] }]);
    expect((await run("publish_gtm_version", { version_id: "42" })).error?.message).toContain("too large to show");
    expect(f.writes()).toEqual([]);
  });

  it("an older version is a rollback; a never-published container diffs against nothing", async () => {
    f.addVersion({ ...JSON.parse(JSON.stringify(f.versions[0]!)), containerVersionId: "40", name: "Old", tag: [] });
    const r = await run("publish_gtm_version", { version_id: "40" });
    expect(r.approval!.summary).toContain("OLDER version");
    expect(r.approval!.summary).toContain("Tags: 0 added, 0 changed, 4 removed.");
    expect(r.approval!.change_set!.changes.filter((c) => c.effect === "remove")).toHaveLength(5); // 4 tags + the html code row
    f.liveId = null;
    const r2 = await run("publish_gtm_version", { version_id: "41" });
    expect(r2.approval!.summary).toContain("becomes the first live version");
    expect(r2.approval!.summary).toContain("Tags: 4 added");
  });

  it("drift → conflict (live changed, target changed); compiler error leaves live unchanged → failed; another live version → unknown_outcome", async () => {
    const target = prepare(undefined, "52");
    const r = await run("publish_gtm_version", { version_id: "52" });
    target.fingerprint = "changed";
    expect((await approve(r.approval!.approval_id)).status).toBe("failed");
    expect(f.writes()).toEqual([]);

    const r2 = await run("publish_gtm_version", { version_id: "52" });
    f.versions[0]!.name = "renamed";
    f.versions[0]!.fingerprint = "live-changed";
    expect((await approve(r2.approval!.approval_id)).status).toBe("failed");

    f.publishCompilerError = true;
    const d3 = await approve((await run("publish_gtm_version", { version_id: "52" })).approval!.approval_id);
    expect(d3.status).toBe("failed");
    expect((d3.result as { error: { message: string } }).error.message).toContain("live site is unchanged");
    expect(await kit.verify(d3)).toEqual({ outcome: "not_applied" });
    f.publishCompilerError = false;

    f.addVersion({ containerVersionId: "53", name: "other" });
    f.onRequest = (c) => {
      if (c.path.endsWith(":publish")) queueMicrotask(() => (f.liveId = "53"));
    };
    f.dropWrites = true;
    const d4 = await approve((await run("publish_gtm_version", { version_id: "52" })).approval!.approval_id);
    f.onRequest = undefined;
    expect(d4.status).toBe("unknown_outcome");
    expect(await kit.verify(d4)).toMatchObject({ outcome: "indeterminate", detail: "another version was published" });
  });

  it("automation never approves a publish", async () => {
    prepare(undefined, "62");
    const r = await run("publish_gtm_version", { version_id: "62" });
    expect(r.approval!.status).toBe("pending_approval");
    expect(canonicalJson(r.meta.auto_approval ?? null)).toBe("null");
  });
});
