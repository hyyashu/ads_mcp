import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { canonicalJson } from "../../../security/canonical";
import { type GtmClient, SERVER_WS_NAME, gtmIdOrFail } from "../client";
import { type Diff, diffVersions, longestCode } from "../diff";
import { hostsNote, stripVolatile } from "../model";
import { GTM_EDIT_VERSIONS, GTM_PUBLISH, accountId, entityName, gtmId, notesText } from "./common";
import { entityInfo } from "./reads";
import { confirmAfterSend, gtmStateWrite, q } from "./write-kit";

// ---- create_gtm_version ---------------------------------------------------------------------------------------------------

interface VersionS {
  public_id: string | null;
  workspace_id: string | null;
  workspace_fingerprint: string | null;
  changes: { kind: string; id: string | null; name: string | null; change_status: string; entity: unknown }[];
  conflicts: { kind: string; id: string | null; name: string | null }[];
}

async function readVersionState(gtm: GtmClient): Promise<VersionS> {
  const container = await gtm.getContainer();
  const ws = await gtm.findServerWorkspace();
  if (!ws) return { public_id: container.publicId ?? null, workspace_id: null, workspace_fingerprint: null, changes: [], conflicts: [] };
  const st = await gtm.workspaceStatus(ws.workspaceId!);
  const changes = (st.workspaceChange ?? [])
    .flatMap((e) => {
      const i = entityInfo(e);
      return i ? [{ kind: i.kind, id: i.id, name: i.name, change_status: e.changeStatus ?? "unknown", entity: stripVolatile(i.entity) }] : [];
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || (a.id ?? a.name ?? "").localeCompare(b.id ?? b.name ?? "", undefined, { numeric: true }));
  const conflicts = (st.mergeConflict ?? []).flatMap((m) => {
    const i = entityInfo(m.entityInWorkspace) ?? entityInfo(m.entityInBaseVersion);
    return i ? [{ kind: i.kind, id: i.id, name: i.name }] : [];
  });
  return { public_id: container.publicId ?? null, workspace_id: ws.workspaceId!, workspace_fingerprint: ws.fingerprint ?? null, changes, conflicts };
}

const KIND_TEXT: Record<string, string> = { tag: "tag", trigger: "trigger", variable: "variable", folder: "folder", built_in_variable: "built-in variable", custom_template: "custom template", client: "client", zone: "zone", gtag_config: "Google tag config", transformation: "transformation" };
const changeText = (c: VersionS["changes"][number]) => {
  const html = c.kind === "tag" && (c.entity as { type?: string }).type === "html" ? " (custom HTML)" : "";
  return `${c.change_status} ${KIND_TEXT[c.kind] ?? c.kind} ${q(c.name ?? c.id ?? "?")}${html}`;
};

export const createGtmVersion = gtmStateWrite({
  name: "create_gtm_version",
  title: "Create a Tag Manager version",
  description:
    "Turns the server's JackOfAds workspace (the drafts made with create_gtm_tag, update_gtm_tag, create_gtm_trigger) into a new container version. Nothing changes on the site: publishing is a separate step (publish_gtm_version, second approver). Refused when the workspace has merge conflicts (resolve them in Tag Manager). Tag Manager removes the workspace afterwards; the next draft starts a new one.",
  risk: "write",
  scope: GTM_EDIT_VERSIONS,
  input: z.object({ account_id: accountId, name: entityName.max(200), notes: notesText.optional() }),
  output: z.object({
    version_id: z.string(),
    name: z.string(),
    compiler_error: z.boolean(),
    counts: z.object({ tags: z.number().int(), triggers: z.number().int(), variables: z.number().int() }),
    new_workspace_path: z.string().nullable().describe("A workspace Tag Manager created automatically after versioning; reported and left alone."),
    next_step: z.string(),
  }),
  read: (_a, gtm) => readVersionState(gtm),
  build: (a, s) => {
    if (!s.workspace_id) throw new ToolError("invalid_argument", `No pending ${SERVER_WS_NAME} changes to version: the server has no workspace in this container.`);
    if (s.conflicts.length) throw new ToolError("conflict", `The ${SERVER_WS_NAME} workspace has merge conflicts with the latest version: ${s.conflicts.map((c) => `${KIND_TEXT[c.kind] ?? c.kind} ${q(c.name ?? c.id ?? "?")}`).join(", ")}. Resolve the conflicts in Tag Manager (Workspace → Update) first. Nothing was changed.`, { definite: true });
    if (!s.changes.length) throw new ToolError("invalid_argument", `Nothing to version: the ${SERVER_WS_NAME} workspace has no changes.`);
    return {
      summary: `Create version ${q(a.name)} of container ${s.public_id ?? ""} from workspace ${SERVER_WS_NAME} with ${s.changes.length} change(s): ${s.changes.map(changeText).join(", ")}. Tag Manager first brings the workspace up to date with the latest version, so the version also contains everything published since. The live site does not change: publishing is a separate step (publish_gtm_version, second approver). Tag Manager removes the ${SERVER_WS_NAME} workspace after this; the next change starts a new one.`,
      changes: s.changes.map((c) => ({ resource: `gtm_${c.kind}`, id: c.id ?? c.name ?? "?", name: c.name, field: "change", before: null, after: c.change_status, unit: "text" as const, effect: "neutral" as const })),
    };
  },
  apply: async (a, s, gtm) => {
    const wsId = s.workspace_id!;
    const res = await gtm.createVersion(wsId, { name: a.name, notes: `${a.notes ? `${a.notes}\n` : ""}Created by JackOfAds after approval.` });
    const wsStillThere = () => confirmAfterSend("version request", async () => (await gtm.listWorkspaces()).some((w) => w.workspaceId === wsId));
    if (res.syncStatus?.mergeConflict || res.syncStatus?.syncError) {
      if (await wsStillThere()) throw new ToolError("conflict", "Tag Manager could not bring the workspace up to date (merge conflict or sync error). No version was created. Resolve it in Tag Manager (Workspace → Update).", { definite: true });
      throw new ToolError("unknown_outcome", "Tag Manager reported a sync problem, but the workspace is gone: check the container's versions in Tag Manager.");
    }
    const vid = res.containerVersion?.containerVersionId;
    if (!vid) {
      if (res.compilerError && (await wsStillThere())) throw new ToolError("invalid_argument", "Tag Manager reported a compiler error; no version was created. Check the workspace in Tag Manager.", { definite: true });
      throw new ToolError("unknown_outcome", "Tag Manager returned no version id. Check the container's versions in Tag Manager.");
    }
    return confirmAfterSend("version", async () => {
      const v = await gtm.getVersion(gtmIdOrFail(String(vid), "version"));
      if (v.name !== a.name) throw new ToolError("unknown_outcome", "Tag Manager returned a version that does not read back with the requested name.");
      return {
        version_id: String(vid),
        name: v.name ?? a.name,
        compiler_error: res.compilerError === true,
        counts: { tags: v.tag?.length ?? 0, triggers: v.trigger?.length ?? 0, variables: v.variable?.length ?? 0 },
        new_workspace_path: res.newWorkspacePath ? res.newWorkspacePath.slice(0, 200) : null,
        next_step: "Review and publish it with publish_gtm_version (needs a second approver).",
      };
    });
  },
  verify: async (a, before, gtm) => {
    const all = await gtm.listWorkspaces();
    if (all.some((w) => w.workspaceId === before.workspace_id)) {
      const now = await readVersionState(gtm);
      return now.workspace_id === before.workspace_id && canonicalJson(now) === canonicalJson(before) ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: "the workspace still exists but changed" };
    }
    const h = await gtm.latestVersionHeader();
    return h?.name === a.name ? { outcome: "applied" } : { outcome: "indeterminate", detail: "the workspace is gone but the latest version has another name" };
  },
});

