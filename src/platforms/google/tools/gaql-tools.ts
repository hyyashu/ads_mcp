import { z } from "zod";
import { ToolError, toToolError } from "../../../mcp/errors";
import type { Row } from "../client";
import { fromMicros } from "../gaql";
import { accountId, googleRead } from "./common";

const MAX_QUERY_CHARS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_FIELD_PAGES = 5;

const snakeToCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const camelToSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** Validates a caller-supplied GAQL query is a non-empty read-only SELECT statement within the length limit. */
function validateSelectQuery(raw: string): string {
  const q = raw.trim();
  if (!q) throw new ToolError("invalid_argument", "GAQL query cannot be empty.");
  if (q.length > MAX_QUERY_CHARS) throw new ToolError("invalid_argument", `GAQL query exceeds the ${MAX_QUERY_CHARS}-character limit.`);
  if (!/^SELECT\b/i.test(q)) throw new ToolError("invalid_argument", "Only read-only GAQL SELECT queries are allowed.");
  return q;
}

/**
 * Extracts selected GAQL field names and maps their REST camelCase dotted paths back to the exact snake_case names
 * requested in SELECT (falling back to camelToSnake for auto-included fields such as resourceName).
 */
function buildSelectPathMap(query: string): Map<string, string> {
  const m = /^\s*SELECT\s+([\s\S]*?)\s+FROM\b/i.exec(query);
  const map = new Map<string, string>();
  if (!m) return map;
  for (const part of m[1]!.split(",")) {
    const field = part.trim();
    if (!field || !/^[a-z][a-z0-9_.]*$/i.test(field)) continue;
    const camelPath = field
      .split(".")
      .map((seg) => snakeToCamel(seg))
      .join(".");
    map.set(camelPath, field);
  }
  return map;
}

/** Flattens a nested Google Ads REST row into dotted snake_case keys and converts every *_micros field to units. */
export function cleanGaqlRow(row: Row, selectMap: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const toSnakePath = (camelPath: string) => selectMap.get(camelPath) ?? camelPath.split(".").map(camelToSnake).join(".");

  const walk = (val: unknown, path: string) => {
    if (val === undefined) return;
    if (val === null || typeof val !== "object" || Array.isArray(val)) {
      out[toSnakePath(path)] = val;
      return;
    }
    const entries = Object.entries(val as Record<string, unknown>);
    if (entries.length === 0) {
      out[toSnakePath(path)] = {};
      return;
    }
    for (const [k, v] of entries) walk(v, path ? `${path}.${k}` : k);
  };

  walk(row, "");

  // Add currency-unit siblings for every *_micros scalar field without clobbering any existing key.
  for (const [k, v] of Object.entries(out)) {
    if (!k.endsWith("_micros")) continue;
    const isNumeric = (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^-?\d+$/.test(v.trim()));
    if (!isNumeric) continue;
    const unitKey = k.slice(0, -"_micros".length);
    if (!(unitKey in out)) out[unitKey] = fromMicros(v);
  }
  return out;
}

const byteLen = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

/** Packs single-query rows within MAX_RESPONSE_BYTES, setting truncated=true if any rows were cut. */
function packSingle(rows: Record<string, unknown>[], alreadyTruncated: boolean): { rows: Record<string, unknown>[]; truncated: boolean; size_capped: boolean } {
  const kept: Record<string, unknown>[] = [];
  let sizeCapped = false;
  for (const row of rows) {
    kept.push(row);
    if (byteLen({ rows: kept, row_count: kept.length, truncated: true, size_capped: true }) > MAX_RESPONSE_BYTES) {
      kept.pop();
      sizeCapped = true;
      break;
    }
  }
  if (rows.length > 0 && kept.length === 0) {
    throw new ToolError("unsupported", "A single GAQL row exceeded the 256 KB response size limit. Select fewer fields and try again.");
  }
  return { rows: kept, truncated: alreadyTruncated || sizeCapped, size_capped: sizeCapped };
}

interface BatchEntry {
  name: string;
  ok: boolean;
  rows: Record<string, unknown>[];
  alreadyTruncated: boolean;
  error?: { code: string; message: string };
}

/** Packs multi-query results round-robin so one huge query cannot starve the remaining queries under MAX_RESPONSE_BYTES. */
function packBatch(entries: BatchEntry[]) {
  const packed = entries.map((e) => ({
    name: e.name,
    ok: e.ok,
    rows: [] as Record<string, unknown>[],
    row_count: 0,
    truncated: e.alreadyTruncated,
    ...(e.error ? { error: e.error } : {}),
  }));
  const indices = entries.map(() => 0);
  let sizeCapped = false;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < entries.length; i++) {
      const src = entries[i]!;
      const idx = indices[i]!;
      if (!src.ok || idx >= src.rows.length) continue;
      const dst = packed[i]!;
      dst.rows.push(src.rows[idx]!);
      dst.row_count = dst.rows.length;
      if (byteLen({ results: packed, size_capped: true }) > MAX_RESPONSE_BYTES) {
        dst.rows.pop();
        dst.row_count = dst.rows.length;
        dst.truncated = true;
        sizeCapped = true;
      } else {
        indices[i] = idx + 1;
        progressed = true;
      }
    }
    if (sizeCapped) {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i]!.ok && indices[i]! < entries[i]!.rows.length) packed[i]!.truncated = true;
      }
      break;
    }
  }
  return { results: packed, size_capped: sizeCapped };
}

