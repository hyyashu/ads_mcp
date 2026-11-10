import { ToolError } from "../../mcp/errors";
import { type GoogleAdsHttp } from "./http";
import { Gaql } from "./gaql";

export type Row = Record<string, unknown>;
const HARD_ROW_CAP = 10_000;

/** The error for a read that matched more rows than the tool can safely work with. Nothing was changed. */
export function tooManyRows(cap: number, what: string): ToolError {
  return new ToolError("unsupported", `This needs more than ${cap.toLocaleString("en-US")} ${what} rows, which is more than this tool reads in one call, so it stopped rather than work from a partial list. Narrow the request (for example to fewer campaigns or a shorter period) and try again. Nothing was changed.`, { definite: true, details: { reason: "row_cap", cap, resource: what } });
}

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

  /**
   * Runs a GAQL query and follows pagination up to maxRows (hard cap 10,000).
   *
   * Rows are never dropped silently. When the query matches more than maxRows rows, the call fails with `unsupported`,
   * because a caller that uses the rows as the full picture (totals, duplicate checks, the state a change is planned on)
   * would otherwise be wrong without knowing it. A caller that shows a page and reports `truncated` itself passes
   * `partial: true` to get the first maxRows rows (it asks for one extra row to detect the cut).
   */
  async query(q: Gaql | string, opts: { maxRows?: number; partial?: boolean } = {}): Promise<Row[]> {
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
    } while (pageToken && rows.length <= maxRows);
    if (!opts.partial && (rows.length > maxRows || pageToken)) throw tooManyRows(maxRows, /\bFROM\s+([a-z_]+)/i.exec(query)?.[1] ?? "rows");
    return rows.slice(0, maxRows);
  }

  /**
   * Sends a mutating RPC that is not part of GoogleAdsService.Mutate, e.g. "customers/{customer}/productLinks:create".
   * Counted and never retried, exactly like mutate().
   */
  async sendRpc<T = Row>(path: string, body: Row): Promise<T> {
    const p = path.replace("{customer}", this.o.customerId);
    // Also the services whose Mutate takes a single `operation` (not `operations`), and CustomerService.CreateCustomerClient.
    if (!new RegExp(`^customers/${this.o.customerId}(/[A-Za-z]+:(create|remove|update)|/(customerUserAccesses|customerUserAccessInvitations|customerClientLinks):mutate|:createCustomerClient)$`).test(p)) throw new ToolError("internal", "invalid mutating rpc path");
    const base = await this.base();
    this.assertNotAborted();
    this.sent++;
    return this.o.http.call<T>({ ...base, path: p, body, idempotent: false });
  }

  /**
   * Calls a read-only RPC that is not a GAQL search, e.g. "geoTargetConstants:suggest" or
   * "customers/{id}:generateKeywordIdeas" (pass `{customer}` to have the account id filled in). Retried like reads.
   * Never use it for anything that changes an account: those go through mutate().
   */
  async rpc<T = Row>(path: string, body: Row): Promise<T> {
    const p = path.replace("{customer}", this.o.customerId);
    if (!/^(customers\/\d+[:/])?[A-Za-z/0-9]*:?[A-Za-z]+$/.test(p) || /:mutate$/i.test(p)) throw new ToolError("internal", "invalid read-only rpc path");
    return this.o.http.call<T>({ ...(await this.base()), path: p, body, idempotent: true });
  }

  /**
   * A read-only REST GET on this account, e.g. get("invoices", { billingSetup, issueYear, issueMonth }) for
   * InvoiceService.ListInvoices (GET customers/{id}/invoices). Retried like reads.
   */
  async get<T = Row>(collection: string, params: Record<string, string>): Promise<T> {
    if (!/^[A-Za-z]+$/.test(collection)) throw new ToolError("internal", "invalid read-only collection");
    const qs = new URLSearchParams(params).toString();
    return this.o.http.call<T>({ ...(await this.base()), path: `customers/${this.o.customerId}/${collection}${qs ? `?${qs}` : ""}`, method: "GET", idempotent: true });
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