// ---- publish_gtm_version --------------------------------------------------------------------------------------------------

/** Rows the approval page shows for a destructive approval (src/web/routes.ts changeTable). */
export const PUBLISH_MAX_ROWS = 300;
/** Longest code (custom HTML, Custom JavaScript, template code) or coarse settings value the approval shows; longer is refused. */
export const PUBLISH_MAX_CODE = 20_000;

interface PublishS {
  live_version_id: string | null;
  live_fingerprint: string | null;
  target_version_id: string;
  target_fingerprint: string | null;
  target_deleted: boolean;
  diff_sha256: string;
}

async function readPublish(versionId: string, gtm: GtmClient) {
  const container = await gtm.getContainer();
  const live = await gtm.liveVersion();
  const target = await gtm.getVersion(versionId);
  const diff = diffVersions(live, target);
  const s: PublishS = { live_version_id: live?.containerVersionId ?? null, live_fingerprint: live?.fingerprint ?? null, target_version_id: versionId, target_fingerprint: target.fingerprint ?? null, target_deleted: target.deleted === true, diff_sha256: diff.sha256 };
  Object.defineProperty(s, "__ctx", { value: { container, live, target, diff }, enumerable: false });
  return s;
}
type Ctx = { container: { publicId?: string; domainName?: string[]; usageContext?: string[] }; live: { name?: string } | null; target: { name?: string }; diff: Diff };
const ctxOf = (s: PublishS) => (s as PublishS & { __ctx: Ctx }).__ctx;

