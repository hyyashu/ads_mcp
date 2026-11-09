import { ToolError } from "../../mcp/errors";
import type { MetaGraphHttp } from "./http";

export type MetaRow = Record<string, unknown>;
const HARD_ROW_CAP = 5_000;

/** The error for an edge that holds more rows than the tool can safely work with. Nothing was changed. */
function tooManyRows(cap: number, path: string): ToolError {
  const edge = path.split("/").pop() ?? "rows";
  return new ToolError("unsupported", `This needs more than ${cap.toLocaleString("en-US")} ${edge} rows, which is more than this tool reads in one call, so it stopped rather than work from a partial list. Narrow the request (for example to one campaign) and try again. Nothing was changed.`, { definite: true, details: { reason: "row_cap", cap, edge } });
}

/**
 * Currencies whose Marketing API offset is 1 (amounts are whole units). Every other supported currency has offset 100
 * (amounts are in 1/100 of the unit). Source: Marketing API "Currencies" reference, checked 2026-11-04.
 */
const OFFSET_1 = new Set(["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"]);
export const currencyOffset = (currency: string | null): number | null => (currency ? (OFFSET_1.has(currency.toUpperCase()) ? 1 : 100) : null);

/** Meta money (budgets, bids, spend caps: strings in the currency's minor unit) to account-currency units. */
export function fromMinor(v: unknown, currency: string | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  const off = currencyOffset(currency);
  if (off === null) throw new ToolError("internal", "The account's currency is unknown, so Meta amounts cannot be converted.");
  const n = Number(v);
  return Number.isFinite(n) ? n / off : null;
}

/** Account-currency units to Meta's minor unit (rounded). */
export function toMinor(units: number, currency: string | null): number {
  const off = currencyOffset(currency);
  if (off === null) throw new ToolError("internal", "The account's currency is unknown, so the amount cannot be converted.");
  return Math.round(units * off);
}

/**
 * One Meta ad account (act_...), reached with the connecting user's token. Reads fetch on demand and are retried on
 * transient failures; writes are sent once and never retried automatically.
 */
export class MetaAdsClient {
  private sent = 0;

  constructor(
    private o: {
      http: MetaGraphHttp;
      /** "act_<digits>" */
      adAccountId: string;
      currency: string | null;
      getToken: () => Promise<{ accessToken: string; appSecretProof: string }>;
      /** A Page access token for a Page the connected user has a role on (needed by Page edges such as leadgen_forms). */
      getPageToken?: (pageId: string) => Promise<{ accessToken: string; appSecretProof: string }>;
      signal?: AbortSignal;
    },
  ) {
    if (!/^act_\d+$/.test(o.adAccountId)) throw new ToolError("internal", "invalid Meta ad account id");
  }

  get adAccountId() {
    return this.o.adAccountId;
  }
  get currency() {
    return this.o.currency;
  }
  /** Changes this client has attempted to send. Zero means nothing reached Meta. */
  get mutationsSent() {
    return this.sent;
  }

  /** Reads one object or edge. */
  async get<T = MetaRow>(path: string, params: Record<string, string> = {}): Promise<T> {
    const t = await this.o.getToken();
    return this.o.http.call<T>({ ...t, path, params, idempotent: true, signal: this.o.signal });
  }

  /**
   * Reads an edge and follows cursor pagination (never the raw `paging.next` URL) up to maxRows.
   *
   * Rows are never dropped silently: when the edge holds more than maxRows rows the call fails with `unsupported`, because a
   * caller that treats the rows as the whole edge (existence and duplicate checks, totals, the state a change is planned on)
   * would otherwise be wrong without knowing it. A caller that shows a page and reports `truncated` itself passes
   * `{ partial: true }` to get the first maxRows rows.
   */
  async list(path: string, params: Record<string, string> = {}, maxRows = 500, opts: { partial?: boolean } = {}): Promise<MetaRow[]> {
    const cap = Math.min(maxRows, HARD_ROW_CAP);
    const rows: MetaRow[] = [];
    let after: string | undefined;
    do {
      const page = await this.get<{ data?: MetaRow[]; paging?: { cursors?: { after?: string }; next?: string } }>(path, { limit: String(Math.min(100, cap)), ...params, ...(after ? { after } : {}) });
      rows.push(...(page.data ?? []));
      after = page.paging?.next ? page.paging.cursors?.after : undefined;
    } while (after && rows.length <= cap);
    if (!opts.partial && (rows.length > cap || after)) throw tooManyRows(cap, path);
    return rows.slice(0, cap);
  }

  /**
   * Reads a Page edge with that Page's access token. The token never leaves the client: handlers only get the rows. Callers
   * must first check the Page is one this ad account can promote (requirePromotablePage in tools/common.ts).
   */
  async listAsPage(pageId: string, path: string, params: Record<string, string> = {}, maxRows = 500, opts: { partial?: boolean } = {}): Promise<MetaRow[]> {
    if (!/^\d{1,25}$/.test(pageId)) throw new ToolError("invalid_argument", "Page id must be numeric.");
    if (!this.o.getPageToken) throw new ToolError("unsupported", "Page access is not configured on this server.");
    const t = await this.o.getPageToken(pageId);
    const cap = Math.min(maxRows, HARD_ROW_CAP);
    const rows: MetaRow[] = [];
    let after: string | undefined;
    do {
      const page = await this.o.http.call<{ data?: MetaRow[]; paging?: { cursors?: { after?: string }; next?: string } }>({ ...t, path, params: { limit: String(Math.min(100, cap)), ...params, ...(after ? { after } : {}) }, idempotent: true, signal: this.o.signal });
      rows.push(...(page.data ?? []));
      after = page.paging?.next ? page.paging.cursors?.after : undefined;
    } while (after && rows.length <= cap);
    if (!opts.partial && (rows.length > cap || after)) throw tooManyRows(cap, path);
    return rows.slice(0, cap);
  }

  /** Reads an object and refuses it unless it belongs to this ad account (a token can reach other accounts too). */
  async getOwned<T extends MetaRow = MetaRow>(objectId: string, fields: string[], label: string): Promise<T> {
    if (!/^\d{1,25}$/.test(objectId)) throw new ToolError("invalid_argument", `${label} id must be numeric.`);
    let row: T;
    try {
      row = await this.get<T>(objectId, { fields: [...new Set([...fields, "account_id"])].join(",") });
    } catch (e) {
      if (e instanceof ToolError && (e.code === "not_found" || e.code === "platform_permission_denied")) throw new ToolError("not_found", `No ${label} ${objectId} in this ad account.`);
      throw e;
    }
    if (`act_${String(row.account_id ?? "")}` !== this.o.adAccountId) throw new ToolError("not_found", `No ${label} ${objectId} in this ad account.`);
    return row;
  }

  /** Sends one write (POST). Counted before sending: a failure after that point may have changed something. */
  async post<T = MetaRow>(path: string, params: Record<string, string>): Promise<T> {
    const t = await this.o.getToken(); // credential problems happen before anything is sent
    if (this.o.signal?.aborted) throw new ToolError("deadline_exceeded", "Stopped before sending the change: the call was cancelled or ran past its time limit. Nothing was changed.");
    this.sent++;
    return this.o.http.call<T>({ ...t, path, method: "POST", params, idempotent: false, signal: this.o.signal });
  }
}
