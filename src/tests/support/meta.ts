/**
 * Shared pieces of the fake Meta Graph API used by the tests in src/tests/meta. Each test file keeps its own fake
 * `fetch` (they model different behaviour: reads, Page tokens, POSTs that create objects); this module holds only what
 * they all repeated: JSON responses, Meta's "does not exist" error, cursor paging and the pipeline wiring.
 */
import type { FetchLike, MetaTokenProvider } from "../../auth/token-providers";
import type { Db } from "../../db";
import { loadInventory } from "../../inventory";
import type { PipelineDeps } from "../../mcp/pipeline";
import { ToolRegistry } from "../../mcp/registry";
import { allTools } from "../../platforms";
import { MetaGraphHttp } from "../../platforms/meta/http";
import { createServicesFactory } from "../../platforms/services";
import { ApprovalService } from "../../security/approvals";
import { RateLimiter } from "../../security/rate-limit";

type Row = Record<string, unknown>;

/** A JSON response, as the Graph API sends it. */
export const J = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

/** Graph API error 100/33: the object does not exist (or the token cannot see it). */
export const metaNotFound = () => J({ error: { code: 100, error_subcode: 33, message: "does not exist" } }, 400);

/**
 * Cursor pagination as Meta does it: `limit` rows per page, an opaque `after` cursor, and `next` only when more pages
 * exist (the client must follow the cursor, never the `next` URL). With `summary`, a `summary=total_count` request also
 * gets the total.
 */
export function metaPage(rows: Row[], p: URLSearchParams, o: { summary?: boolean } = {}) {
  const limit = Number(p.get("limit") ?? 25);
  const off = Number(p.get("after") ?? 0);
  const more = off + limit < rows.length;
  return J({
    data: rows.slice(off, off + limit),
    paging: { cursors: { after: String(off + limit) }, ...(more ? { next: "https://graph.facebook.com/next?access_token=SHOULD_NOT_BE_USED" } : {}) },
    ...(o.summary && p.get("summary") === "total_count" ? { summary: { total_count: rows.length } } : {}),
  });
}

/** Pipeline dependencies wired to a fake Graph API, with the real registry, approvals and generous rate limits. */
export function metaDeps(
  db: Db,
  o: { fetch: FetchLike; tokens: unknown; apiVersion?: string; fetchImage?: (url: string) => Promise<Buffer> },
): PipelineDeps {
  return {
    db,
    registry: new ToolRegistry(loadInventory()).registerAll(allTools()),
    approvals: new ApprovalService(db),
    tenantLimiter: new RateLimiter(10_000, 10_000),
    accountLimiter: new RateLimiter(10_000, 10_000),
    createServices: createServicesFactory({
      db,
      meta: { tokens: o.tokens as MetaTokenProvider, http: new MetaGraphHttp({ apiVersion: o.apiVersion ?? "v27.0", fetch: o.fetch, sleep: async () => {} }) },
      ...(o.fetchImage ? { fetchImage: o.fetchImage } : {}),
    }),
  };
}