function counts(d: Diff) {
  const by = (kind: string) => {
    const e = d.entries.filter((x) => x.kind === kind);
    const n = (st: string) => e.filter((x) => x.status === st).length;
    return e.length ? `${n("added")} added, ${n("changed")} changed, ${n("removed")} removed` : "none changed";
  };
  return `Tags: ${by("tag")}. Triggers: ${by("trigger")}. Variables: ${by("variable")}. Built-in variables: ${by("built_in_variable")}.`;
}

export const publishGtmVersion = gtmStateWrite({
  name: "publish_gtm_version",
  title: "Publish a Tag Manager version",
  description:
    "Publishes a container version to the LIVE website: the only Tag Manager tool that changes the site. Any version of the container can be published, including an older one (rollback). The approval lists every difference from the live version, one row per setting: added and removed tags, triggers and variables with all their settings and parameters, changed ones with each differing setting before and after, built-in variables, and folders, templates, clients, zones, Google tag configs and transformations with their settings. Code is shown in full in its own row: custom HTML tags, Custom JavaScript variables and custom template code (other values are cut at 2,000 characters). Refused when any code is over 20,000 characters or the list is over 300 rows (publish those in Tag Manager). Needs a second approver. There is no undo through the API: roll back by publishing the previous version.",
  risk: "destructive",
  scope: GTM_PUBLISH,
  input: z.object({ account_id: accountId, version_id: gtmId.describe("Container version to publish (create_gtm_version returns it).") }),
  output: z.object({ published_version_id: z.string(), previous_live_version_id: z.string().nullable(), compiler_error: z.boolean(), rollback_hint: z.string() }),
  read: (a, gtm) => readPublish(a.version_id, gtm),
  build: (a, s) => {
    const { container, live, target, diff } = ctxOf(s);
    if (s.target_deleted) throw new ToolError("invalid_argument", `Version ${a.version_id} is deleted and cannot be published.`);
    if (s.live_version_id === a.version_id) throw new ToolError("invalid_argument", `Version ${a.version_id} is already live.`);
    if (!s.target_fingerprint) throw new ToolError("internal", "Tag Manager returned the version without a fingerprint, so the publish could not be guarded. Nothing was changed.");
    if (diff.rows.length > PUBLISH_MAX_ROWS) throw new ToolError("invalid_argument", `This publish changes ${diff.rows.length} settings, more than one approval page can show (${PUBLISH_MAX_ROWS}). Publish it in Tag Manager, or split it.`);
    if (longestCode(diff) > PUBLISH_MAX_CODE) throw new ToolError("invalid_argument", `Code in this publish (a custom HTML tag, Custom JavaScript variable or custom template) is longer than ${PUBLISH_MAX_CODE.toLocaleString("en-US")} characters, too large to show to approvers. Publish it in Tag Manager.`);
    const older = s.live_version_id !== null && Number(a.version_id) < Number(s.live_version_id);
    const where = [container.publicId, (container.domainName ?? []).join(", "), (container.usageContext ?? []).join(", ")].filter(Boolean).join(", ");
    const coarse = diff.coarse.length ? ` Also changed: ${diff.coarse.map((c) => `${c.kind.replace(/_/g, " ")} ${q(c.name)} (${c.status}${c.detail ? `, ${c.detail}` : ""})`).join("; ")}.` : "";
    const codeNotes = [
      ...diff.entries
        .filter((e) => e.code?.after)
        .map((e) => {
          const fires = e.fields.find((f) => f.field === "firing triggers")?.after;
          const what = e.kind === "tag" ? "custom HTML tag" : "Custom JavaScript variable";
          return `${e.status === "added" ? "Added" : "Changed"} ${what} ${q(e.name)}${fires ? ` runs on pages matched by ${fires}` : ""}; ${hostsNote(e.code!.after!)}. Its full code is in the change list below.`;
        }),
      ...diff.coarse
        .filter((c) => c.kind === "custom_template" && c.status !== "removed")
        .flatMap((c) => {
          const code = c.parts.find((p) => p.field === "templateData")?.after;
          return code ? [`${c.status === "added" ? "Added" : "Changed"} custom template ${q(c.name)} (its code runs wherever a tag or variable uses it); ${hostsNote(code)}. Its full code is in the change list below.`] : [];
        }),
    ];
    const summary = [
      `PUBLISH to the LIVE website: container ${where || "?"}. Version ${a.version_id} ${q(target.name ?? "")} ${live ? `replaces live version ${s.live_version_id} ${q(live.name ?? "")}` : "becomes the first live version (nothing is published yet)"}.${older ? " This is an OLDER version than the live one: it rolls changes back." : ""}`,
      `${counts(diff)}${coarse}${diff.rows.length ? "" : " No differences from the live version were found."}`,
      ...codeNotes,
      `There is no undo through the API: ${live ? `to roll back, publish version ${s.live_version_id} again (publish_gtm_version).` : "to stop the tags, publish a version without them."}`,
    ].join("\n");
    return { summary, changes: diff.rows };
  },
  apply: async (a, s, gtm) => {
    const res = await gtm.publishVersion(a.version_id, s.target_fingerprint!);
    const live = await confirmAfterSend("publish", () => gtm.liveVersion());
    const id = live?.containerVersionId ?? null;
    if (id === a.version_id) {
      return { published_version_id: a.version_id, previous_live_version_id: s.live_version_id, compiler_error: res.compilerError === true, rollback_hint: s.live_version_id ? `To undo, publish version ${s.live_version_id} with publish_gtm_version.` : "Nothing was live before; to stop the tags, publish a version without them." };
    }
    if (id === s.live_version_id && res.compilerError) throw new ToolError("invalid_argument", "Tag Manager reported a compiler error and did not publish. The live site is unchanged.", { definite: true });
    throw new ToolError("unknown_outcome", `After the publish, the live version is ${id ?? "none"}, not ${a.version_id}. Check the container in Tag Manager.`);
  },
  verify: async (a, before, gtm) => {
    const live = await gtm.liveVersion();
    const id = live?.containerVersionId ?? null;
    if (id === a.version_id) return { outcome: "applied" };
    if (id === before.live_version_id) return { outcome: "not_applied" };
    return { outcome: "indeterminate", detail: "another version was published" };
  },
});
