import { ToolError, redact } from "../../mcp/errors";
import type { FetchLike } from "../../auth/token-providers";
import { type RetryOptions, sendWithRetry } from "../core/http-core";

/**
 * Low-level Google Ads REST transport.
 *
 * Access model (confirmed from Google's developer-token documentation, reached through search results because
 * the docs site is blocked in the build environment): developer tokens were sunset on 2026-09-09 and API access
 * levels now attach to the Google Cloud project that generated the OAuth credentials. So NO developer-token header
 * is sent. `login-customer-id` is still the manager account to act through, and is per connected account.
 */
export interface GoogleHttpOptions {
  /** e.g. "v23". Deliberately has no default: the current version must be set and checked by the operator. */
  apiVersion: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. Full jitter: each retry waits a random time up to the exponential cap. */
  random?: () => number;
}

export interface GoogleCall {
  accessToken: string;
  /** Path after /{version}/, e.g. "customers/123/googleAds:search". */
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  loginCustomerId?: string | null;
  /** True for reads: safe to retry on transient failures. Mutations are never retried automatically. */
  idempotent: boolean;
  signal?: AbortSignal;
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: { "@type"?: string; errors?: { errorCode?: Record<string, string>; message?: string }[]; retryDelay?: string }[] };
}

/** Maps a failed Google Ads response to a safe, stable ToolError. Exported for tests. */
export function mapGoogleError(status: number, body: GoogleErrorBody, mutation: boolean): ToolError {
  const e = body.error ?? {};
  const failures = (e.details ?? []).flatMap((d) => d.errors ?? []);
  const codes = failures.flatMap((f) => Object.entries(f.errorCode ?? {}));
  const has = (family: string) => codes.some(([k]) => k === family);
  const detailMsg = failures.map((f) => f.message).filter(Boolean).slice(0, 3).join("; ") || e.message || "Google Ads API error";
  const msg = redact(detailMsg);
  const retry = (e.details ?? []).find((d) => d.retryDelay)?.retryDelay;
  const retryAfterSeconds = retry ? Math.max(1, Math.ceil(Number.parseFloat(retry))) : undefined;

  if (status === 401 || has("authenticationError")) return new ToolError("auth_expired", "Google rejected the credentials. Reconnect the Google Ads account.");
  if (has("quotaError") || status === 429 || e.status === "RESOURCE_EXHAUSTED") {
    return new ToolError("quota_exceeded", "Google Ads API quota or rate limit reached.", { retryAfterSeconds: retryAfterSeconds ?? 30 });
  }
  if (status === 403 || has("authorizationError") || e.status === "PERMISSION_DENIED") {
    return new ToolError("platform_permission_denied", `Google denied access: ${msg}`);
  }
  if (status === 404 || codes.some(([, v]) => v === "RESOURCE_NAME_NOT_FOUND" || v === "NOT_FOUND")) return new ToolError("not_found", msg);
  if (has("concurrentModificationError") || e.status === "ABORTED") return new ToolError("conflict", `The resource changed concurrently: ${msg}`);
  if (status >= 500 || e.status === "UNAVAILABLE" || e.status === "DEADLINE_EXCEEDED" || e.status === "INTERNAL") {
    // The server may have applied a mutation before failing: never report this as a definite failure.
    return mutation ? new ToolError("unknown_outcome", "Google returned a server error while applying a change. It may or may not have been applied.") : new ToolError("transient", "Google Ads API is temporarily unavailable.", { retryable: true });
  }
  if (status === 400 || e.status === "INVALID_ARGUMENT") return new ToolError("invalid_argument", msg);
  return new ToolError("internal", "Unexpected Google Ads API response.");
}

export class GoogleAdsHttp {
  private retry: RetryOptions;

  constructor(private o: GoogleHttpOptions) {
    if (!/^v\d+$/.test(o.apiVersion)) throw new Error("GOOGLE_ADS_API_VERSION must look like v23 and be set explicitly");
    this.retry = { fetch: o.fetch ?? fetch, sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), random: o.random ?? Math.random, timeoutMs: o.timeoutMs };
  }

  get apiVersion() {
    return this.o.apiVersion;
  }

  async call<T = unknown>(c: GoogleCall): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${c.accessToken}`, "content-type": "application/json" };
    if (c.loginCustomerId) headers["login-customer-id"] = c.loginCustomerId.replace(/-/g, "");
    return sendWithRetry<T>(this.retry, {
      url: `https://googleads.googleapis.com/${this.o.apiVersion}/${c.path}`,
      init: { method: c.method ?? (c.body === undefined ? "GET" : "POST"), headers, body: c.body === undefined ? undefined : JSON.stringify(c.body) },
      idempotent: c.idempotent,
      signal: c.signal,
      platform: "Google Ads",
      isSuccess: (res) => res.ok,
      mapError: (res, json) => mapGoogleError(res.status, ((Array.isArray(json) ? json[0] : json) as GoogleErrorBody) ?? {}, !c.idempotent),
    });
  }
}
