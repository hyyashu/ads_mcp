import type { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { VerifyResult, WriteTool } from "../../../mcp/tool";
import type { Change } from "../../../policy/change-set";
import { canonicalJson } from "../../../security/canonical";
import { type BaseEntities, type GtmClient, SERVER_WS_NAME, gtmIdOrFail } from "../client";
import type { GtmServices } from "../services";
import type { GtmBuiltIn, GtmVariable, GtmWorkspace } from "../types";
import { gtmWrite } from "./common";

/**
 * The shape every Tag Manager write follows (mirrors google/tools/write-kit.ts):
 *   plan     read (read-only) → validate → summary, JSON-stable snapshot and change set
 *   execute  read again and refuse on any difference from the approved snapshot (conflict, nothing sent); apply the
 *            mutation(s), each sent once; read back and confirm, otherwise unknown_outcome (never retried)
 *   verify   read and decide applied / not_applied / indeterminate (crash recovery)
 * Requests are rate limited server-wide by the services factory (beforeCall): a refused request is quota_exceeded, nothing sent.
 */
export interface GtmWriteDef<I extends z.ZodObject, O extends z.ZodType, S> {
  name: string;
  title: string;
  risk: "write" | "high_impact" | "destructive";
  description: string;
  input: I;
  output: O;
  /** The one OAuth scope the method needs (documented on its reference page). */
  scope: string;
  read(a: z.infer<I>, gtm: GtmClient): Promise<S>;
  /** Validates (invalid_argument) and describes the change. */
  build(a: z.infer<I>, s: S): { summary: string; changes: Change[] };
  /** Sends the mutation(s) and confirms them by reading back. Errors after a send must be unknown_outcome unless Google refused. */
  apply(a: z.infer<I>, s: S, gtm: GtmClient): Promise<z.infer<O>>;
  verify(a: z.infer<I>, before: S, gtm: GtmClient): Promise<VerifyResult>;
}

export function gtmStateWrite<I extends z.ZodObject, O extends z.ZodType, S>(d: GtmWriteDef<I, O, S>): WriteTool<I, O, GtmServices> {
  return gtmWrite({
    name: d.name,
    title: d.title,
    risk: d.risk,
    description: d.description,
    input: d.input,
    output: d.output,
    permissions: { platformPermissions: [d.scope] },
    plan: async (a, ctx) => {
      const s = await d.read(a, ctx.services.gtm);
      const b = d.build(a, s);
      return { summary: b.summary, snapshot: s, changes: b.changes };
    },
    verify: async (a, ctx, run) => d.verify(a, run.snapshot as S, ctx.services.gtm),
    execute: async (a, ctx, run) => {
      const gtm = ctx.services.gtm;
      const s = await d.read(a, gtm);
      if (canonicalJson(s) !== canonicalJson(run.snapshot)) throw new ToolError("conflict", "The Tag Manager container changed since this was requested. Nothing was applied; request the change again.", { definite: true });
      d.build(a, s); // same state as approved: re-validates without side effects
      return d.apply(a, s, gtm);
    },
  });
}

/** Any failure while confirming a change that was sent: the outcome is unknown, never a definite failure. */
export async function confirmAfterSend<T>(what: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ToolError && e.code === "unknown_outcome") throw e;
    throw new ToolError("unknown_outcome", `Tag Manager accepted the ${what}, but reading it back failed (${e instanceof Error ? e.message : "error"}). Check get_gtm_workspace_status before retrying.`);
  }
}

/** Reads the entities a draft write validates against: the server workspace, or the latest version when it does not exist. */
export async function draftBase(gtm: GtmClient, need: { tags?: boolean; triggers?: boolean; variables?: boolean; builtIns?: boolean }): Promise<BaseEntities & { ws: GtmWorkspace | null; workspaceCount: number }> {
  const all = await gtm.listWorkspaces();
  const ws = await gtm.findServerWorkspace(all);
  return { ws, workspaceCount: all.length, ...(await gtm.baseEntities(ws, need)) };
}

