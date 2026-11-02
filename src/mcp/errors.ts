/** Stable, client-facing error codes. Every failure a tool can return maps to one of these. */
export const ERROR_CODES = [
  "invalid_argument",
  "unauthenticated",
  "permission_denied", // our scopes / account access level
  "platform_permission_denied", // the ad platform refused (missing OAuth scope, no account access)
  "not_found",
  "auth_expired", // credentials revoked or expired: the user must reconnect
  "quota_exceeded", // our rate limit or the platform's
  "transient", // network / 5xx: safe to retry
  "conflict", // e.g. state changed since the request was planned
  "unsupported", // the official API cannot do this
  "unknown_outcome", // a mutation was sent but its result is not confirmed
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class ToolError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public opts: { retryable?: boolean; retryAfterSeconds?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ToolError";
  }
  get retryable() {
    return this.opts.retryable ?? (this.code === "transient" || this.code === "quota_exceeded");
  }
}

const TOKEN_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bya29\.[A-Za-z0-9._-]{10,}/g, // Google access tokens
  /\b1\/\/[A-Za-z0-9._-]{20,}/g, // Google refresh tokens
  /\bEAA[A-Za-z0-9]{20,}/g, // Meta access tokens
  /(access_token|refresh_token|client_secret|developer-token|appsecret_proof)(["'=:\s]+)[A-Za-z0-9._~+/-]{8,}/gi,
];

/** Removes anything that looks like a credential from text that may come from an upstream error. */
export function redact(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, (m, k) => (typeof k === "string" ? `${k}=[redacted]` : "[redacted]"));
  return out.length > 600 ? `${out.slice(0, 600)}…` : out;
}

/** Anything thrown becomes a safe ToolError. Unknown errors never leak their message. */
export function toToolError(e: unknown): ToolError {
  if (e instanceof ToolError) return new ToolError(e.code, redact(e.message), e.opts);
  return new ToolError("internal", "Unexpected server error. It has been logged.", { retryable: false });
}
