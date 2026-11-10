import type { FetchLike } from "../../auth/token-providers";
import { ToolError, redact } from "../../mcp/errors";
import { type RetryOptions, sendWithRetry } from "../core/http-core";

/**
 * JSON transport for the Bing Webmaster Tools API (learn.microsoft.com/bingwebmaster, "Supported API Protocols" and "Accessing
 * Bing Webmaster APIs using OAuth 2.0"; docs/VERIFICATION.md, "Bing Webmaster tools (2026-11-10)").
 *
 * - Every method is `{BING_API}/{MethodName}`: reads are GET with query parameters, changes are POST with a JSON body whose
 *   keys are the method's parameter names (WebInvoke WrappedRequest).
 * - The OAuth access token goes only in `Authorization: Bearer` (the OAuth page's SubmitUrl sample). The API-key form
 *   (`?apikey=`) is never used: keys are per user, cannot be scoped and would end up in URLs and logs.
 * - Successful responses wrap the result as `{"d": ...}` (`{"d": null}` for methods that return nothing).
 * - Failures are HTTP 400 with `{"ErrorCode": n, "Message": "..."}` (the ApiErrorCode enum).
 * - Reads are retried on transient failures (sendWithRetry); changes are sent once and never retried.
 */
export const BING_HOST = "www.bing.com";
export const BING_API = `https://${BING_HOST}/webmaster/api.svc/json`;

export interface BingHttpOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export type BingParams = Record<string, string | number | boolean | undefined>;

export interface BingCall {
  accessToken: string;
  /** Method name exactly as the API reference spells it, e.g. "GetQueryStats". */
  method: string;
  /** GET query parameters (reads). */
  params?: BingParams;
  /** POST JSON body (changes, and the few POSTs that only read). Present means POST. */
  body?: Record<string, unknown>;
  /** True for reads: safe to retry. Changes are never retried. */
  idempotent: boolean;
  signal?: AbortSignal;
}

/** ApiErrorCode (Microsoft.Bing.Webmaster.Api.Interfaces.ApiErrorCode), values as documented. */
export const BING_ERROR = {
  None: 0,
  InternalError: 1,
  UnknownError: 2,
  InvalidApiKey: 3,
  ThrottleUser: 4,
  ThrottleHost: 5,
  UserBlocked: 6,
  InvalidUrl: 7,
  InvalidParameter: 8,
  TooManySites: 9,
  UserNotFound: 10,
  NotFound: 11,
  AlreadyExists: 12,
  NotAllowed: 13,
  NotAuthorized: 14,
  UnexpectedState: 15,
  Deprecated: 16,
} as const;
const NAME_BY_CODE = Object.fromEntries(Object.entries(BING_ERROR).map(([k, v]) => [v, k])) as Record<number, string>;

interface BingErrorBody {
  ErrorCode?: number;
  Message?: string;
}

/**
 * Maps a failed Bing response to a stable ToolError. Exported for tests. `details.bing_error` carries the documented
 * ApiErrorCode name so tools can tell, for example, AlreadyExists from NotFound without parsing messages.
 */
export function mapBingError(status: number, body: BingErrorBody, mutation: boolean): ToolError {
  const code = typeof body.ErrorCode === "number" ? body.ErrorCode : null;
  const name = code === null ? null : (NAME_BY_CODE[code] ?? `code ${code}`);
  const msg = redact(body.Message || name || "Bing Webmaster API error");
  const details = name ? { bing_error: name } : undefined;
  const opt = (o: Record<string, unknown> = {}) => ({ ...o, ...(details ? { details } : {}) });

  if (status === 401 || code === BING_ERROR.InvalidApiKey) return new ToolError("auth_expired", "Bing rejected the credentials. Reconnect Bing Webmaster on the Connections page.", opt());
  if (status === 429 || code === BING_ERROR.ThrottleUser || code === BING_ERROR.ThrottleHost) return new ToolError("quota_exceeded", `Bing Webmaster API rate limit reached: ${msg}`, opt({ retryAfterSeconds: 60 }));
  if (code === BING_ERROR.NotAuthorized || code === BING_ERROR.NotAllowed || code === BING_ERROR.UserBlocked || status === 403)
    return new ToolError("platform_permission_denied", `Bing denied access: ${msg}`, opt());
  if (code === BING_ERROR.NotFound || code === BING_ERROR.UserNotFound || status === 404) return new ToolError("not_found", msg, opt());
  if (code === BING_ERROR.AlreadyExists) return new ToolError("conflict", msg, opt({ definite: true }));
  if (code === BING_ERROR.UnexpectedState) return new ToolError("conflict", msg, opt());
  if (code === BING_ERROR.Deprecated) return new ToolError("unsupported", `Bing reports this method as deprecated: ${msg}`, opt({ definite: true }));
  if (code === BING_ERROR.InvalidUrl || code === BING_ERROR.InvalidParameter || code === BING_ERROR.TooManySites) return new ToolError("invalid_argument", msg, opt({ definite: true }));
  if (status >= 500 || code === BING_ERROR.InternalError || code === BING_ERROR.UnknownError) {
    // The server may have applied a change before failing: never report that as a definite failure.
    return mutation ? new ToolError("unknown_outcome", "Bing returned a server error while applying a change. It may or may not have been applied.", opt()) : new ToolError("transient", "The Bing Webmaster API is temporarily unavailable.", opt({ retryable: true }));
  }
  if (status === 400) return new ToolError("invalid_argument", msg, opt());
  return new ToolError("internal", "Unexpected Bing Webmaster API response.", opt());
}

/** `{BING_API}/{method}` with query parameters. The method name is checked so a value can never change the path. */
export function bingUrl(method: string, params?: BingParams): URL {
  if (!/^[A-Za-z]{3,64}$/.test(method)) throw new ToolError("internal", "Refused a malformed Bing Webmaster method name.");
  const u = new URL(`${BING_API}/${method}`);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
  return u;
}

export class BingHttp {
  private retry: RetryOptions;

  constructor(o: BingHttpOptions = {}) {
    this.retry = { fetch: o.fetch ?? fetch, sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), random: o.random ?? Math.random, timeoutMs: o.timeoutMs };
  }

  /** Returns the unwrapped `d` value (undefined when Bing answered `{"d": null}` or with an empty body). */
  async call<T = unknown>(c: BingCall): Promise<T | undefined> {
    const u = bingUrl(c.method, c.params);
    const headers: Record<string, string> = { authorization: `Bearer ${c.accessToken}`, accept: "application/json" };
    if (c.body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
    const res = await sendWithRetry<{ d?: T } | undefined>(this.retry, {
      url: u.toString(),
      init: { method: c.body === undefined ? "GET" : "POST", headers, body: c.body === undefined ? undefined : JSON.stringify(c.body) },
      idempotent: c.idempotent,
      signal: c.signal,
      platform: "Bing Webmaster",
      isSuccess: (r) => r.ok,
      mapError: (r, json) => mapBingError(r.status, (json && typeof json === "object" && !Array.isArray(json) ? json : {}) as BingErrorBody, !c.idempotent),
    });
    if (res === undefined || res === null) return undefined;
    if (typeof res !== "object" || Array.isArray(res) || !("d" in res)) throw new ToolError("internal", "Bing Webmaster returned a response in an unexpected shape.");
    return (res.d ?? undefined) as T | undefined;
  }
}
