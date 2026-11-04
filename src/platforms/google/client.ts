import { ToolError } from "../../mcp/errors";
import { type GoogleAdsHttp } from "./http";
import { Gaql } from "./gaql";

export type Row = Record<string, unknown>;
const HARD_ROW_CAP = 10_000;

/**
 * One Google Ads account, reached with the connecting user's credentials. Reads fetch on demand and are retried on
 * transient failures; mutations are sent once and never retried automatically (see GoogleAdsHttp).
 */
export class GoogleAdsClient {
  constructor(
    private o: {
      http: GoogleAdsHttp;
      /** The account being acted on (digits only). */
      customerId: string;
      /** Manager account to act through, if any. Per account, never global. */
      loginCustomerId: string | null;
      getAccessToken: () => Promise<string>;
      signal?: AbortSignal;
    },
  ) {}

  get customerId() {
    return this.o.customerId;
  }

  private sent = 0;
  /** How many changes this client has attempted to send (validate-only requests do not count). */
  get mutationsSent(): number {
    return this.sent;
  }

  /** A cancelled or timed-out call must not start a new mutation: stop before sending, which is a definite "nothing changed". */
  private assertNotAborted() {
    if (this.o.signal?.aborted) throw new ToolError("deadline_exceeded", "Stopped before sending the change: the call was cancelled or ran past its time limit. Nothing was changed.");
  }

  private async base() {
    return { accessToken: await this.o.getAccessToken(), loginCustomerId: this.o.loginCustomerId, signal: this.o.signal };
  }

  /** Runs a GAQL query and follows pagination up to maxRows (hard cap 10,000). */
  async query(q: Gaql | string, opts: { maxRows?: number } = {}): Promise<Row[]> {
    const maxRows = Math.min(opts.maxRows ?? 1000, HARD_ROW_CAP);
    const query = typeof q === "string" ? q : q.toString();
    const rows: Row[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.o.http.call<{ results?: Row[]; nextPageToken?: string }>({
        ...(await this.base()),
        path: `customers/${this.o.customerId}/googleAds:search`,
        body: { query, ...(pageToken ? { pageToken } : {}) },
        idempotent: true,
      });
      rows.push(...(res.results ?? []));
      pageToken = res.nextPageToken || undefined;
    } while (pageToken && rows.length < maxRows);
    return rows.slice(0, maxRows);
  }

  /**
   * Sends mutate operations to one resource service, e.g. mutate("campaigns", [{ update: {...}, updateMask: "status" }]).
   * With validateOnly the API checks the request and changes nothing, so it is safe to retry.
   */
  async mutate(service: string, operations: Row[], opts: { validateOnly?: boolean; partialFailure?: boolean } = {}): Promise<{ results: Row[]; partialFailureError?: unknown }> {
    if (!/^[a-zA-Z]+$/.test(service)) throw new ToolError("internal", "invalid mutate service");
    if (operations.length === 0 || operations.length > 5000) throw new ToolError("invalid_argument", "a mutate needs between 1 and 5000 operations");
    // Credentials first: a token failure happens before anything is sent, so it must not count as a sent change.
    const base = await this.base();
    this.assertNotAborted();
    if (!opts.validateOnly) this.sent++; // counted right before sending: a failure after this point may have changed something
    const res = await this.o.http.call<{ results?: Row[]; partialFailureError?: unknown }>({
      ...base,
      path: `customers/${this.o.customerId}/${service}:mutate`,
      body: { operations, ...(opts.validateOnly ? { validateOnly: true } : {}), ...(opts.partialFailure ? { partialFailure: true } : {}) },
      idempotent: !!opts.validateOnly,
    });
    return { results: res.results ?? [], partialFailureError: res.partialFailureError };
  }

  /**
   * GoogleAdsService.Mutate: one atomic request that may touch several resource types, using temporary resource names
   * to link new objects (e.g. budget + campaign + ad group). Used for campaign creation so a failure leaves nothing behind.
   */
  async mutateBatch(mutateOperations: Row[], opts: { validateOnly?: boolean } = {}): Promise<{ mutateOperationResponses: Row[] }> {
    if (mutateOperations.length === 0 || mutateOperations.length > 10_000) throw new ToolError("invalid_argument", "a batch needs between 1 and 10000 operations");
    const base = await this.base();
    this.assertNotAborted();
    if (!opts.validateOnly) this.sent++;
    const res = await this.o.http.call<{ mutateOperationResponses?: Row[] }>({
      ...base,
      path: `customers/${this.o.customerId}/googleAds:mutate`,
      body: { mutateOperations, ...(opts.validateOnly ? { validateOnly: true } : {}) },
      idempotent: !!opts.validateOnly,
    });
    return { mutateOperationResponses: res.mutateOperationResponses ?? [] };
  }
}
