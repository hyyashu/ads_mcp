import type { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { WriteTool } from "../../../mcp/tool";
import type { Change } from "../../../policy/change-set";
import { canonicalJson } from "../../../security/canonical";
import type { GoogleAdsClient, Row } from "../client";
import type { GoogleServices } from "../services";
import { googleWrite } from "./common";
import { type ImageFieldType, prepareImage } from "../media";

/**
 * The shape every state-based Google write follows (M7):
 *   plan     read the live state, compute operations and a change set (read-only)
 *   execute  read again; refuse if it differs from the approved snapshot; send ONE atomic GoogleAdsService.Mutate;
 *            read again and confirm the change landed, otherwise unknown_outcome
 *   verify   read the live state and decide applied / not_applied / indeterminate (crash recovery)
 * `read` must return plain JSON in a stable order: it is the snapshot that drift detection compares.
 */
export interface StateWriteDef<I extends z.ZodObject, O extends z.ZodType, S> {
  name: string;
  title: string;
  risk: "write" | "high_impact" | "destructive";
  description: string;
  input: I;
  output: O;
  timeoutMs?: number;
  /** `svc` gives access to the image fetcher for tools that upload images (see withImages). */
  read(a: z.infer<I>, ads: GoogleAdsClient, svc: GoogleServices): Promise<S>;
  /** Throw invalid_argument when nothing would change. `ops` are GoogleAdsService MutateOperations. */
  /** `rpc` instead of `ops` for services outside GoogleAdsService.Mutate (sent once with sendRpc). */
  build(a: z.infer<I>, s: S, ads: GoogleAdsClient): { summary: string; changes: Change[]; ops: Row[]; rpc?: { path: string; body: Row } };
  /** True when the live state `after` shows the whole change applied (given the approved state `before`). */
  landed(a: z.infer<I>, before: S, after: S): boolean;
  result(a: z.infer<I>, after: S, responses: Row[], before: S): z.infer<O>;
}

export function stateWrite<I extends z.ZodObject, O extends z.ZodType, S>(d: StateWriteDef<I, O, S>): WriteTool<I, O, GoogleServices> {
  return googleWrite({
    name: d.name,
    title: d.title,
    risk: d.risk,
    description: d.description,
    input: d.input,
    output: d.output,
    ...(d.timeoutMs ? { timeoutMs: d.timeoutMs } : {}),
    plan: async (a, ctx) => {
      const s = await d.read(a, ctx.services.ads, ctx.services);
      const b = d.build(a, s, ctx.services.ads);
      if (!b.ops.length && !b.rpc) throw new ToolError("invalid_argument", "Nothing would change.");
      return { summary: b.summary, snapshot: s, changes: b.changes };
    },
    verify: async (a, ctx, run) => {
      const now = await d.read(a, ctx.services.ads, ctx.services);
      if (d.landed(a, run.snapshot as S, now)) return { outcome: "applied" };
      return canonicalJson(now) === canonicalJson(run.snapshot) ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: "the state changed, but not to the requested result" };
    },
    execute: async (a, ctx, run) => {
      const ads = ctx.services.ads;
      const s = await d.read(a, ads, ctx.services);
      if (canonicalJson(s) !== canonicalJson(run.snapshot)) throw new ToolError("conflict", "The account changed since this was requested. Nothing was applied; request the change again.");
      const { ops, rpc } = d.build(a, s, ads);
      const res = rpc ? { mutateOperationResponses: [await ads.sendRpc(rpc.path, rpc.body)] } : await ads.mutateBatch(ops); // one atomic request: all operations or none
      const after = await d.read(a, ads, ctx.services);
      if (!d.landed(a, s, after)) throw new ToolError("unknown_outcome", "Google accepted the request but the account does not read back as requested.");
      return d.result(a, after, res.mutateOperationResponses ?? [], s);
    },
  });
}

/** customers/{id}/{collection}/{id} */
export const rn = (ads: GoogleAdsClient, collection: string, id: string) => `customers/${ads.customerId}/${collection}/${id}`;
/** Temporary resource name for an object created in the same batch (negative ids are batch-local). */
export const temp = (ads: GoogleAdsClient, collection: string, n: number) => `customers/${ads.customerId}/${collection}/-${n}`;

/**
 * Downloads and checks images for a write. Returns their SHA-256 hashes, which belong in the state returned by `read`
 * (so the approved snapshot pins the exact bytes; a changed image is refused as drift at execution), and attaches the
 * base64 data to `state` as a non-enumerable property that is never stored or compared.
 */
export async function withImages<S extends object>(state: S, svc: GoogleServices, images: { url: string; field: ImageFieldType }[]): Promise<S & { image_sha256: Record<string, string> }> {
  const hashes: Record<string, string> = {};
  const data = new Map<string, { data: string; mime: string }>();
  for (const im of images) {
    const p = await prepareImage(svc.fetchImage, im.url, im.field);
    hashes[im.url] = p.info.sha256;
    data.set(im.url, { data: p.data, mime: p.info.mime });
  }
  const out = Object.assign(state, { image_sha256: hashes });
  Object.defineProperty(out, "__imageData", { value: data, enumerable: false });
  return out;
}
/** The downloaded image for a URL (after withImages). */
export function imageData(state: object, url: string): { data: string; mime: string } {
  const d = (state as { __imageData?: Map<string, { data: string; mime: string }> }).__imageData?.get(url);
  if (!d) throw new ToolError("internal", "image data missing");
  return d;
}
