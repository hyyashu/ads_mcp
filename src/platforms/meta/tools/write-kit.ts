import type { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { WriteTool } from "../../../mcp/tool";
import type { Change } from "../../../policy/change-set";
import { canonicalJson } from "../../../security/canonical";
import type { MetaAdsClient } from "../client";
import type { MetaServices } from "../services";
import { metaWrite } from "./common";

/**
 * The shape every state-based Meta write follows, mirroring the Google write kit:
 *   plan     read the live state, build the request and a change set (read-only)
 *   execute  read again; refuse if it differs from the approved snapshot; send ONE POST (never retried);
 *            read again and confirm the change landed, otherwise unknown_outcome
 *   verify   read the live state and decide applied / not_applied / indeterminate (crash recovery)
 * `read` must return plain JSON in a stable order and must not throw for missing or deleted objects, so the same read
 * serves verification; refusals belong in `build`. Meta documents no idempotency key for writes, so these guarantees
 * come from the approval key, the drift check and the read-back.
 */
export interface MetaStateWriteDef<I extends z.ZodObject, O extends z.ZodType, S> {
  name: string;
  title: string;
  risk: "write" | "high_impact" | "destructive";
  description: string;
  input: I;
  output: O;
  read(a: z.infer<I>, meta: MetaAdsClient): Promise<S>;
  /** Throw invalid_argument when nothing would change. `post` is the one Graph API write: path and form parameters. */
  build(a: z.infer<I>, s: S, meta: MetaAdsClient): { summary: string; changes: Change[]; post: { path: string; params: Record<string, string> } };
  landed(a: z.infer<I>, before: S, after: S): boolean;
  result(a: z.infer<I>, after: S, before: S): z.infer<O>;
}

export function metaStateWrite<I extends z.ZodObject, O extends z.ZodType, S>(d: MetaStateWriteDef<I, O, S>): WriteTool<I, O, MetaServices> {
  return metaWrite({
    name: d.name,
    title: d.title,
    risk: d.risk,
    description: d.description,
    input: d.input,
    output: d.output,
    plan: async (a, ctx) => {
      const s = await d.read(a, ctx.services.meta);
      const b = d.build(a, s, ctx.services.meta);
      return { summary: b.summary, snapshot: s, changes: b.changes };
    },
    verify: async (a, ctx, run) => {
      const now = await d.read(a, ctx.services.meta);
      if (d.landed(a, run.snapshot as S, now)) return { outcome: "applied" };
      return canonicalJson(now) === canonicalJson(run.snapshot) ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: "the state changed, but not to the requested result" };
    },
    execute: async (a, ctx, run) => {
      const m = ctx.services.meta;
      const s = await d.read(a, m);
      if (canonicalJson(s) !== canonicalJson(run.snapshot)) throw new ToolError("conflict", "The ad account changed since this was requested. Nothing was applied; request the change again.");
      const { post } = d.build(a, s, m);
      await m.post(post.path, post.params);
      // The live state decides, not Meta's {success: true} body.
      const after = await d.read(a, m);
      if (!d.landed(a, s, after)) throw new ToolError("unknown_outcome", "Meta accepted the request but the ad account does not read back as requested.");
      return d.result(a, after, s);
    },
  });
}

/** Identity helper that gives a definition its contextual types, so it can be shared (e.g. by catalog variants of a tool). */
export const stateDef = <I extends z.ZodObject, O extends z.ZodType, S>(d: MetaStateWriteDef<I, O, S>): MetaStateWriteDef<I, O, S> => d;
