import { ToolError } from "../../mcp/errors";
import { GoogleApiClient, type GoogleApiClientOptions, HARD_ROW_CAP, tooManyRows } from "../gapi/client";
import type { CreateVersionResponse, GtmBuiltIn, GtmContainerInfo, GtmStatus, GtmTag, GtmTrigger, GtmVariable, GtmVersion, GtmVersionHeader, GtmWorkspace, PublishResponse } from "./types";
import { type Discovery, MAX_DISCOVERED } from "../gapi/discovery";

export const GTM_API = "https://tagmanager.googleapis.com/tagmanager/v2";

export const isContainerPath = (s: string) => /^accounts\/\d{1,20}\/containers\/\d{1,20}$/.test(s);

/** One Tag Manager container (connected_account.external_id = "accounts/1/containers/2", the container's API path). */
export class GtmClient extends GoogleApiClient {
  constructor(o: GoogleApiClientOptions & { containerPath: string }) {
    super(o);
    if (!isContainerPath(o.containerPath)) throw new ToolError("internal", "Not a Tag Manager container path.");
    this.containerPath = o.containerPath;
  }
  readonly containerPath: string;

  /** `https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2`. */
  get containerBase(): string {
    return `${GTM_API}/${this.containerPath}`;
  }

  /** `accounts/1`: the Tag Manager account that owns this container. */
  get accountPath(): string {
    return this.containerPath.split("/containers/")[0]!;
  }

  /** `.../workspaces/{id}`. Every id is checked to be digits before it is placed in a URL. */
  workspaceUrl(wsId: string): string {
    return `${this.containerBase}/workspaces/${gtmIdOrFail(wsId, "workspace")}`;
  }
  versionUrl(versionId: string): string {
    return `${this.containerBase}/versions/${gtmIdOrFail(versionId, "version")}`;
  }

  // ---- reads ----------------------------------------------------------------------------------------------------------

  /** containers.get: publicId, domainName, usageContext, tagIds, features. */
  getContainer(): Promise<GtmContainerInfo> {
    return this.read<GtmContainerInfo>(this.containerBase);
  }

  /** accounts.containers.list of this container's Tag Manager account (pageToken paging). */
  listAccountContainers(o: { maxRows: number }): Promise<{ items: GtmContainerInfo[]; truncated: boolean }> {
    return this.pages<GtmContainerInfo>(`${GTM_API}/${this.accountPath}/containers`, {}, { itemsKey: "container", maxRows: o.maxRows, partial: true });
  }

  /** workspaces.list. A container has few workspaces (standard accounts: 3); more than 100 is refused, never cut. */
  async listWorkspaces(): Promise<GtmWorkspace[]> {
    return (await this.pages<GtmWorkspace>(`${this.containerBase}/workspaces`, {}, { itemsKey: "workspace", maxRows: 100, what: "workspaces" })).items;
  }

  /**
   * The workspace this server writes into: named exactly "JackOfAds" with this server's description. None → null. One with
   * another description, or several, is a `conflict`: the server never writes into a workspace it cannot identify.
   */
  async findServerWorkspace(list?: GtmWorkspace[]): Promise<GtmWorkspace | null> {
    const all = list ?? (await this.listWorkspaces());
    const named = all.filter((w) => w.name === SERVER_WS_NAME);
    if (!named.length) return null;
    if (named.length > 1 || named[0]!.description !== SERVER_WS_DESCRIPTION || !named[0]!.workspaceId) {
      throw new ToolError(
        "conflict",
        `A Tag Manager workspace named ${SERVER_WS_NAME} exists that this server did not create (or there are several). Rename or delete it in Tag Manager. Nothing was changed.`,
        { definite: true },
      );
    }
    gtmIdOrFail(named[0]!.workspaceId!, "workspace");
    return named[0]!;
  }

  /** workspaces.getStatus: changed entities and merge conflicts. */
  async workspaceStatus(wsId: string): Promise<GtmStatus> {
    return this.read<GtmStatus>(`${this.workspaceUrl(wsId)}/status`);
  }

