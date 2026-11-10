import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Checks requests against Google's published v26 REST schema (inventory/google-ads-v26-schema.json, built from the
 * discovery document by scripts/build-google-schema-index.py). The Google test harness runs every request through it, so
 * a GAQL field, enum value or mutate body field that does not exist in the API fails the test that sent it.
 */
type Prop = { ref?: string; type?: string; enum?: string[]; array?: boolean };
const index = JSON.parse(readFileSync(join(__dirname, "../../../inventory/google-ads-v26-schema.json"), "utf8")) as { version: string; schemas: Record<string, Record<string, Prop>> };
export const SCHEMA_VERSION = index.version;
/** Selection rules per FROM resource, from the v26 field reference pages (scripts/fetch-google-gaql-rules.py). */
const rules = JSON.parse(readFileSync(join(__dirname, "../../../inventory/google-ads-v26-gaql.json"), "utf8")) as {
  segments_selectable_with?: Record<string, string[]>;
  resources: Record<string, { attributed: string[]; segmenting?: string[]; fields: Record<string, { selectable: boolean | null; filterable: boolean | null }>; from_metrics_segments: string[] }>;
};
/** Date segments a WHERE clause may filter on without selecting them (developers.google.com/google-ads/api/docs/query/structure). */
const CORE_DATE_SEGMENTS = new Set(["segments.date", "segments.week", "segments.month", "segments.quarter", "segments.year"]);

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Resolves a GAQL field path (e.g. campaign.network_settings.target_search_network) to its schema property. */
export function resolveField(path: string): Prop | null {
  const parts = path.split(".");
  let schema = "Services__GoogleAdsRow";
  let prop: Prop | null = null;
  for (const raw of parts) {
    const props = index.schemas[schema];
    if (!props) return null;
    prop = props[camel(raw)] ?? null;
    if (!prop) return null;
    if (prop.ref) schema = prop.ref;
  }
  return prop;
}

const RESERVED = new Set(["SELECT", "FROM", "WHERE", "AND", "OR", "ORDER", "BY", "LIMIT", "PARAMETERS", "DESC", "ASC", "IN", "NOT", "LIKE", "IS", "NULL", "DURING", "BETWEEN", "CONTAINS", "ANY", "ALL", "NONE", "REGEXP_MATCH", "TRUE", "FALSE"]);

