/**
 * GAQL query builder. User-controlled values can only enter a query through the `lit` helpers, which validate or
 * escape them, so a value can never change the structure of a query (no GAQL injection). Field and resource names
 * are checked against a strict pattern.
 */
const FIELD = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const RESOURCE = /^[a-z][a-z0-9_]*$/;

export class GaqlError extends Error {}

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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new GaqlError("expected a date as YYYY-MM-DD");
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

  select(...fields: string[]): this {
    for (const f of fields) if (!FIELD.test(f)) throw new GaqlError(`invalid field name: ${f}`);
    this.fields.push(...fields);
    return this;
  }
  from(resource: string): this {
    if (!RESOURCE.test(resource)) throw new GaqlError(`invalid resource name: ${resource}`);
    this.resource = resource;
    return this;
  }
  /** `condition` must be built from field names and `lit.*` values only. */
  where(condition: string | false | undefined | null): this {
    if (condition) this.conds.push(condition);
    return this;
  }
  orderBy(field: string, dir: "ASC" | "DESC" = "ASC"): this {
    if (!FIELD.test(field)) throw new GaqlError(`invalid field name: ${field}`);
    this.order.push(`${field} ${dir}`);
    return this;
  }
  limit(n: number): this {
    if (!Number.isSafeInteger(n) || n < 1 || n > 10_000) throw new GaqlError("limit must be 1 to 10000");
    this.max = n;
    return this;
  }
  toString(): string {
    if (!this.resource || this.fields.length === 0) throw new GaqlError("a query needs fields and a resource");
    return [`SELECT ${this.fields.join(", ")}`, `FROM ${this.resource}`, this.conds.length ? `WHERE ${this.conds.join(" AND ")}` : "", this.order.length ? `ORDER BY ${this.order.join(", ")}` : "", this.max ? `LIMIT ${this.max}` : ""].filter(Boolean).join(" ");
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

/** Micros (1/1,000,000 of a currency unit) to units. Google returns 64-bit integers as strings in JSON. */
export const fromMicros = (v: unknown): number => (v === undefined || v === null ? 0 : Number(v) / 1_000_000);
export const num = (v: unknown): number => (v === undefined || v === null || v === "" ? 0 : Number(v));
