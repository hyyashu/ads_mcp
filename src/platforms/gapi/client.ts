import { ToolError } from "../../mcp/errors";
import type { GoogleApiHttp, Params } from "./http";

export type Row = Record<string, unknown>;
/** No list is read past this many rows in one call, whatever a tool asks for. */
export const HARD_ROW_CAP = 10_000;
/** Safety stop for an API that keeps returning page tokens with empty pages. */
const MAX_PAGES = 1_000;

/** The error for a read that matched more rows than the tool can safely work with (same convention as the ads clients). */
export function tooManyRows(cap: number, what: string): ToolError {
  return new ToolError(
    "unsupported",
    `This needs more than ${cap.toLocaleString("en-US")} ${what}, which is more than this tool reads in one call, so it stopped rather than work from a partial list. Narrow the request (for example a shorter period or a filter) and try again. Nothing was changed.`,
    { definite: true, details: { reason: "row_cap", cap, resource: what } },
  );
}

export interface GoogleApiClientOptions {
  http: GoogleApiHttp;
  /** Fresh access token for this account's connection. Never stored on the client or returned to a handler. */
  getAccessToken: () => Promise<string>;
  /** The tool call's signal: cancellation and deadlines reach the upstream requests. */
  signal?: AbortSignal;
}

/**
 * Shared base of the Search Console, GA4 and Tag Manager clients: one account of one product, reached with the connecting
 * user's credentials. Product clients add their own methods on top of read / query / send / pages.
 */
export class GoogleApiClient {
  constructor(protected o: GoogleApiClientOptions) {}

  private sent = 0;
  /** How many changes this client has attempted to send. Zero means nothing reached Google (the executor relies on it). */
  get mutationsSent(): number {
    return this.sent;
  }

  /** GET that only reads. Retried on transient failures. */
  async read<T = Row>(url: string, params?: Params): Promise<T> {
    return this.o.http.call<T>({ accessToken: await this.o.getAccessToken(), url, params, idempotent: true, signal: this.o.signal });
  }

  /** POST that only reads (searchAnalytics.query, runReport, urlInspection). Retried like a read: never use it for a change. */
  async query<T = Row>(url: string, body: unknown, params?: Params): Promise<T> {
    return this.o.http.call<T>({ accessToken: await this.o.getAccessToken(), method: "POST", url, params, body, idempotent: true, signal: this.o.signal });
  }

  /**
   * A change. Sent exactly once and never retried: a failure after sending is `unknown_outcome` (GoogleApiHttp), which the
   * approval service reconciles with the tool's verify(). Credentials are fetched first and the abort signal checked, so a
   * token failure or a cancelled call stops before anything is sent and counts as nothing sent.
   */
  async send<T = Row>(method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown, params?: Params): Promise<T> {
    const accessToken = await this.o.getAccessToken();
    if (this.o.signal?.aborted) throw new ToolError("deadline_exceeded", "Stopped before sending the change: the call was cancelled or ran past its time limit. Nothing was changed.");
    this.sent++; // counted right before sending: a failure after this point may have changed something
    return this.o.http.call<T>({ accessToken, method, url, params, body, idempotent: false, signal: this.o.signal });
  }

  /**
   * Reads a list that pages with `pageToken` / `nextPageToken`, collecting `itemsKey` from each page, up to maxRows
   * (at most HARD_ROW_CAP). Rows are never dropped silently: past maxRows the call fails with `unsupported`
   * (details.reason "row_cap"), because a caller using the list as the full picture would otherwise be wrong without knowing.
   * A caller that shows a page and reports `truncated` itself passes `partial: true` and gets the first maxRows rows.
   */
  async pages<T = Row>(url: string, params: Params, o: { itemsKey: string; maxRows: number; partial?: boolean; what?: string }): Promise<{ items: T[]; truncated: boolean }> {
    const maxRows = Math.max(1, Math.min(o.maxRows, HARD_ROW_CAP));
    const items: T[] = [];
    let pageToken: string | undefined;
    let n = 0;
    do {
      const res = await this.read<Row>(url, { ...params, ...(pageToken ? { pageToken } : {}) });
      const got = res[o.itemsKey];
      if (got !== undefined && !Array.isArray(got)) throw new ToolError("internal", "The Google API returned a list in an unexpected shape.");
      items.push(...((got ?? []) as T[]));
      pageToken = typeof res.nextPageToken === "string" && res.nextPageToken ? res.nextPageToken : undefined;
    } while (pageToken && items.length <= maxRows && ++n < MAX_PAGES);
    const truncated = items.length > maxRows || !!pageToken;
    if (truncated && !o.partial) throw tooManyRows(maxRows, o.what ?? `${o.itemsKey} rows`);
    return { items: items.slice(0, maxRows), truncated };
  }
}