  listTags(wsId: string, o: ListOpts): Promise<{ items: GtmTag[]; truncated: boolean }> {
    return this.pages<GtmTag>(`${this.workspaceUrl(wsId)}/tags`, {}, { itemsKey: "tag", maxRows: o.maxRows, partial: o.partial, what: "tags" });
  }
  getTag(wsId: string, tagId: string): Promise<GtmTag> {
    return this.read<GtmTag>(`${this.workspaceUrl(wsId)}/tags/${gtmIdOrFail(tagId, "tag")}`);
  }
  listTriggers(wsId: string, o: ListOpts): Promise<{ items: GtmTrigger[]; truncated: boolean }> {
    return this.pages<GtmTrigger>(`${this.workspaceUrl(wsId)}/triggers`, {}, { itemsKey: "trigger", maxRows: o.maxRows, partial: o.partial, what: "triggers" });
  }
  getTrigger(wsId: string, triggerId: string): Promise<GtmTrigger> {
    return this.read<GtmTrigger>(`${this.workspaceUrl(wsId)}/triggers/${gtmIdOrFail(triggerId, "trigger")}`);
  }
  listVariables(wsId: string, o: ListOpts): Promise<{ items: GtmVariable[]; truncated: boolean }> {
    return this.pages<GtmVariable>(`${this.workspaceUrl(wsId)}/variables`, {}, { itemsKey: "variable", maxRows: o.maxRows, partial: o.partial, what: "variables" });
  }
  /** built_in_variables.list: "Lists all the enabled Built-In Variables". */
  listBuiltIns(wsId: string, o: ListOpts): Promise<{ items: GtmBuiltIn[]; truncated: boolean }> {
    return this.pages<GtmBuiltIn>(`${this.workspaceUrl(wsId)}/built_in_variables`, {}, { itemsKey: "builtInVariable", maxRows: o.maxRows, partial: o.partial, what: "built-in variables" });
  }

  /** versions.live: the published version, or null when Tag Manager answers not found (never published). */
  async liveVersion(): Promise<GtmVersion | null> {
    try {
      return await this.read<GtmVersion>(`${this.containerBase}/versions:live`);
    } catch (e) {
      if (e instanceof ToolError && e.code === "not_found") return null;
      throw e;
    }
  }
  getVersion(versionId: string): Promise<GtmVersion> {
    return this.read<GtmVersion>(this.versionUrl(versionId));
  }
  /** version_headers:latest, or null when the container has no version yet (not found, or no id in the answer). */
  async latestVersionHeader(): Promise<GtmVersionHeader | null> {
    try {
      const h = await this.read<GtmVersionHeader>(`${this.containerBase}/version_headers:latest`);
      return h.containerVersionId ? h : null;
    } catch (e) {
      if (e instanceof ToolError && e.code === "not_found") return null;
      throw e;
    }
  }
  /** The latest version (what a new workspace is expected to start from), or null when there is none. */
  async latestVersion(): Promise<GtmVersion | null> {
    const h = await this.latestVersionHeader();
    return h ? this.getVersion(h.containerVersionId!) : null;
  }

  /**
   * The entities of the server workspace, or (no server workspace yet) of the latest version, which is what a new workspace
   * is expected to start from. Full lists only: past `maxRows` the call is refused (row_cap), never cut.
   */
  async baseEntities(ws: GtmWorkspace | null, need: { tags?: boolean; triggers?: boolean; variables?: boolean; builtIns?: boolean }, maxRows = 5_000): Promise<BaseEntities> {
    if (ws) {
      const id = ws.workspaceId!;
      const o = { maxRows };
      return {
        base: "workspace",
        versionId: null,
        tags: need.tags ? (await this.listTags(id, o)).items : [],
        triggers: need.triggers ? (await this.listTriggers(id, o)).items : [],
        variables: need.variables ? (await this.listVariables(id, o)).items : [],
        builtIns: need.builtIns ? (await this.listBuiltIns(id, o)).items : [],
      };
    }
    const v = await this.latestVersion();
    const cap = <T>(xs: T[] | undefined, what: string): T[] => {
      if ((xs?.length ?? 0) > maxRows) throw tooManyRows(maxRows, what);
      return xs ?? [];
    };
    return {
      base: "latest_version",
      versionId: v?.containerVersionId ?? null,
      tags: need.tags ? cap(v?.tag, "tags") : [],
      triggers: need.triggers ? cap(v?.trigger, "triggers") : [],
      variables: need.variables ? cap(v?.variable, "variables") : [],
      builtIns: need.builtIns ? cap(v?.builtInVariable, "built-in variables") : [],
    };
  }

  // ---- mutations: each sent once through send(), never retried --------------------------------------------------------

