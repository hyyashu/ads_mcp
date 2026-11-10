import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { type GtmClient, SERVER_WS_NAME } from "../client";
import { BuiltInOut, TagOut, TemplateOut, TriggerOut, VariableOut, builtInOut, htmlCapOf, tagOut, templateOut, triggerNameMap, triggerOut, variableOut } from "../model";
import type { GtmEntity, GtmVersion, GtmWorkspace } from "../types";
import { UNTRUSTED, accountId, gtmId, gtmRead, includeHtml, listLimit } from "./common";

// ---- list_gtm_containers ------------------------------------------------------------------------------------------------

const containersOut = z.object({
  account_path: z.string().describe("The Tag Manager account, accounts/N."),
  containers: z.array(
    z.object({
      path: z.string().describe("accounts/N/containers/N: pass it as account_id to the other Tag Manager tools when that container is connected (list_accounts)."),
      container_id: z.string(),
      name: z.string(),
      public_id: z.string().nullable().describe("GTM-… id used in the website snippet."),
      usage_context: z.array(z.string()).describe("web, android, ios, amp, server, …"),
      domain_names: z.array(z.string()),
      is_this_container: z.boolean().describe("The container named by account_id."),
    }),
  ),
  truncated: z.boolean(),
});
export const listGtmContainers = gtmRead({
  name: "list_gtm_containers",
  title: "List Tag Manager containers",
  description: `Lists the containers of the Tag Manager account that owns the connected container named by account_id: path, GTM- public id, usage context and domains (one paged request). Only containers connected on the Connections page (see list_accounts) can be used by the other tools. ${UNTRUSTED}`,
  input: z.object({ account_id: accountId, limit: listLimit }),
  output: containersOut,
  handler: async (a, ctx) => {
    const gtm = ctx.services.gtm;
    const { items, truncated } = await gtm.listAccountContainers({ maxRows: a.limit });
    return {
      account_path: gtm.accountPath,
      containers: items.map((c) => ({
        path: c.path ?? "",
        container_id: c.containerId ?? "",
        name: c.name ?? "",
        public_id: c.publicId ?? null,
        usage_context: c.usageContext ?? [],
        domain_names: (c.domainName ?? []).slice(0, 100),
        is_this_container: c.path === gtm.containerPath,
      })),
      truncated,
    };
  },
});

// ---- get_gtm_live_version -----------------------------------------------------------------------------------------------

const COUNT_KEYS = { tags: "tag", triggers: "trigger", variables: "variable", built_in_variables: "builtInVariable", folders: "folder", custom_templates: "customTemplate", clients: "client", zones: "zone", gtag_configs: "gtagConfig", transformations: "transformation" } as const;
const liveOut = z.object({
  live: z.boolean().describe("false when nothing was ever published (Tag Manager has no live version)."),
  version_id: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  fingerprint: z.string().nullable(),
  counts: z.object(Object.fromEntries(Object.keys(COUNT_KEYS).map((k) => [k, z.number().int()])) as Record<keyof typeof COUNT_KEYS, z.ZodNumber>),
  tags: z.array(TagOut),
  triggers: z.array(TriggerOut),
  variables: z.array(VariableOut),
  built_in_variables: z.array(BuiltInOut),
  custom_templates: z.array(TemplateOut),
  tags_truncated: z.boolean(),
  triggers_truncated: z.boolean(),
  variables_truncated: z.boolean(),
  built_in_variables_truncated: z.boolean(),
  custom_templates_truncated: z.boolean(),
  note: z.string().nullable(),
});
export const getGtmLiveVersion = gtmRead({
  name: "get_gtm_live_version",
  title: "Get the live Tag Manager version",
  description: `Reads the published (live) version of a Tag Manager container: tags with their triggers and parameters, triggers with their conditions, variables, enabled built-in variables and custom templates. limit applies to each list; custom HTML is cut at 1,000 characters unless include_html. ${UNTRUSTED}`,
  input: z.object({ account_id: accountId, include_html: includeHtml, limit: listLimit }),
  output: liveOut,
  handler: async (a, ctx) => versionOut(await ctx.services.gtm.liveVersion(), a.limit, htmlCapOf(a.include_html)),
});

