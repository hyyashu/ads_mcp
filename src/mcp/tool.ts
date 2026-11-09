import type { Change } from "../policy/change-set";
import type { z } from "zod";
import type { Platform } from "../inventory";

/** read: never modifies anything. The others always go through server-verified approval. */
export type Risk = "read" | "write" | "high_impact" | "destructive";

export interface Permissions {
  /** Our own scope the caller's token must carry. */
  scope: "ads:read" | "ads:write";
  /** What the platform OAuth grant must include, e.g. Google "https://www.googleapis.com/auth/adwords", Meta "ads_management". */
  platformPermissions: string[];
  /** Anything else a developer or operator must know (API tier, extra product access, ...). */
  notes?: string;
}

export interface ResolvedAccount {
  id: string;
  platform: Platform;
  externalId: string;
  loginCustomerId: string | null;
  access: "read" | "write";
  /** Reporting units as the platform reported them at connect time. Null when the platform did not report them. */
  currencyCode: string | null;
  timeZone: string | null;
}

/** What tenant-level tools (accountScope "none") receive as `ctx.services`. */
export interface InternalServices {
  db: import("../db").Db;
}

/** Another account of this workspace, with the platform clients built for it (no tokens). */
export interface OtherAccount<S = unknown> {
  account: ResolvedAccount & { name: string };
  services: S;
}

/** Everything a handler needs. Handlers never see raw tokens: they receive platform clients built by the server. */
export interface ToolContext<S = unknown> {
  tenantId: string;
  userId: string;
  account: ResolvedAccount | null;
  services: S;
  signal: AbortSignal;
  /**
   * The accounts of `platform` linked to this tool's account on the Connections page (table account_link), each with its
   * services, in a stable order (name, then platform id). Empty when none is linked. Read access is enough; a linked account whose
   * connection was revoked or expired fails with auth_expired naming it, rather than being left out silently. Only for
   * account-scoped tools (throws `internal` when the tool has no account).
   */
  linked<T = unknown>(platform: Platform): Promise<OtherAccount<T>[]>;
  /**
   * An account the caller named explicitly (e.g. a `property_account_id` argument): this server's id or the platform's own
   * id, resolved within this workspace and platform only. Ids of other workspaces and unknown ids are `not_found`.
   */
  accountFor<T = unknown>(platform: Platform, accountId: string): Promise<OtherAccount<T>>;
}

interface Base<I extends z.ZodObject, O extends z.ZodType, S> {
  /** Exact name from the inventory. */
  name: string;
  platform: Platform;
  title: string;
  description: string;
  /** Must contain `account_id` unless accountScope is "none". Arrays must be bounded (maxItems). */
  input: I;
  /** Schema of the data returned on success. The server wraps it in the common envelope. */
  output: O;
  permissions: Permissions;
  accountScope?: "required" | "none";
  /** Deadline for one call in ms. Defaults: 30s for reads and planning, 60s for executing an approved change. */
  timeoutMs?: number;
  _services?: S;
}

export interface ReadTool<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType, S = unknown> extends Base<I, O, S> {
  kind: "read";
  handler(args: z.infer<I>, ctx: ToolContext<S>): Promise<z.infer<O>>;
}

export interface WriteTool<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType, S = unknown> extends Base<I, O, S> {
  kind: "write";
  risk: Exclude<Risk, "read">;
  /**
   * Runs at request time, READ-ONLY: validates the arguments against live platform state and returns the plain-language
   * summary an approver will see, a snapshot used to detect drift before executing, and optionally `changes` (each field
   * that would change, read live). With `changes`, the approval's risk follows the direction of the change
   * (policy/risk.ts) and the change set is stored with the approval and shown to approvers.
   */
  plan(args: z.infer<I>, ctx: ToolContext<S>): Promise<{ summary: string; snapshot?: unknown; changes?: Change[] }>;
  /**
   * Crash recovery. After an ambiguous failure (timeout, 5xx, process crash) the outcome is unknown and the change is
   * NEVER retried blindly. The server calls verify() to read the platform's current state and decide: did the change
   * land (`applied`), provably not (`not_applied`), or can't we tell (`indeterminate`)? Neither Google Ads nor Meta
   * offers request-id based idempotency, so verification compares live state with the plan snapshot and the intended result.
   */
  verify(args: z.infer<I>, ctx: ToolContext<S>, run: { snapshot: unknown }): Promise<VerifyResult>;
  /** Runs only after a human approved. Must be idempotent for the same idempotencyKey and must only report success on API confirmation. */
  execute(args: z.infer<I>, ctx: ToolContext<S>, run: { idempotencyKey: string; snapshot: unknown }): Promise<z.infer<O>>;
}

export type VerifyResult = { outcome: "applied" | "not_applied" | "indeterminate"; detail?: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ReadTool<any, any, any> | WriteTool<any, any, any>;

export const riskOf = (t: AnyTool): Risk => (t.kind === "read" ? "read" : t.risk);
