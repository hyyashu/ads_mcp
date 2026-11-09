import type { FetchLike } from "../../auth/token-providers";
import { ToolError, redact } from "../../mcp/errors";
import { type RetryOptions, sendWithRetry } from "../core/http-core";

/**
 * REST transport for the Google APIs behind Search Console, GA4 and Tag Manager. Unlike Google Ads these have their versions
 * in the URL (webmasters/v3, v1beta, tagmanager/v2), so callers pass full URLs; only the hosts below are reachable, so a
 * value read from an API response or a tool argument can never send the bearer token anywhere else.
 * Reads are retried on transient failures (sendWithRetry); mutations are sent once and never retried.
 */
export const GAPI_HOSTS = ["www.googleapis.com", "searchconsole.googleapis.com", "analyticsdata.googleapis.com", "analyticsadmin.googleapis.com", "tagmanager.googleapis.com"] as const;

export interface GoogleApiHttpOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export type Params = Record<string, string | number | boolean | undefined | (string | number)[]>;

export interface GoogleApiCall {
  accessToken: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Full https URL on one of GAPI_HOSTS. */
  url: string;
  /** Query parameters; arrays repeat the key (e.g. updateMask fields are a comma list instead, pass them joined). */
  params?: Params;
  body?: unknown;
  /** True for reads (including POST queries that only read): safe to retry. Mutations are never retried. */
  idempotent: boolean;
  signal?: AbortSignal;
  /** Runs before every attempt, retries included (passed to sendWithRetry). */
  beforeAttempt?: () => Promise<void>;
}

/**
 * Google's JSON error body. The newer APIs (Analytics Data/Admin, URL Inspection, Tag Manager) put an ErrorInfo `reason` in
 * `details`; the older webmasters v3 API puts `errors[].reason` next to the message. Both are read.
 */
interface GapiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: { reason?: string; message?: string }[];
    details?: { "@type"?: string; reason?: string; retryDelay?: string; metadata?: Record<string, string> }[];
  };
}

/** Reasons Google uses for quota and rate limits (ErrorInfo and the legacy errors[] array). A 403 with one of these is a quota, not a permission problem. */
const QUOTA_REASON = /quota|rate.?limit|limitExceeded|RESOURCE_EXHAUSTED/i;

/** Maps a failed Google API response to a stable ToolError. Exported for tests. `product` names the API in messages. */
export function mapGapiError(status: number, body: GapiErrorBody, mutation: boolean, product = "Google"): ToolError {
  const e = body.error ?? {};
  const reasons = [...(e.errors ?? []).map((x) => x.reason ?? ""), ...(e.details ?? []).map((d) => d.reason ?? "")].filter(Boolean);
  const msg = redact(e.message || `${product} API error`);
  const delay = (e.details ?? []).find((d) => d.retryDelay)?.retryDelay;
  const retryAfterSeconds = delay ? Math.max(1, Math.ceil(Number.parseFloat(delay))) : undefined;
  const quota = status === 429 || e.status === "RESOURCE_EXHAUSTED" || (status === 403 && reasons.some((r) => QUOTA_REASON.test(r)));

  if (status === 401 || e.status === "UNAUTHENTICATED") return new ToolError("auth_expired", `Google rejected the credentials. Reconnect ${product} on the Connections page.`);
  if (quota) return new ToolError("quota_exceeded", `${product} API quota or rate limit reached: ${msg}`, { retryAfterSeconds: retryAfterSeconds ?? 60 });
  if (status === 403 || e.status === "PERMISSION_DENIED") return new ToolError("platform_permission_denied", `Google denied access: ${msg}`);
  if (status === 404 || e.status === "NOT_FOUND") return new ToolError("not_found", msg);
  if (status === 409 || e.status === "ABORTED" || e.status === "ALREADY_EXISTS") return new ToolError("conflict", msg);
  // 412: a precondition such as Tag Manager's `fingerprint` did not match, so Google refused the change before applying it.
  if (status === 412) return new ToolError("conflict", `The item changed since this was planned, so ${product} refused the change. Nothing was changed. ${msg}`, { definite: true });
  if (status >= 500 || e.status === "UNAVAILABLE" || e.status === "INTERNAL" || e.status === "DEADLINE_EXCEEDED") {
    // The server may have applied a mutation before failing: never report that as a definite failure.
    return mutation ? new ToolError("unknown_outcome", `${product} returned a server error while applying a change. It may or may not have been applied.`) : new ToolError("transient", `${product} API is temporarily unavailable.`, { retryable: true });
  }
  if (status === 400 || e.status === "INVALID_ARGUMENT" || e.status === "FAILED_PRECONDITION" || e.status === "OUT_OF_RANGE") return new ToolError("invalid_argument", msg);
  return new ToolError("internal", `Unexpected ${product} API response.`);
}

const PRODUCT_BY_HOST: Record<string, string> = {
  "www.googleapis.com": "Search Console",
  "searchconsole.googleapis.com": "Search Console",
  "analyticsdata.googleapis.com": "Google Analytics",
  "analyticsadmin.googleapis.com": "Google Analytics",
  "tagmanager.googleapis.com": "Tag Manager",
};

/** Parses and checks a URL: https, an allowed host, no credentials or port tricks. Throws `internal` (a bug, not user input). */
export function checkedUrl(raw: string, params?: Params): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ToolError("internal", "Refused a malformed Google API URL.");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !(GAPI_HOSTS as readonly string[]).includes(u.hostname)) {
    throw new ToolError("internal", `Refused a request to a host outside the Google API allow-list: ${u.protocol}//${u.hostname}`);
  }
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, String(x));
    else u.searchParams.set(k, String(v));
  }
  return u;
}

export class GoogleApiHttp {
  private retry: RetryOptions;

  constructor(o: GoogleApiHttpOptions = {}) {
    this.retry = { fetch: o.fetch ?? fetch, sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), random: o.random ?? Math.random, timeoutMs: o.timeoutMs };
  }

  async call<T = unknown>(c: GoogleApiCall): Promise<T> {
    const u = checkedUrl(c.url, c.params);
    const product = PRODUCT_BY_HOST[u.hostname] ?? "Google";
    // The token goes only in the Authorization header, never in the URL.
    const headers: Record<string, string> = { authorization: `Bearer ${c.accessToken}`, accept: "application/json" };
    if (c.body !== undefined) headers["content-type"] = "application/json";
    const method = c.method ?? (c.body === undefined ? "GET" : "POST");
    const res = await sendWithRetry<T | undefined>(this.retry, {
      url: u.toString(),
      init: { method, headers, body: c.body === undefined ? undefined : JSON.stringify(c.body) },
      idempotent: c.idempotent,
      signal: c.signal,
      ...(c.beforeAttempt ? { beforeAttempt: c.beforeAttempt } : {}),
      platform: product,
      isSuccess: (r) => r.ok,
      mapError: (r, json) => mapGapiError(r.status, ((Array.isArray(json) ? json[0] : json) as GapiErrorBody) ?? {}, !c.idempotent, product),
    });
    // Some methods (sitemaps.submit, sites.delete) answer with an empty body on success.
    return (res ?? {}) as T;
  }
}