export function versionOut(v: GtmVersion | null, limit: number, htmlCap: number): z.infer<typeof liveOut> {
  const counts = Object.fromEntries(Object.entries(COUNT_KEYS).map(([k, f]) => [k, ((v?.[f] as unknown[] | undefined) ?? []).length])) as z.infer<typeof liveOut>["counts"];
  const names = triggerNameMap(v?.trigger);
  const lim = <T>(xs: T[] | undefined) => ({ items: (xs ?? []).slice(0, limit), truncated: (xs ?? []).length > limit });
  const tags = lim(v?.tag);
  const trigs = lim(v?.trigger);
  const vars = lim(v?.variable);
  const bis = lim(v?.builtInVariable);
  const tpls = lim(v?.customTemplate);
  return {
    live: !!v,
    version_id: v?.containerVersionId ?? null,
    name: v?.name ?? null,
    description: v?.description ?? null,
    fingerprint: v?.fingerprint ?? null,
    counts,
    tags: tags.items.map((t) => tagOut(t, names, htmlCap)),
    triggers: trigs.items.map(triggerOut),
    variables: vars.items.map(variableOut),
    built_in_variables: bis.items.map(builtInOut),
    custom_templates: tpls.items.map(templateOut),
    tags_truncated: tags.truncated,
    triggers_truncated: trigs.truncated,
    variables_truncated: vars.truncated,
    built_in_variables_truncated: bis.truncated,
    custom_templates_truncated: tpls.truncated,
    note: v ? null : "Nothing has been published in this container yet.",
  };
}

// ---- list_gtm_tags / list_gtm_triggers / list_gtm_variables ---------------------------------------------------------------

/** Where a list reads from: an explicit workspace, the server's JackOfAds workspace, or (absent) the latest version. */
async function listSource(gtm: GtmClient, workspaceId: string | undefined): Promise<{ ws: GtmWorkspace } | { version: GtmVersion | null }> {
  const all = await gtm.listWorkspaces();
  if (workspaceId) {
    const ws = all.find((w) => w.workspaceId === workspaceId);
    if (!ws) throw new ToolError("not_found", `Workspace ${workspaceId} is not a workspace of this container. get_gtm_workspace_status lists them.`);
    return { ws };
  }
  const ws = await gtm.findServerWorkspace(all);
  return ws ? { ws } : { version: await gtm.latestVersion() };
}
const sourceFields = {
  source: z.enum(["workspace", "latest_version"]).describe("latest_version: the server has no JackOfAds workspace yet, so this is what a new one would start from."),
  workspace: z.object({ workspace_id: z.string(), name: z.string() }).nullable(),
  version_id: z.string().nullable(),
  truncated: z.boolean(),
};
const listInput = { account_id: accountId, workspace_id: gtmId.optional().describe(`Workspace to read. Default: the server's ${SERVER_WS_NAME} workspace, or the latest version when it does not exist.`), limit: listLimit };
const srcMeta = (s: { ws: GtmWorkspace } | { version: GtmVersion | null }) =>
  "ws" in s ? { source: "workspace" as const, workspace: { workspace_id: s.ws.workspaceId ?? "", name: s.ws.name ?? "" }, version_id: null } : { source: "latest_version" as const, workspace: null, version_id: s.version?.containerVersionId ?? null };

export const listGtmTags = gtmRead({
  name: "list_gtm_tags",
  title: "List Tag Manager tags",
  description: `Lists the tags of a Tag Manager workspace (default: the server's JackOfAds draft workspace, or the latest version if it has none) with type, firing and blocking triggers, paused state, consent status and parameters. ${UNTRUSTED}`,
  input: z.object({ ...listInput, include_html: includeHtml }),
  output: z.object({ ...sourceFields, tags: z.array(TagOut) }),
  handler: async (a, ctx) => {
    const gtm = ctx.services.gtm;
    const s = await listSource(gtm, a.workspace_id);
    const cap = htmlCapOf(a.include_html);
    if ("ws" in s) {
      const { items, truncated } = await gtm.listTags(s.ws.workspaceId!, { maxRows: a.limit, partial: true });
      const names = triggerNameMap((await gtm.listTriggers(s.ws.workspaceId!, { maxRows: 5_000, partial: true })).items);
      return { ...srcMeta(s), tags: items.map((t) => tagOut(t, names, cap)), truncated };
    }
    const tags = s.version?.tag ?? [];
    const names = triggerNameMap(s.version?.trigger);
    return { ...srcMeta(s), tags: tags.slice(0, a.limit).map((t) => tagOut(t, names, cap)), truncated: tags.length > a.limit };
  },
});