// ------------------------------------------------------------------------------------------------------------ run_gaql
const queryItem = z.object({
  name: z.string().trim().min(1).max(64).describe("Label for this query in the response."),
  query: z.string().min(1).max(MAX_QUERY_CHARS).describe("GAQL SELECT query (max 10,000 characters). Omit LIMIT and use the limit parameter so truncation is detected accurately."),
});

const batchResultSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  rows: z.array(z.record(z.string(), z.unknown())),
  row_count: z.number(),
  truncated: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export const runGaql = googleRead({
  name: "run_gaql",
  title: "Run GAQL query",
  description:
    "Runs one read-only Google Ads Query Language (GAQL) SELECT query, or up to 10 named queries in parallel, against Google Ads and returns flattened rows with *_micros fields also converted to account currency units. Use this when fixed reporting tools do not cover the resource, fields, or breakdown needed, and use get_gaql_fields to discover valid field names. Omit LIMIT in the query and use the limit parameter (default 200, max 1000) so truncated is reported accurately. Total response size is capped at 256 KB. Fetched live.",
  input: z
    .object({
      account_id: accountId,
      query: z.string().min(1).max(MAX_QUERY_CHARS).optional().describe("Single GAQL SELECT query (max 10,000 characters)."),
      queries: z.array(queryItem).min(1).max(10).optional().describe("Up to 10 named GAQL SELECT queries run in parallel. One failed query returns its error without failing the others."),
      limit: z.number().int().min(1).max(1000).default(200).describe("Maximum rows returned per query (default 200, max 1000)."),
    })
    .refine((v) => (v.query !== undefined) !== (v.queries !== undefined), "Provide either query or queries, not both."),
  output: z.object({
    rows: z.array(z.record(z.string(), z.unknown())).optional(),
    row_count: z.number().optional(),
    truncated: z.boolean().optional(),
    results: z.array(batchResultSchema).optional(),
    size_capped: z.boolean().describe("True when the 256 KB response size cap cut off rows."),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    if (a.query !== undefined) {
      const q = validateSelectQuery(a.query);
      const selectMap = buildSelectPathMap(q);
      const fetched = await ads.query(q, { maxRows: a.limit + 1, partial: true });
      const cleaned = fetched.slice(0, a.limit).map((r) => cleanGaqlRow(r, selectMap));
      const packed = packSingle(cleaned, fetched.length > a.limit);
      return { rows: packed.rows, row_count: packed.rows.length, truncated: packed.truncated, size_capped: packed.size_capped };
    }

    const items = a.queries!;
    const names = new Set<string>();
    const validated = items.map((it) => {
      if (names.has(it.name)) throw new ToolError("invalid_argument", `Duplicate query name "${it.name}" in queries.`);
      names.add(it.name);
      const q = validateSelectQuery(it.query);
      return { name: it.name, query: q, selectMap: buildSelectPathMap(q) };
    });

    const entries: BatchEntry[] = await Promise.all(
      validated.map(async (it): Promise<BatchEntry> => {
        try {
          const fetched = await ads.query(it.query, { maxRows: a.limit + 1, partial: true });
          const cleaned = fetched.slice(0, a.limit).map((r) => cleanGaqlRow(r, it.selectMap));
          return { name: it.name, ok: true, rows: cleaned, alreadyTruncated: fetched.length > a.limit };
        } catch (err) {
          const te = toToolError(err);
          if (te.code === "cancelled" || te.code === "deadline_exceeded" || te.code === "auth_expired") throw te;
          return { name: it.name, ok: false, rows: [], alreadyTruncated: false, error: { code: te.code, message: te.message } };
        }
      }),
    );

    return packBatch(entries);
  },
});

// ----------------------------------------------------------------------------------------------------- get_gaql_fields
interface GoogleAdsFieldRow {
  name?: string;
  category?: string;
  dataType?: string;
  selectable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  isRepeated?: boolean;
  enumValues?: string[];
  attributeResources?: string[];
  metrics?: string[];
  segments?: string[];
  selectableWith?: string[];
}

const fieldSchema = z.object({
  name: z.string(),
  category: z.string().nullable(),
  data_type: z.string().nullable(),
  selectable: z.boolean(),
  filterable: z.boolean(),
  sortable: z.boolean(),
  is_repeated: z.boolean(),
  enum_values: z.array(z.string()),
});

export const getGaqlFields = googleRead({
  name: "get_gaql_fields",
  title: "Inspect GAQL resource fields",
  description:
    "Queries Google Ads Field Service (googleAdsFields:search) for a GAQL resource (such as campaign, keyword_view, ad_group_ad, search_term_view) and returns: (1) the resource's own fields with data type, selectable/filterable/sortable flags and enum values, (2) related resources whose fields can be selected alongside it, (3) compatible metrics, and (4) compatible segments. Pass filter (e.g. 'cost', 'metrics', 'status') to narrow large lists.",
  input: z.object({
    account_id: accountId,
    resource: z.string().trim().regex(/^[a-z][a-z0-9_]*$/, "snake_case GAQL resource name (e.g. campaign, keyword_view)"),
    filter: z.string().trim().min(1).max(100).optional().describe("Optional case-insensitive substring filter applied to field, resource, metric and segment names."),
    limit: z.number().int().min(1).max(1000).default(200).describe("Maximum items returned per section (default 200, max 1000)."),
  }),
  output: z.object({
    resource: z.string(),
    own_fields: z.array(fieldSchema),
    related_resources: z.array(z.string()),
    metrics: z.array(z.string()),
    segments: z.array(z.string()),
    counts: z.object({ own_fields: z.number(), related_resources: z.number(), metrics: z.number(), segments: z.number() }),
    truncated: z.boolean(),
  }),
  handler: async (a, ctx) => {
    const ads = ctx.services.ads;
    const searchFields = (query: string, pageSize: number, pageToken?: string) =>
      ads.rpc<{ results?: GoogleAdsFieldRow[]; nextPageToken?: string }>("googleAdsFields:search", {
        query,
        pageSize,
        ...(pageToken ? { pageToken } : {}),
      });

    const resourceQuery = `SELECT name, category, data_type, selectable, filterable, sortable, selectable_with, attribute_resources, metrics, segments WHERE name = '${a.resource}'`;
    const childrenQuery = `SELECT name, category, data_type, selectable, filterable, sortable, is_repeated, enum_values WHERE name LIKE '${a.resource}.%'`;

    const [resPage, firstFieldsPage] = await Promise.all([searchFields(resourceQuery, 10), searchFields(childrenQuery, 10_000)]);
    const resRow = (resPage.results ?? [])[0];
    const fieldRows: GoogleAdsFieldRow[] = [...(firstFieldsPage.results ?? [])];

    let nextToken = firstFieldsPage.nextPageToken;
    for (let page = 1; nextToken && page < MAX_FIELD_PAGES; page++) {
      const more = await searchFields(childrenQuery, 10_000, nextToken);
      fieldRows.push(...(more.results ?? []));
      nextToken = more.nextPageToken;
    }

    if (!resRow && fieldRows.length === 0) {
      throw new ToolError("not_found", `Unknown Google Ads resource or field prefix "${a.resource}".`);
    }

    const needle = a.filter?.toLowerCase();
    const matches = (s: string) => !needle || s.toLowerCase().includes(needle);

    const ownAll = fieldRows
      .filter((r) => typeof r.name === "string" && matches(r.name))
      .map((r) => ({
        name: r.name!,
        category: r.category ?? null,
        data_type: r.dataType ?? null,
        selectable: Boolean(r.selectable),
        filterable: Boolean(r.filterable),
        sortable: Boolean(r.sortable),
        is_repeated: Boolean(r.isRepeated),
        enum_values: Array.isArray(r.enumValues) ? r.enumValues.map(String) : [],
      }))
      .sort((x, y) => x.name.localeCompare(y.name));

    const relatedRaw = resRow?.attributeResources?.length
      ? resRow.attributeResources
      : (resRow?.selectableWith ?? []).filter((s) => !s.startsWith("metrics.") && !s.startsWith("segments."));
    const relatedAll = [...new Set(relatedRaw)].filter(matches).sort();
    const metricsAll = [...new Set(resRow?.metrics ?? [])].filter(matches).sort();
    const segmentsAll = [...new Set(resRow?.segments ?? [])].filter(matches).sort();

    const truncated =
      ownAll.length > a.limit || relatedAll.length > a.limit || metricsAll.length > a.limit || segmentsAll.length > a.limit || Boolean(nextToken);

    return {
      resource: a.resource,
      own_fields: ownAll.slice(0, a.limit),
      related_resources: relatedAll.slice(0, a.limit),
      metrics: metricsAll.slice(0, a.limit),
      segments: segmentsAll.slice(0, a.limit),
      counts: {
        own_fields: ownAll.length,
        related_resources: relatedAll.length,
        metrics: metricsAll.length,
        segments: segmentsAll.length,
      },
      truncated,
    };
  },
});

export const gaqlTools = [runGaql, getGaqlFields];
