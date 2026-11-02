import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted, so the same arguments always hash the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const hashArgs = (args: unknown) => sha256(canonicalJson(args));