/** Problems with a GAQL query: unknown resource or fields, and enum literals that are not values of the compared field. */
export function checkGaql(query: string): string[] {
  const problems: string[] = [];
  const noStrings = query.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
  const from = /\bFROM\s+([a-z_]+)/i.exec(noStrings)?.[1];
  if (!from || !resolveField(from)) problems.push(`unknown FROM resource: ${from}`);
  for (const m of noStrings.matchAll(/\b([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\b/g)) {
    if (!resolveField(m[1]!)) problems.push(`unknown field: ${m[1]}`);
  }
  // field = 'ENUM' / field IN ('A', 'B') / field != 'X': check enum literals against the field's enum.
  for (const m of query.matchAll(/\b([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\s*(=|!=|IN|NOT IN)\s*(\([^)]*\)|'[^']*')/gi)) {
    const p = resolveField(m[1]!);
    if (!p?.enum) continue;
    for (const lit of m[3]!.matchAll(/'([^']*)'/g)) if (!p.enum.includes(lit[1]!)) problems.push(`${m[1]}: '${lit[1]}' is not a valid value`);
  }
  // Which fields may appear with this FROM resource, and whether they may be selected / filtered.
  const r = from ? rules.resources[from] : undefined;
  if (from && resolveField(from) && !r) problems.push(`no GAQL rules recorded for ${from}: run scripts/fetch-google-gaql-rules.py v26 ${from}`);
  if (r) {
    const segmenting = new Set(r.segmenting ?? []);
    const allowed = new Set([from!, ...r.attributed, ...segmenting, "metrics", "segments"]);
    const select = /SELECT\s+(.*?)\s+FROM\s/is.exec(noStrings)?.[1] ?? "";
    const where = /\bWHERE\s+(.*?)(?:\s+ORDER BY\s|\s+LIMIT\s|$)/is.exec(noStrings)?.[1] ?? "";
    const fieldsIn = (part: string) => [...part.matchAll(/\b([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\b/g)].map((m) => m[1]!);
    const metricsOk = new Set(r.from_metrics_segments);
    for (const f of [...fieldsIn(select), ...fieldsIn(where)]) {
      const owner = f.split(".")[0]!;
      if (!allowed.has(owner)) problems.push(`${f} cannot be used with FROM ${from}`);
      // Only metrics and segments the field reference marks as usable with this FROM resource.
      else if ((owner === "metrics" || owner === "segments") && !metricsOk.has(f)) problems.push(`${f} cannot be used with FROM ${from}`);
    }
    for (const f of fieldsIn(select)) if (r.fields[f]?.selectable === false) problems.push(`${f} is not selectable`);
    // Segments in WHERE must also be selected, except core date segments. Fields of a segmenting resource act as segments.
    const selected = new Set(fieldsIn(select));
    for (const f of new Set(fieldsIn(where))) {
      const owner = f.split(".")[0]!;
      const isSegment = (owner === "segments" && !CORE_DATE_SEGMENTS.has(f)) || segmenting.has(owner);
      if (isSegment && !selected.has(f)) problems.push(`${f} is filtered in WHERE but not selected (FROM ${from} treats it as a segment)`);
    }
    // Every segment in the query must be selectable with each selected metric and segment (its "Selectable with" list on
    // the v26 segments reference page). A segment missing from the record is not checked.
    const compat = rules.segments_selectable_with ?? {};
    for (const seg of new Set([...selected, ...fieldsIn(where)])) {
      const ok = seg.startsWith("segments.") ? compat[seg] : undefined;
      if (!ok) continue;
      for (const f of selected) if (f !== seg && (f.startsWith("metrics.") || f.startsWith("segments.")) && !ok.includes(f)) problems.push(`${f} cannot be selected with ${seg}`);
    }
    // Selecting a core date segment requires a finite range on one in WHERE.
    if ([...selected].some((f) => CORE_DATE_SEGMENTS.has(f)) && !fieldsIn(where).some((f) => CORE_DATE_SEGMENTS.has(f)))
      problems.push(`a core date segment is selected but WHERE has no date range`);
    // GAQL selects only the fields in Google's field reference. A path below one of them (a sub-field of a message such as
    // recommendation.campaign_budget_recommendation) exists in the REST schema but is rejected by the API as unrecognized.
    for (const f of [...fieldsIn(select), ...fieldsIn(where)]) {
      if (r.fields[f]) continue;
      const parts = f.split(".");
      for (let i = parts.length - 1; i > 1; i--) {
        const parent = parts.slice(0, i).join(".");
        if (r.fields[parent]) {
          problems.push(`${f} is not a GAQL field: select ${parent} and read the sub-field from the response`);
          break;
        }
      }
    }
    for (const f of fieldsIn(where)) if (r.fields[f]?.filterable === false) problems.push(`${f} is not filterable`);
  }
  for (const w of noStrings.match(/\b[A-Z_]{2,}\b/g) ?? []) if (!RESERVED.has(w) && !/^LAST_|^THIS_|^TODAY|^YESTERDAY/.test(w)) problems.push(`unexpected keyword: ${w}`);
  return problems;
}

/** Unknown keys (and invalid enum values) in a request body, checked recursively against a schema. */
export function checkBody(schema: string, body: unknown, at = ""): string[] {
  const props = index.schemas[schema];
  if (!props) return [`${at || "(body)"}: unknown schema ${schema}`];
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    const p = props[k];
    const here = at ? `${at}.${k}` : k;
    if (!p) {
      out.push(`${here}: not a field of ${schema}`);
      continue;
    }
    const items = p.array ? (Array.isArray(v) ? v : [v]) : [v];
    for (const item of items) {
      if (p.ref && item && typeof item === "object") out.push(...checkBody(p.ref, item, here));
      else if (p.enum && typeof item === "string" && !p.enum.includes(item)) out.push(`${here}: '${item}' is not a valid value`);
    }
  }
  return out;
}

/** The request schema for a REST path such as customers/1/campaigns:mutate or customers/1/googleAds:search. */
export function requestSchemaFor(path: string): string | null {
  const m = /(?:^|\/)([A-Za-z]+|\d+):([A-Za-z]+)$/.exec(path);
  if (!m) return null;
  const [, service, method] = m;
  const M = method![0]!.toUpperCase() + method!.slice(1);
  // customers/{id}:generateKeywordIdeas and similar: the request is named after the method alone.
  if (/^\d+$/.test(service!)) return index.schemas[`Services__${M}Request`] ? `Services__${M}Request` : null;
  const pascal = service![0]!.toUpperCase() + service!.slice(1);
  if (service === "googleAds") return method === "mutate" ? "Services__MutateGoogleAdsRequest" : method === "searchStream" ? "Services__SearchGoogleAdsStreamRequest" : "Services__SearchGoogleAdsRequest";
  const name = `Services__${M}${pascal}Request`;
  if (index.schemas[name]) return name;
  // Single-resource services name the request in the singular: productLinks:create -> CreateProductLinkRequest.
  const singular = `Services__${M}${pascal.replace(/s$/, "")}Request`;
  return index.schemas[singular] ? singular : null;
}

/** All problems with one Google Ads REST request (path and JSON body). */
export function checkRequest(path: string, body: unknown): string[] {
  const schema = requestSchemaFor(path);
  const out: string[] = [];
  if (!schema) {
    if (/:[a-zA-Z]+$/.test(path)) out.push(`no request schema for ${path}`);
    return out;
  }
  out.push(...checkBody(schema, body).map((p) => `${path}: ${p}`));
  const q = (body as { query?: unknown } | null)?.query;
  if (typeof q === "string") out.push(...checkGaql(q).map((p) => `GAQL: ${p}`));
  return out;
}