  /** workspaces.create of the server workspace (name "JackOfAds", fixed description). */
  createWorkspace(): Promise<GtmWorkspace> {
    return this.send<GtmWorkspace>("POST", `${this.containerBase}/workspaces`, { name: SERVER_WS_NAME, description: SERVER_WS_DESCRIPTION });
  }
  createTag(wsId: string, body: GtmTag): Promise<GtmTag> {
    return this.send<GtmTag>("POST", `${this.workspaceUrl(wsId)}/tags`, body);
  }
  /** tags.update: PUT of the whole tag, guarded by the fingerprint just read ("must match the fingerprint of the tag in storage"). */
  updateTag(wsId: string, tagId: string, body: GtmTag, fingerprint: string): Promise<GtmTag> {
    return this.send<GtmTag>("PUT", `${this.workspaceUrl(wsId)}/tags/${gtmIdOrFail(tagId, "tag")}`, body, { fingerprint });
  }
  createTrigger(wsId: string, body: GtmTrigger): Promise<GtmTrigger> {
    return this.send<GtmTrigger>("POST", `${this.workspaceUrl(wsId)}/triggers`, body);
  }
  /** workspaces.create_version: body VersionOptions { name, notes }. Tag Manager deletes the workspace afterwards. */
  createVersion(wsId: string, o: { name: string; notes?: string }): Promise<CreateVersionResponse> {
    return this.send<CreateVersionResponse>("POST", `${this.workspaceUrl(wsId)}:create_version`, { name: o.name, ...(o.notes ? { notes: o.notes } : {}) });
  }
  /** versions.publish: empty body, guarded by the version's fingerprint. */
  publishVersion(versionId: string, fingerprint: string): Promise<PublishResponse> {
    return this.send<PublishResponse>("POST", `${this.versionUrl(versionId)}:publish`, undefined, { fingerprint });
  }
}

interface ListOpts {
  maxRows: number;
  partial?: boolean;
}

export interface BaseEntities {
  base: "workspace" | "latest_version";
  versionId: string | null;
  tags: GtmTag[];
  triggers: GtmTrigger[];
  variables: GtmVariable[];
  builtIns: GtmBuiltIn[];
}

/** The workspace this server creates and writes into. Any other workspace (the Default Workspace included) is never written. */
export const SERVER_WS_NAME = "JackOfAds";
export const SERVER_WS_DESCRIPTION = "Created by JackOfAds for approved changes. Do not edit here: changes made in this workspace are versioned by JackOfAds approvals.";

/** Tag Manager ids are digits. An id from a caller or from Google that is not is refused before it reaches a URL. */
export const GTM_ID = /^\d{1,20}$/;
export function gtmIdOrFail(id: string, what: string): string {
  if (!GTM_ID.test(id)) throw new ToolError("internal", `Refused a Tag Manager ${what} id that is not digits.`);
  return id;
}

/** Account and Container resources (tagmanager v2 reference): path, accountId / containerId, name, publicId. */
interface GtmAccount {
  path?: string;
  name?: string;
}
interface GtmContainer {
  path?: string;
  name?: string;
  publicId?: string;
}

/**
 * Connect-time discovery: accounts.list, then accounts.containers.list for each account (both page with pageToken).
 * An account whose containers answer not found or permission denied is skipped; other failures fail the connection.
 */
export async function discoverGtmContainers(api: GoogleApiClient): Promise<Discovery> {
  const { items: accounts } = await api.pages<GtmAccount>(`${GTM_API}/accounts`, {}, { itemsKey: "account", maxRows: HARD_ROW_CAP, partial: true });
  const out: Discovery["accounts"] = [];
  let skipped = 0;
  for (const a of accounts) {
    if (!a.path || !/^accounts\/\d{1,20}$/.test(a.path)) continue;
    let containers: GtmContainer[];
    try {
      containers = (await api.pages<GtmContainer>(`${GTM_API}/${a.path}/containers`, {}, { itemsKey: "container", maxRows: HARD_ROW_CAP, partial: true })).items;
    } catch (e) {
      if (e instanceof ToolError && (e.code === "not_found" || e.code === "platform_permission_denied")) {
        skipped++;
        continue;
      }
      throw e;
    }
    for (const c of containers) {
      if (!c.path || !isContainerPath(c.path)) continue;
      if (out.length >= MAX_DISCOVERED) {
        skipped++;
        continue;
      }
      const name = c.name ?? c.path;
      out.push({ externalId: c.path, displayName: `${c.publicId ? `${name} (${c.publicId})` : name}${a.name ? ` · ${a.name}` : ""}`, loginCustomerId: null, currencyCode: null, timeZone: null });
    }
  }
  return { accounts: out, skipped };
}
