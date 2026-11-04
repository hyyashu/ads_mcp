import type { FetchLike } from "../../auth/token-providers";
import { ToolError, redact } from "../../mcp/errors";
import { type RetryOptions, sendWithRetry } from "../core/http-core";
import { logger } from "../../obs/logger";

/**
 * Low-level Meta Graph / Marketing API transport. Verified against Meta's documentation on 2026-11-04:
 * - Versions: v27.0 (released 2026-11-04) is the latest; v26.0 (2026-07-29) is still supported (Graph API changelog,
 *   checked 2026-11-05). v27 no longer returns ad sets' meta_moment_maker_spec on reads, so it is never requested.
 * - Error body: {error: {message, type, code, error_subcode, error_user_title, error_user_msg, fbtrace_id}} (Graph API
 *   error handling guide). Throttling codes: 4 (app), 17 (user), 32 (pages), 613 (custom), 80000-80014 (business use
 *   case / ad account) (Graph API and Marketing API rate limiting).
 * - Usage headers: X-Business-Use-Case-Usage (per business object; `estimated_time_to_regain_access` is in MINUTES),
 *   X-Ad-Account-Usage (`acc_id_util_pct`, `reset_time_duration` in seconds), X-App-Usage.
 * Why not the official Node SDK (facebook-nodejs-business-sdk 24.0.1): it targets v24 and sends the access token as a
 * query parameter. Here the token travels only in the Authorization header, so it cannot end up in URL logs.
 * Not found in the documentation checked: an idempotency key for Marketing API writes. Writes therefore rely on the
 * approval key, drift checks and verify() like Google, and are never retried automatically.
 */
export interface MetaHttpOptions {
  /** e.g. "v27.0". No default: the operator must set it from Meta's changelog. */
  apiVersion: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface MetaCall {
  accessToken: string;
  /** HMAC-SHA256 of the token with the app secret. Not a secret itself; sent as a parameter as Meta requires. */
  appSecretProof: string;
  /** Path after /{version}/, e.g. "act_123/campaigns" or "120000000000". Never a full URL. */
  path: string;
  method?: "GET" | "POST";
  params?: Record<string, string>;
  /** True for reads: retried on transient failures. Writes are sent once. */
  idempotent: boolean;
  signal?: AbortSignal;
}

interface MetaErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_title?: string; error_user_msg?: string; is_transient?: boolean; fbtrace_id?: string };
}

const THROTTLE = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);

/** Longest wait Meta announces in the usage headers, in seconds. */
export function retryAfterFromHeaders(h: Headers): number | undefined {
  let best = 0;
  const buc = h.get("x-business-use-case-usage");
  if (buc) {
    try {
      for (const entries of Object.values(JSON.parse(buc) as Record<string, { estimated_time_to_regain_access?: number }[]>)) {
        for (const e of entries ?? []) best = Math.max(best, (e.estimated_time_to_regain_access ?? 0) * 60); // minutes
      }
    } catch {
      /* malformed header: ignore */
    }
  }
  const acc = h.get("x-ad-account-usage");
  if (acc) {
    try {
      const a = JSON.parse(acc) as { acc_id_util_pct?: number; reset_time_duration?: number };
      if ((a.acc_id_util_pct ?? 0) >= 100) best = Math.max(best, a.reset_time_duration ?? 0); // seconds
    } catch {
      /* ignore */
    }
  }
  return best > 0 ? Math.ceil(best) : undefined;
}

/** Highest usage percentage Meta reports in any usage header (for logging before we get throttled). */
function usagePct(h: Headers): number {
  let max = 0;
  const take = (v: unknown) => typeof v === "number" && (max = Math.max(max, v));
  try {
    const app = h.get("x-app-usage");
    if (app) for (const v of Object.values(JSON.parse(app) as Record<string, number>)) take(v);
    const acc = h.get("x-ad-account-usage");
    if (acc) take((JSON.parse(acc) as { acc_id_util_pct?: number }).acc_id_util_pct);
    const buc = h.get("x-business-use-case-usage");
    if (buc) for (const list of Object.values(JSON.parse(buc) as Record<string, Record<string, unknown>[]>)) for (const e of list ?? []) for (const k of ["call_count", "total_cputime", "total_time"]) take(e[k]);
  } catch {
    /* ignore */
  }
  return max;
}

