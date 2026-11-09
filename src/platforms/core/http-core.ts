import type { FetchLike } from "../../auth/token-providers";
import { ToolError } from "../../mcp/errors";

/**
 * The request loop shared by the Google Ads and Meta transports. Reads (idempotent) are retried up to 3 times on network
 * failures and transient errors with full-jitter backoff; a cancelled or timed-out read stops at once. Writes are sent
 * exactly once: no response at all means the outcome is unknown, never "failed".
 */
export interface RetryOptions {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  timeoutMs?: number;
}
export interface SendRequest {
  url: string;
  init: Omit<RequestInit, "signal">;
  idempotent: boolean;
  signal?: AbortSignal;
  /** Platform name for messages, e.g. "Google Ads". */
  platform: string;
  /** A response is a success when this returns true (Meta can return an error body with status 200). */
  isSuccess(res: Response, json: unknown): boolean;
  /** Maps a failed response to a ToolError; "transient" errors of reads are retried. */
  mapError(res: Response, json: unknown): ToolError;
  /** Called for every response (for usage logging). */
  onResponse?(res: Response): void;
  /** Runs before every attempt, retries included (Tag Manager's project rate limit). Throwing stops the request unsent. */
  beforeAttempt?: () => Promise<void>;
}

/** Full jitter: random in [0, 250 ms * 2^(attempt-1)], so many clients retrying at once do not move in lockstep. */
export const backoffMs = (random: () => number, attempt: number) => Math.floor(random() * 250 * 2 ** (attempt - 1));

export async function sendWithRetry<T>(o: RetryOptions, r: SendRequest): Promise<T> {
  const attempts = r.idempotent ? 3 : 1;
  for (let i = 1; ; i++) {
    let res: Response;
    await r.beforeAttempt?.();
    try {
      res = await o.fetch(r.url, { ...r.init, signal: r.signal ?? AbortSignal.timeout(o.timeoutMs ?? 30_000) });
    } catch {
      // Cancelled or past the deadline: a read stops here (no retry); a write's outcome is unknown below.
      if (r.idempotent && r.signal?.aborted) throw new ToolError("deadline_exceeded", `The ${r.platform} request was cancelled or ran past its time limit.`);
      // No response at all: for a write we cannot know whether it was applied.
      if (!r.idempotent) throw new ToolError("unknown_outcome", "The connection failed while applying a change. It may or may not have been applied.");
      if (i < attempts) {
        await o.sleep(backoffMs(o.random, i));
        continue;
      }
      throw new ToolError("transient", `Could not reach the ${r.platform} API.`, { retryable: true });
    }
    r.onResponse?.(res);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON error page */
    }
    if (r.isSuccess(res, json)) return json as T;
    const err = r.mapError(res, json);
    if (err.code === "transient" && r.idempotent && i < attempts) {
      await o.sleep(backoffMs(o.random, i));
      continue;
    }
    throw err;
  }
}
