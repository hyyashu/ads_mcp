import { ToolError } from "../../mcp/errors";

/**
 * GAQL query builder. User-controlled values can only enter a query through the `lit` helpers, which validate or
 * escape them, so a value can never change the structure of a query (no GAQL injection). Field and resource names
 * are checked against a strict pattern.
 */
const FIELD = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const RESOURCE = /^[a-z][a-z0-9_]*$/;

/**
 * A value that cannot go into a query. For `lit.*` values (which come from callers) that is the caller's mistake, so the default
 * is invalid_argument. Query-structure errors (a bad field or resource name written in our own code) are bugs on our side and
 * use code "internal".
 */
export class GaqlError extends ToolError {
  constructor(message: string, code: "invalid_argument" | "internal" = "invalid_argument") {
    super(code, message);
    this.name = "GaqlError";
  }
}

import { isRealDate } from "../core/report-math";
export { isRealDate };

export const lit = {
  /** Quoted string literal. Control characters are rejected, quotes and backslashes escaped. */
  str(value: string): string {
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new GaqlError("control characters are not allowed in query values");
    if (value.length > 500) throw new GaqlError("query value too long");
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  },
  int(value: number): string {
    if (!Number.isSafeInteger(value)) throw new GaqlError("expected an integer");
    return String(value);
  },
  /** A resource id: digits only (campaign, ad group, ad, criterion ids). */
  id(value: string | number): string {
    const s = String(value);
    if (!/^\d{1,20}$/.test(s)) throw new GaqlError("expected a numeric id");
    return s;
  },
  date(value: string): string {
    if (!isRealDate(value)) throw new GaqlError("expected a date as YYYY-MM-DD");
    return `'${value}'`;
  },
  /** One of a fixed set of enum names, e.g. campaign status. The set is defined in code, never by the caller. */
  enumOf<T extends string>(value: string, allowed: readonly T[]): T {
    if (!(allowed as readonly string[]).includes(value)) throw new GaqlError(`expected one of: ${allowed.join(", ")}`);
    return value as T;
  },
  /** Like enumOf, but returns the value as a quoted GAQL literal ('ENABLED'), for use on the right of a comparison. */
  enumLit<T extends string>(value: string, allowed: readonly T[]): string {
    return `'${lit.enumOf(value, allowed)}'`;
  },
  list(values: string[]): string {
    if (values.length === 0 || values.length > 1000) throw new GaqlError("list must have 1 to 1000 items");
    return `(${values.join(", ")})`;
  },
};

export const DURING = ["LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH", "LAST_BUSINESS_WEEK", "YESTERDAY", "TODAY"] as const;
export type During = (typeof DURING)[number];

export class Gaql {
  private fields: string[] = [];
  private resource = "";
  private conds: string[] = [];
  private order: string[] = [];
  private max?: number;
  private params: string[] = [];

  select(...fields: string[]): this {
    for (const f of fields) if (!FIELD.test(f)) throw new GaqlError(`invalid field name: ${f}`, "internal");
    this.fields.push(...fields);
    return this;
  }
  from(resource: string): this {
    if (!RESOURCE.test(resource)) throw new GaqlError(`invalid resource name: ${resource}`, "internal");
    this.resource = resource;
    return this;
  }
  /** `condition` must be built from field names and `lit.*` values only. */
  where(condition: string | false | undefined | null): this {
    if (condition) this.conds.push(condition);
    return this;
  }
  orderBy(field: string, dir: "ASC" | "DESC" = "ASC"): this {
    if (!FIELD.test(field)) throw new GaqlError(`invalid field name: ${field}`, "internal");
    this.order.push(`${field} ${dir}`);
    return this;
  }
  limit(n: number): this {
    if (!Number.isSafeInteger(n) || n < 1 || n > 10_000) throw new GaqlError("limit must be 1 to 10000", "internal");
    this.max = n;
    return this;
  }
  /** Query PARAMETERS from a fixed set, e.g. include_drafts = true (draft and in-design campaigns are hidden without it). */
  parameters(...params: ("include_drafts = true" | "omit_unselected_resource_names = true")[]): this {
    this.params.push(...params);
    return this;
  }
  toString(): string {
    if (!this.resource || this.fields.length === 0) throw new GaqlError("a query needs fields and a resource", "internal");
    return [`SELECT ${this.fields.join(", ")}`, `FROM ${this.resource}`, this.conds.length ? `WHERE ${this.conds.join(" AND ")}` : "", this.order.length ? `ORDER BY ${this.order.join(", ")}` : "", this.max ? `LIMIT ${this.max}` : "", this.params.length ? `PARAMETERS ${this.params.join(", ")}` : ""].filter(Boolean).join(" ");
  }
}

/** Reads a GAQL field ("campaign.start_date") from a REST result row, which uses camelCase JSON names. */
export function pick(row: Record<string, unknown>, field: string): unknown {
  let cur: unknown = row;
  for (const part of field.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())];
  }
  return cur;
}

/*
 * Zero, missing and unavailable (M2 output convention):
 * - Counter metrics (impressions, clicks, cost_micros, conversions, ...) absent from a row are 0. Google Ads JSON is proto3,
 *   which omits fields at their default value, so an absent counter on a returned row means zero activity
 *   [inferred from proto3 JSON mapping; not stated for each metric in the Google Ads docs]. num() and fromMicros() do this.
 * - Attributes (names, statuses, bids, quality scores) absent from a row are null: unknown, never 0. Use str() or an
 *   explicit undefined check, not num().
 * - Derived ratios with a zero denominator (CTR without impressions, CPA without conversions) are null, via ratio().
 * - A row that does not exist at all (an entity with no activity in the period) is not reported, rather than reported as 0.
 */

/** Micros (1/1,000,000 of a currency unit) to units. Google returns 64-bit integers as strings in JSON. */
export const fromMicros = (v: unknown): number => (v === undefined || v === null ? 0 : Number(v) / 1_000_000);
export const num = (v: unknown): number => (v === undefined || v === null || v === "" ? 0 : Number(v));
