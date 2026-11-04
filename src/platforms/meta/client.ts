import { ToolError } from "../../mcp/errors";
import type { MetaGraphHttp } from "./http";

export type MetaRow = Record<string, unknown>;
const HARD_ROW_CAP = 5_000;

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

  /** Reads an edge and follows cursor pagination (never the raw `paging.next` URL) up to maxRows. */
  async list(path: string, params: Record<string, string> = {}, maxRows = 500): Promise<MetaRow[]> {
    const cap = Math.min(maxRows, HARD_ROW_CAP);
    const rows: MetaRow[] = [];
    let after: string | undefined;
    do {
      const page = await this.get<{ data?: MetaRow[]; paging?: { cursors?: { after?: string }; next?: string } }>(path, { limit: String(Math.min(100, cap)), ...params, ...(after ? { after } : {}) });
      rows.push(...(page.data ?? []));
      after = page.paging?.next ? page.paging.cursors?.after : undefined;
    } while (after && rows.length < cap);
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