/** Fields of a draft-write state that say where the state was read, not what it contains. */
export interface DraftLocation {
  workspace_id: string | null;
  base: "workspace" | "latest_version";
  base_version_id: string | null;
  /** Workspaces in the container when the server has none yet (standard containers allow 3), else null. */
  workspaces: number | null;
}
export const location = (b: Awaited<ReturnType<typeof draftBase>>): DraftLocation => ({ workspace_id: b.ws?.workspaceId ?? null, base: b.base, base_version_id: b.versionId, workspaces: b.ws ? null : b.workspaceCount });
const content = <S extends DraftLocation>(s: S) => {
  const { workspace_id: _w, base: _b, base_version_id: _v, workspaces: _n, ...rest } = s;
  return canonicalJson(rest);
};

/** Summary prefix when the server workspace does not exist yet. */
export const wsPrefix = (s: DraftLocation) =>
  s.workspace_id
    ? ""
    : `Tag Manager workspace '${SERVER_WS_NAME}' will be created first (from the latest version${s.base_version_id ? ` ${s.base_version_id}` : ""}).${(s.workspaces ?? 0) >= 3 ? ` Warning: the container already has ${s.workspaces} workspaces; standard containers allow the Default Workspace and 2 more, so creating it may fail.` : ""} `;
export const wsLabel = (s: DraftLocation) => `workspace ${SERVER_WS_NAME}${s.workspace_id ? ` (id ${s.workspace_id})` : ""}`;

/**
 * The server workspace to write into. When the plan found none, it is created here (execute only), then the state is read
 * again inside it and must hold the same content the approval was based on; otherwise nothing more is sent (conflict). Any
 * failure before the requested change is sent is definite: the workspace may exist, but the change itself was not sent.
 */
export async function inServerWorkspace<S extends DraftLocation>(gtm: GtmClient, s: S, reread: () => Promise<S>): Promise<{ wsId: string; created: boolean; state: S }> {
  if (s.workspace_id) return { wsId: s.workspace_id, created: false, state: s };
  let ws: GtmWorkspace;
  try {
    ws = await gtm.createWorkspace();
  } catch (e) {
    if (e instanceof ToolError && ["invalid_argument", "conflict", "platform_permission_denied", "unsupported"].includes(e.code)) {
      throw new ToolError(e.code, `Tag Manager refused to create the ${SERVER_WS_NAME} workspace: ${e.message} Standard containers allow the Default Workspace and 2 more; delete or version an unused workspace in Tag Manager. Nothing was changed.`, { definite: true });
    }
    throw e;
  }
  const wsId = gtmIdOrFail(String(ws.workspaceId ?? ""), "workspace");
  const before = `The ${SERVER_WS_NAME} workspace was created (id ${wsId}), but the change itself was not sent`;
  let state: S;
  try {
    state = await reread();
  } catch (e) {
    const err = e instanceof ToolError ? e : new ToolError("internal", "Unexpected error.");
    throw new ToolError(err.code === "unknown_outcome" ? "transient" : err.code, `${before}: ${err.message}`, { ...err.opts, definite: true });
  }
  if (state.workspace_id !== wsId || content(state) !== content(s)) {
    throw new ToolError("conflict", `${before}: the new workspace does not hold what the approval was based on (the container changed). Request the change again; the empty workspace will be reused.`, { definite: true });
  }
  return { wsId, created: true, state };
}

/** Variable references must name a user-defined variable or an enabled built-in variable. */
export function resolveRefs(refs: string[], variables: GtmVariable[], builtIns: GtmBuiltIn[]): { known: string[]; unknown: string[] } {
  const names = new Set([...variables.map((v) => v.name ?? ""), ...builtIns.map((b) => b.name ?? "")]);
  const uniq = [...new Set(refs)].sort();
  return { known: uniq.filter((r) => names.has(r)), unknown: uniq.filter((r) => !names.has(r)) };
}
export function refuseUnknownRefs(unknown: string[]) {
  if (unknown.length) throw new ToolError("invalid_argument", `Unknown variable(s): ${unknown.map((u) => `{{${u}}}`).join(", ")}. Use names from list_gtm_variables (user-defined or enabled built-in variables).`);
}

export const NEXT_STEP_TAG = "Create a version with create_gtm_version, then publish it with publish_gtm_version.";
export const q = (s: string) => JSON.stringify(s);
