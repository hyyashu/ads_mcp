import { redact } from "../mcp/errors";

/**
 * Structured JSON logs, one object per line, always redacted. Values under sensitive keys are dropped entirely; every other
 * string passes through the token-pattern redactor. Use this instead of console.* in server code.
 */
const SENSITIVE_KEY = /authorization|cookie|password|secret|token|credential|appsecret|api[_-]?key|set-cookie/i;
const MAX_DEPTH = 5;

export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message), ...(value.stack ? { stack: redact(value.stack) } : {}) };
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : scrub(v, depth + 1);
    return out;
  }
  return String(value);
}

export type Level = "debug" | "info" | "warn" | "error";
export type Sink = (line: string, level: Level) => void;

let sink: Sink = (line, level) => (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);

/** Test seam: capture log lines. */
export function setLogSink(s: Sink) {
  const prev = sink;
  sink = s;
  return () => (sink = prev);
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}) {
  sink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...(scrub(fields) as Record<string, unknown>) }), level);
}

export const logger = {
  debug: (event: string, f?: Record<string, unknown>) => log("debug", event, f),
  info: (event: string, f?: Record<string, unknown>) => log("info", event, f),
  warn: (event: string, f?: Record<string, unknown>) => log("warn", event, f),
  error: (event: string, f?: Record<string, unknown>) => log("error", event, f),
};