/** Maps a failed Meta response to a safe, stable ToolError. Exported for tests. */
export function mapMetaError(status: number, body: MetaErrorBody, mutation: boolean, headers?: Headers): ToolError {
  const e = body.error ?? {};
  const code = e.code ?? 0;
  const detail = redact(e.error_user_msg || e.message || "Meta API error");
  const trace = e.fbtrace_id ? { details: { fbtrace_id: String(e.fbtrace_id).slice(0, 64) } } : {};

  if (code === 190 || code === 102 || (e.type === "OAuthException" && code === 0) || status === 401) {
    return new ToolError("auth_expired", "Meta rejected the access token. Reconnect the Meta Ads account.", trace);
  }
  if (THROTTLE.has(code) || status === 429) {
    return new ToolError("quota_exceeded", "Meta API rate limit reached for this app or ad account.", { retryAfterSeconds: (headers && retryAfterFromHeaders(headers)) ?? 60, ...trace });
  }
  if (code === 10 || (code >= 200 && code <= 299) || status === 403) return new ToolError("platform_permission_denied", `Meta denied access: ${detail}`, trace);
  // 100/33: "Object with ID ... does not exist, cannot be loaded due to missing permissions, or does not support this operation".
  if ((code === 100 && e.error_subcode === 33) || code === 803 || status === 404) return new ToolError("not_found", detail, trace);
  // 10803 (product_sets POST): "Product set with the same filters already exists". Kept recognizable for the caller.
  if (code === 10803) return new ToolError("invalid_argument", detail, { details: { ...trace.details, meta_code: 10803 } });
  if (code === 1 || code === 2 || e.is_transient || status >= 500) {
    return mutation
      ? new ToolError("unknown_outcome", "Meta returned a temporary error while applying a change. It may or may not have been applied.", trace)
      : new ToolError("transient", "Meta API is temporarily unavailable.", { retryable: true, ...trace });
  }
  if (code === 100 || status === 400) return new ToolError("invalid_argument", detail, trace);
  return new ToolError("internal", "Unexpected Meta API response.", trace);
}

export class MetaGraphHttp {
  private retry: RetryOptions;

  constructor(private o: MetaHttpOptions) {
    if (!/^v\d+\.\d+$/.test(o.apiVersion)) throw new Error("META_API_VERSION must look like v27.0 and be set explicitly");
    this.retry = { fetch: o.fetch ?? fetch, sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), random: o.random ?? Math.random, timeoutMs: o.timeoutMs };
  }

  get apiVersion() {
    return this.o.apiVersion;
  }

  async call<T = unknown>(c: MetaCall): Promise<T> {
    if (!/^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/.test(c.path)) throw new ToolError("internal", "invalid Meta API path");
    const method = c.method ?? "GET";
    const params = new URLSearchParams({ ...(c.params ?? {}), appsecret_proof: c.appSecretProof });
    const base = `https://graph.facebook.com/${this.o.apiVersion}/${c.path}`;
    const headers: Record<string, string> = { authorization: `Bearer ${c.accessToken}` };
    if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
    return sendWithRetry<T>(this.retry, {
      url: method === "GET" ? `${base}?${params}` : base,
      init: { method, headers, body: method === "POST" ? params : undefined },
      idempotent: c.idempotent,
      signal: c.signal,
      platform: "Meta",
      isSuccess: (res, json) => res.ok && !(json as MetaErrorBody | undefined)?.error,
      mapError: (res, json) => mapMetaError(res.status, (json as MetaErrorBody) ?? {}, !c.idempotent, res.headers),
      onResponse: (res) => {
        const pct = usagePct(res.headers);
        if (pct >= 80) logger.warn("meta.usage_high", { pct, path: c.path.split("/")[0]?.startsWith("act_") ? "ad_account" : "object" });
      },
    });
  }
}