export const listGtmTriggers = gtmRead({
  name: "list_gtm_triggers",
  title: "List Tag Manager triggers",
  description: `Lists the triggers of a Tag Manager workspace (default: the server's JackOfAds draft workspace, or the latest version if it has none) with type and conditions as text. Built-in triggers such as All Pages are not listed by Tag Manager. ${UNTRUSTED}`,
  input: z.object(listInput),
  output: z.object({ ...sourceFields, triggers: z.array(TriggerOut) }),
  handler: async (a, ctx) => {
    const gtm = ctx.services.gtm;
    const s = await listSource(gtm, a.workspace_id);
    if ("ws" in s) {
      const { items, truncated } = await gtm.listTriggers(s.ws.workspaceId!, { maxRows: a.limit, partial: true });
      return { ...srcMeta(s), triggers: items.map(triggerOut), truncated };
    }
    const ts = s.version?.trigger ?? [];
    return { ...srcMeta(s), triggers: ts.slice(0, a.limit).map(triggerOut), truncated: ts.length > a.limit };
  },
});

export const listGtmVariables = gtmRead({
  name: "list_gtm_variables",
  title: "List Tag Manager variables",
  description: `Lists the user-defined variables and the enabled built-in variables of a Tag Manager workspace (default: the server's JackOfAds draft workspace, or the latest version if it has none). Use the names in {{Name}} references. ${UNTRUSTED}`,
  input: z.object(listInput),
  output: z.object({ ...sourceFields, variables: z.array(VariableOut), built_in_variables: z.array(BuiltInOut), built_in_variables_truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const gtm = ctx.services.gtm;
    const s = await listSource(gtm, a.workspace_id);
    if ("ws" in s) {
      const { items, truncated } = await gtm.listVariables(s.ws.workspaceId!, { maxRows: a.limit, partial: true });
      const bi = await gtm.listBuiltIns(s.ws.workspaceId!, { maxRows: a.limit, partial: true });
      return { ...srcMeta(s), variables: items.map(variableOut), built_in_variables: bi.items.map(builtInOut), built_in_variables_truncated: bi.truncated, truncated };
    }
    const vs = s.version?.variable ?? [];
    const bis = s.version?.builtInVariable ?? [];
    return { ...srcMeta(s), variables: vs.slice(0, a.limit).map(variableOut), built_in_variables: bis.slice(0, a.limit).map(builtInOut), built_in_variables_truncated: bis.length > a.limit, truncated: vs.length > a.limit };
  },
});

// ---- get_gtm_workspace_status -----------------------------------------------------------------------------------------

const ENTITY_KINDS = [
  ["tag", "tag", "tagId"],
  ["trigger", "trigger", "triggerId"],
  ["variable", "variable", "variableId"],
  ["folder", "folder", null],
  ["built_in_variable", "builtInVariable", null],
  ["custom_template", "customTemplate", "templateId"],
  ["client", "client", null],
  ["zone", "zone", null],
  ["gtag_config", "gtagConfig", "gtagConfigId"],
  ["transformation", "transformation", null],
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number][0];
const KindEnum = z.enum(ENTITY_KINDS.map((k) => k[0]) as [EntityKind, ...EntityKind[]]);

/** The kind, id and name of a getStatus Entity (exactly one entity field is set). Ids are read only for kinds whose id field is documented. */
export function entityInfo(e: GtmEntity | undefined): { kind: EntityKind; id: string | null; name: string | null; entity: Record<string, unknown> } | null {
  if (!e) return null;
  for (const [kind, field, idKey] of ENTITY_KINDS) {
    const x = e[field] as Record<string, unknown> | undefined;
    if (x && typeof x === "object") return { kind, id: idKey ? ((x[idKey] as string | undefined) ?? null) : null, name: (x.name as string | undefined) ?? (kind === "built_in_variable" ? ((x.type as string | undefined) ?? null) : null), entity: x };
  }
  return null;
}
const CHANGE = z.enum(["added", "updated", "deleted", "none", "unknown"]);
const changeOf = (s: string | undefined): z.infer<typeof CHANGE> => (s === "added" || s === "updated" || s === "deleted" || s === "none" ? s : "unknown");

export const getGtmWorkspaceStatus = gtmRead({
  name: "get_gtm_workspace_status",
  title: "Get Tag Manager workspace status",
  description: `Lists the container's workspaces and, for one of them (default: the server's JackOfAds workspace), the entities changed in it compared with its base version and any merge conflicts. ${UNTRUSTED}`,
  input: z.object({ account_id: accountId, workspace_id: gtmId.optional().describe("Default: the server's JackOfAds workspace.") }),
  output: z.object({
    workspaces: z.array(z.object({ workspace_id: z.string(), name: z.string(), description: z.string().nullable(), is_server_workspace: z.boolean() })).max(100),
    status: z
      .object({
        workspace_id: z.string(),
        changes: z.array(z.object({ kind: KindEnum, id: z.string().nullable(), name: z.string().nullable(), change_status: CHANGE })).max(500),
        changes_truncated: z.boolean(),
        conflicts: z.array(z.object({ kind: KindEnum, id: z.string().nullable(), name: z.string().nullable(), in_workspace: CHANGE, deleted_in_base: z.boolean() })).max(100),
        conflicts_truncated: z.boolean(),
      })
      .nullable(),
    note: z.string(),
  }),
  handler: async (a, ctx) => {
    const gtm = ctx.services.gtm;
    const all = await gtm.listWorkspaces();
    let server: GtmWorkspace | null = null;
    let identity: string | null = null;
    try {
      server = await gtm.findServerWorkspace(all);
    } catch (e) {
      if (!(e instanceof ToolError && e.code === "conflict")) throw e;
      identity = e.message;
    }
    const workspaces = all.map((w) => ({ workspace_id: w.workspaceId ?? "", name: w.name ?? "", description: w.description ?? null, is_server_workspace: !!server && w.workspaceId === server.workspaceId }));
    let target: GtmWorkspace | null = null;
    if (a.workspace_id) {
      target = all.find((w) => w.workspaceId === a.workspace_id) ?? null;
      if (!target) throw new ToolError("not_found", `Workspace ${a.workspace_id} is not a workspace of this container.`);
    } else target = server;
    if (!target) return { workspaces, status: null, note: identity ?? `There is no ${SERVER_WS_NAME} workspace: no changes from this server are pending.` };
    const st = await gtm.workspaceStatus(target.workspaceId!);
    const changes = (st.workspaceChange ?? []).flatMap((e) => {
      const i = entityInfo(e);
      return i ? [{ kind: i.kind, id: i.id, name: i.name, change_status: changeOf(e.changeStatus) }] : [];
    });
    const conflicts = (st.mergeConflict ?? []).flatMap((m) => {
      const i = entityInfo(m.entityInWorkspace) ?? entityInfo(m.entityInBaseVersion);
      return i ? [{ kind: i.kind, id: i.id, name: i.name, in_workspace: changeOf(m.entityInWorkspace?.changeStatus), deleted_in_base: !entityInfo(m.entityInBaseVersion) }] : [];
    });
    return {
      workspaces,
      status: { workspace_id: target.workspaceId!, changes: changes.slice(0, 500), changes_truncated: changes.length > 500, conflicts: conflicts.slice(0, 100), conflicts_truncated: conflicts.length > 100 },
      note: identity ?? (conflicts.length ? "Merge conflicts must be resolved in Tag Manager (Workspace → Update) before a version can be created." : changes.length ? `${changes.length} changed entities.` : "No changes in this workspace."),
    };
  },
});
