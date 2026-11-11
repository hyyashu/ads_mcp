import { ToolError } from "../../mcp/errors";
import type { Discovery } from "../gapi/discovery";
import { MAX_DISCOVERED } from "../gapi/discovery";
import type { BingHttp, BingParams } from "./http";

// Facts behind this file: docs/VERIFICATION.md, "Bing Webmaster tools (2026-11-10)".

/** A Bing Webmaster site URL as GetUserSites returns it (http or https, with or without a trailing slash). */
export const isBingSiteUrl = (s: string) => /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(s);

export interface BingSite {
  url: string;
  isVerified: boolean;
  authenticationCode: string | null;
  dnsVerificationCode: string | null;
}

export type Row = Record<string, unknown>;

export interface BingClientOptions {
  http: BingHttp;
  /** Fresh access token for this site's connection. Never stored on the client or returned to a handler. */
  getAccessToken: () => Promise<string>;
  /** Site URL exactly as GetUserSites returned it (connected_account.external_id). */
  siteUrl: string;
  /** The tool call's signal: cancellation and deadlines reach the upstream requests. */
  signal?: AbortSignal;
}

// ------------------------------------------------------------------------------------------------ value helpers

export const asObject = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});

/** A list result: Bing returns `{"d": [...]}`, `{"d": null}` for none. Anything else is a shape we do not understand. */
export function asList(v: unknown, what: string): Row[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ToolError("internal", `Bing Webmaster returned ${what} in an unexpected shape.`);
  return v.map(asObject);
}

/** A number from a JSON number or numeric string; anything else is null. */
export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export const str = (v: unknown): string | null => (typeof v === "string" ? v : v === undefined || v === null ? null : String(v));
export const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/**
 * WCF JSON dates: "/Date(1316156400000-0700)/" (milliseconds since the Unix epoch in UTC; the optional offset only says which
 * zone the server rendered it for and does not shift the instant). Returns the instant as an ISO string, or null.
 * DateTime.MinValue ("/Date(-62135596800000)/", Bing's "never") is returned as null.
 */
export function bingDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(v);
  if (!m) return null;
  const ms = Number(m[1]);
  if (!Number.isFinite(ms) || ms <= -62135596800000) return null;
  return new Date(ms).toISOString();
}

/**
 * The calendar day a Bing date names. Bing renders daily and weekly buckets as midnight in the offset it sends
 * (e.g. "/Date(1316156400000-0700)/" is 2011-09-16 00:00 at -07:00), so the day is read in that offset, not in UTC.
 */
export function bingDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^\/Date\((-?\d+)([+-])(\d{2})(\d{2})\)\/$/.exec(v);
  if (!m) return bingDate(v)?.slice(0, 10) ?? null;
  const offsetMin = (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]));
  return new Date(Number(m[1]) + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** A date for a request body/parameter in the WCF JSON form Bing reads ("/Date(ms)/", UTC). */
export const toBingDate = (isoDay: string): string => `/Date(${Date.parse(`${isoDay}T00:00:00Z`)})/`;

// ------------------------------------------------------------------------------------------------------- client

/**
 * One Bing Webmaster site, reached with the connecting user's OAuth token. Section modules (src/platforms/bing/api/*.ts) add
 * typed calls on top of read / readPost / send, so this file stays the one place that talks to the transport.
 */
export class BingClient {
  constructor(private o: BingClientOptions) {
    if (!isBingSiteUrl(o.siteUrl)) throw new ToolError("internal", "Not a Bing Webmaster site URL.");
    this.siteUrl = o.siteUrl;
  }
  readonly siteUrl: string;

  private sent = 0;
  /** How many changes this client has attempted to send. Zero means nothing reached Bing (the executor relies on it). */
  get mutationsSent(): number {
    return this.sent;
  }

  /** GET that only reads. Retried on transient failures. `siteUrl` is added unless the method takes none (pass `site: false`). */
  async read<T = unknown>(method: string, params: BingParams = {}, o: { site?: boolean } = {}): Promise<T | undefined> {
    return this.o.http.call<T>({ accessToken: await this.o.getAccessToken(), method, params: o.site === false ? params : { siteUrl: this.siteUrl, ...params }, idempotent: true, signal: this.o.signal });
  }

  /** POST that only reads (none documented so far; kept for methods whose reference says WebInvoke but that change nothing). */
  async readPost<T = unknown>(method: string, body: Record<string, unknown>): Promise<T | undefined> {
    return this.o.http.call<T>({ accessToken: await this.o.getAccessToken(), method, body: { siteUrl: this.siteUrl, ...body }, idempotent: true, signal: this.o.signal });
  }

  /**
   * A change: POST with a JSON body, sent exactly once and never retried. A failure after sending is `unknown_outcome`, which
   * the approval service reconciles with the tool's verify(). Credentials are fetched first and the abort signal checked, so
   * a token failure or a cancelled call stops before anything is sent and counts as nothing sent. `siteUrl` is added to the
   * body unless the method takes none (pass `site: false`).
   */
  async send<T = unknown>(method: string, body: Record<string, unknown> = {}, o: { site?: boolean } = {}): Promise<T | undefined> {
    const accessToken = await this.o.getAccessToken();
    if (this.o.signal?.aborted) throw new ToolError("deadline_exceeded", "Stopped before sending the change: the call was cancelled or ran past its time limit. Nothing was changed.");
    this.sent++; // counted right before sending: a failure after this point may have changed something
    return this.o.http.call<T>({ accessToken, method, body: o.site === false ? body : { siteUrl: this.siteUrl, ...body }, idempotent: false, signal: this.o.signal });
  }

  // ------------------------------------------------------------------- sites (connection-wide: the Bing user's list)

  /** GetUserSites: every site of the connected Bing user, verified or not. */
  async listSites(): Promise<BingSite[]> {
    return parseSites(await this.read("GetUserSites", {}, { site: false }));
  }

  /** A site of the connected user by exact URL (from GetUserSites). */
  async findSite(url: string): Promise<BingSite | null> {
    return (await this.listSites()).find((s) => s.url === url) ?? null;
  }
}

export function parseSites(d: unknown): BingSite[] {
  return asList(d, "the site list")
    .filter((s) => typeof s.Url === "string")
    .map((s) => ({ url: s.Url as string, isVerified: s.IsVerified === true, authenticationCode: str(s.AuthenticationCode), dnsVerificationCode: str(s.DnsVerificationCode) }));
}

/**
 * Connect-time discovery: GetUserSites. An unverified site gives no data access, so it is skipped rather than connected.
 * `read` is a bare GET of one method with the new connection's token (no site yet).
 */
export async function discoverBingSites(read: (method: string) => Promise<unknown>): Promise<Discovery> {
  const sites = parseSites(await read("GetUserSites"));
  let skipped = 0;
  const accounts: Discovery["accounts"] = [];
  for (const s of sites) {
    if (!s.isVerified || !isBingSiteUrl(s.url) || accounts.length >= MAX_DISCOVERED) {
      skipped++;
      continue;
    }
    accounts.push({ externalId: s.url, displayName: s.url, loginCustomerId: null, currencyCode: null, timeZone: null });
  }
  return { accounts, skipped };
}
