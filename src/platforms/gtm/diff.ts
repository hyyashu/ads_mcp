import type { Change, Effect } from "../../policy/change-set";
import { canonicalJson, sha256 } from "../../security/canonical";
import { conditionText, cut, msIso, param, paramText, stripVolatile } from "./model";
import type { GtmBuiltIn, GtmParameter, GtmTag, GtmTrigger, GtmVariable, GtmVersion, Row } from "./types";

/**
 * Difference between two container versions (normally the live one and the one to publish), for the publish approval.
 * Pure and deterministic. Entities are matched by id (built-in variables by type; the coarse kinds, whose id fields are not
 * all documented, by name) and compared on their projection without location and fingerprint.
 */
export type DiffKind = "tag" | "trigger" | "variable" | "built_in_variable";
export type CoarseKind = "folder" | "custom_template" | "client" | "zone" | "gtag_config" | "transformation";
export interface DiffField {
  field: string;
  before: string | null;
  after: string | null;
}
export interface DiffEntry {
  kind: DiffKind;
  id: string;
  name: string;
  status: "added" | "removed" | "changed";
  /** For added / removed: the entity described; for changed: only the fields that differ. */
  fields: DiffField[];
  /**
   * Code before / after, never cut: custom HTML (tag type html, field "parameter.html") or Custom JavaScript (variable type
   * jsm, field "parameter.javascript"). Shown in its own row; bounded by PUBLISH_MAX_CODE in publish_gtm_version.
   */
  code?: DiffField;
}
export interface CoarseEntry {
  kind: CoarseKind;
  name: string;
  status: "added" | "removed" | "changed";
  detail: string | null;
  /**
   * What the entity contains, never cut, one row each: "settings" (the entity as canonical JSON, without name, location and,
   * for a custom template, its code) and, for a custom template, "templateData" (its code). For changed: only parts that differ.
   */
  parts: DiffField[];
}
export interface Diff {
  entries: DiffEntry[];
  coarse: CoarseEntry[];
  rows: Change[];
  sha256: string;
}

const CELL_MAX = 2_000;
const cell = (s: string | null) => (s === null ? null : cut(s, CELL_MAX).text);
const KIND_ORDER: DiffKind[] = ["tag", "trigger", "variable", "built_in_variable"];
const COARSE: [CoarseKind, keyof GtmVersion][] = [
  ["folder", "folder"],
  ["custom_template", "customTemplate"],
  ["client", "client"],
  ["zone", "zone"],
  ["gtag_config", "gtagConfig"],
  ["transformation", "transformation"],
];

/** The parameter that holds an entity's code (shown in full, in its own row), or null. */
const codeKeyOfTag = (t: GtmTag) => (t.type === "html" ? "html" : null);
const codeKeyOfVariable = (v: GtmVariable) => (v.type === "jsm" ? "javascript" : null);
const codeOf = (params: GtmParameter[] | undefined, key: string | null): DiffField | null => (key === null ? null : { field: `parameter.${key}`, before: null, after: param(params, key)?.value ?? "" });

/** A tag as ordered field → text pairs (custom HTML code is reported separately, in full). */
export function describeTag(t: GtmTag, triggerNames: Map<string, string>): DiffField[] {
  const ids = (x: string[] | undefined) => (x?.length ? [...x].sort().map((id) => `${triggerNames.get(id) ?? "?"} (${id})`).join(", ") : null);
  const f: [string, string | null][] = [
    ["name", t.name ?? null],
    ["type", t.type ?? null],
    ["paused", String(t.paused === true)],
    ["live only", t.liveOnly ? "true" : null],
    ["firing option", t.tagFiringOption ?? null],
    ["firing triggers", ids(t.firingTriggerId)],
    ["blocking triggers", ids(t.blockingTriggerId)],
    ["priority", t.priority ? paramText(t.priority as never) : null],
    ["schedule start", msIso(t.scheduleStartMs)],
    ["schedule end", msIso(t.scheduleEndMs)],
    ["setup tag", t.setupTag?.length ? t.setupTag.map((x) => x.tagName ?? "?").join(", ") : null],
    ["teardown tag", t.teardownTag?.length ? t.teardownTag.map((x) => x.tagName ?? "?").join(", ") : null],
    ["consent", t.consentSettings ? `${t.consentSettings.consentStatus ?? "?"}${t.consentSettings.consentType?.list?.length ? `: ${t.consentSettings.consentType.list.map((x) => x.value).join(", ")}` : ""}` : null],
    ...(t.parameter ?? []).filter((p) => p.key !== codeKeyOfTag(t)).map((p): [string, string | null] => [`parameter.${p.key ?? "?"}`, paramText(p)]),
    ["monitoring metadata", t.monitoringMetadata ? canonicalJson(t.monitoringMetadata) : null],
    ["notes", t.notes ?? null],
  ];
  return f.filter(([, v]) => v !== null).map(([field, v]) => ({ field, before: null, after: v }));
}
export function describeTrigger(t: GtmTrigger): DiffField[] {
  const f: [string, string | null][] = [
    ["name", t.name ?? null],
    ["type", t.type ?? null],
    ...(["customEventFilter", "filter", "autoEventFilter"] as const).flatMap((k) => (t[k] ?? []).map((c, i): [string, string | null] => [`${k}[${i}]`, conditionText(c)])),
    ...(["waitForTags", "checkValidation", "waitForTagsTimeout", "eventName", "interval", "limit"] as const).map((k): [string, string | null] => [k, t[k] ? paramText(t[k] as never) : null]),
    ...(t.parameter ?? []).map((p): [string, string | null] => [`parameter.${p.key ?? "?"}`, paramText(p)]),
    ["notes", t.notes ?? null],
  ];
  return f.filter(([, v]) => v !== null).map(([field, v]) => ({ field, before: null, after: v }));
}
export function describeVariable(v: GtmVariable): DiffField[] {
  const f: [string, string | null][] = [
    ["name", v.name ?? null],
    ["type", v.type ?? null],
    ...(v.parameter ?? []).filter((p) => p.key !== codeKeyOfVariable(v)).map((p): [string, string | null] => [`parameter.${p.key ?? "?"}`, paramText(p)]),
    ["format value", v.formatValue ? canonicalJson(v.formatValue) : null],
    ["notes", v.notes ?? null],
  ];
  return f.filter(([, x]) => x !== null).map(([field, x]) => ({ field, before: null, after: x }));
}
const describeBuiltIn = (b: GtmBuiltIn): DiffField[] => [{ field: "name", before: null, after: b.name ?? b.type ?? "" }];

/** Fields that differ between two descriptions; a projection difference no described field shows is still reported. */
function changedFields(a: DiffField[], b: DiffField[]): DiffField[] {
  const am = new Map(a.map((x) => [x.field, x.after]));
  const bm = new Map(b.map((x) => [x.field, x.after]));
  const keys = [...new Set([...a.map((x) => x.field), ...b.map((x) => x.field)])];
  return keys.filter((k) => (am.get(k) ?? null) !== (bm.get(k) ?? null)).map((k) => ({ field: k, before: am.get(k) ?? null, after: bm.get(k) ?? null }));
}

const same = (a: object, b: object) => canonicalJson(stripVolatile(a)) === canonicalJson(stripVolatile(b));

export function diffVersions(live: GtmVersion | null, target: GtmVersion): Diff {
  const entries: DiffEntry[] = [];
  const namesOld = new Map((live?.trigger ?? []).map((t) => [t.triggerId ?? "", t.name ?? ""]));
  const namesNew = new Map((target.trigger ?? []).map((t) => [t.triggerId ?? "", t.name ?? ""]));

  const compare = <T extends object>(kind: DiffKind, before: T[], after: T[], idOf: (x: T) => string, nameOf: (x: T) => string, describe: (x: T, old: boolean) => DiffField[], codeOfX: (x: T) => DiffField | null) => {
    const bm = new Map(before.map((x) => [idOf(x), x]));
    const am = new Map(after.map((x) => [idOf(x), x]));
    for (const [id, x] of am) {
      const was = bm.get(id);
      const c = codeOfX(x);
      if (!was) entries.push({ kind, id, name: nameOf(x), status: "added", fields: describe(x, false), ...(c ? { code: c } : {}) });
      else if (!same(was, x)) {
        const fields = changedFields(describe(was, true), describe(x, false));
        const w = codeOfX(was);
        // A code field that appears, disappears (type change) or differs is shown in full, before and after.
        const code = (w || c) && w?.after !== c?.after ? { field: (c ?? w)!.field, before: w?.after ?? null, after: c?.after ?? null } : undefined;
        if (!fields.length && !code) fields.push({ field: "other settings", before: "(as before)", after: "changed (a setting this summary does not show)" });
        entries.push({ kind, id, name: nameOf(x), status: "changed", fields, ...(code ? { code } : {}) });
      }
    }
    for (const [id, x] of bm) {
      if (am.has(id)) continue;
      const c = codeOfX(x);
      entries.push({ kind, id, name: nameOf(x), status: "removed", fields: describe(x, true).map((f) => ({ field: f.field, before: f.after, after: null })), ...(c ? { code: { field: c.field, before: c.after, after: null } } : {}) });
    }
  };
  compare<GtmTag>("tag", live?.tag ?? [], target.tag ?? [], (t) => t.tagId ?? "", (t) => t.name ?? "", (t, old) => describeTag(t, old ? namesOld : namesNew), (t) => codeOf(t.parameter, codeKeyOfTag(t)));
  compare<GtmTrigger>("trigger", live?.trigger ?? [], target.trigger ?? [], (t) => t.triggerId ?? "", (t) => t.name ?? "", (t) => describeTrigger(t), () => null);
  compare<GtmVariable>("variable", live?.variable ?? [], target.variable ?? [], (v) => v.variableId ?? "", (v) => v.name ?? "", (v) => describeVariable(v), (v) => codeOf(v.parameter, codeKeyOfVariable(v)));
  compare<GtmBuiltIn>("built_in_variable", live?.builtInVariable ?? [], target.builtInVariable ?? [], (b) => b.type ?? "", (b) => b.name ?? b.type ?? "", describeBuiltIn, () => null);
  entries.sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || x.name.localeCompare(y.name) || x.id.localeCompare(y.id, undefined, { numeric: true }));

  const coarse: CoarseEntry[] = [];
  for (const [kind, key] of COARSE) {
    const nm = (x: Row) => String(x.name ?? "");
    const bm = new Map(((live?.[key] as Row[] | undefined) ?? []).map((x) => [nm(x), x]));
    const am = new Map(((target[key] as Row[] | undefined) ?? []).map((x) => [nm(x), x]));
    for (const [name, x] of am) {
      const was = bm.get(name);
      if (!was) coarse.push({ kind, name, status: "added", detail: null, parts: coarseParts(kind, x).map((p) => ({ field: p.field, before: null, after: p.text })) });
      else if (!same(was, x)) {
        const code = kind === "custom_template" && was.templateData !== x.templateData ? `code changed (sha256 ${sha256(String(was.templateData ?? "")).slice(0, 12)} → ${sha256(String(x.templateData ?? "")).slice(0, 12)})` : "settings changed";
        const b = new Map(coarseParts(kind, was).map((p) => [p.field, p.text]));
        const a = new Map(coarseParts(kind, x).map((p) => [p.field, p.text]));
        const parts = [...new Set([...b.keys(), ...a.keys()])].filter((f) => b.get(f) !== a.get(f)).map((f) => ({ field: f, before: b.get(f) ?? null, after: a.get(f) ?? null }));
        coarse.push({ kind, name, status: "changed", detail: code, parts });
      }
    }
    for (const [name, x] of bm) if (!am.has(name)) coarse.push({ kind, name, status: "removed", detail: null, parts: coarseParts(kind, x).map((p) => ({ field: p.field, before: p.text, after: null })) });
  }
  coarse.sort((x, y) => COARSE.findIndex((c) => c[0] === x.kind) - COARSE.findIndex((c) => c[0] === y.kind) || x.name.localeCompare(y.name));

  return { entries, coarse, rows: toRows(entries, coarse), sha256: sha256(canonicalJson({ entries, coarse })) };
}

/**
 * One approval row per described field. Added and removed entities show every field they have (the name is the row's item),
 * changed ones the fields that differ; code (custom HTML, Custom JavaScript, template code) gets its own row, in full.
 */
function toRows(entries: DiffEntry[], coarse: CoarseEntry[]): Change[] {
  const rows: Change[] = [];
  for (const e of entries) {
    const ref = { resource: `gtm_${e.kind}`, id: e.id, name: e.name };
    const effect: Effect = e.status === "added" ? "create" : e.status === "removed" ? "remove" : "neutral";
    const fields = e.status === "changed" ? e.fields : e.fields.filter((f) => f.field !== "name");
    if (e.status !== "changed") rows.push({ ...ref, field: e.kind, before: e.status === "removed" ? "present" : null, after: e.status === "added" ? "added" : null, unit: "text", effect });
    for (const f of fields) {
      const fx: Effect = e.status === "changed" && f.field === "paused" ? (f.after === "true" ? "pause" : "enable") : effect;
      rows.push({ ...ref, field: f.field, before: cell(f.before), after: cell(f.after), unit: "text", effect: fx });
    }
    if (e.code) rows.push({ ...ref, field: e.code.field, before: e.code.before, after: e.code.after, unit: "text", effect });
  }
  for (const c of coarse) {
    const ref = { resource: `gtm_${c.kind}`, id: c.name, name: c.name };
    const effect: Effect = c.status === "added" ? "create" : c.status === "removed" ? "remove" : "neutral";
    rows.push({ ...ref, field: c.kind, before: c.status === "added" ? null : "present", after: c.status === "removed" ? null : (c.detail ?? "added"), unit: "text", effect });
    for (const p of c.parts) rows.push({ ...ref, field: p.field, before: p.before, after: p.after, unit: "text", effect });
  }
  return rows;
}

/** Parts of a coarse entity shown in full: its settings as JSON and, for a custom template, its code. */
function coarseParts(kind: CoarseKind, x: Row): { field: string; text: string }[] {
  const { name: _n, templateData, ...rest } = stripVolatile(x) as Row;
  const settings = kind === "custom_template" ? rest : { ...rest, ...(templateData !== undefined ? { templateData } : {}) };
  const out: { field: string; text: string }[] = [];
  if (Object.keys(settings).length) out.push({ field: "settings", text: canonicalJson(settings) });
  if (kind === "custom_template") out.push({ field: "templateData", text: String(templateData ?? "") });
  return out;
}

/**
 * Longest value an approval page shows in full (custom HTML, Custom JavaScript, template code, coarse settings), so it can
 * be bounded: every other cell is cut at CELL_MAX.
 */
export const longestCode = (d: Diff) =>
  Math.max(0, ...d.entries.flatMap((e) => [e.code?.before?.length ?? 0, e.code?.after?.length ?? 0]), ...d.coarse.flatMap((c) => c.parts.flatMap((p) => [p.before?.length ?? 0, p.after?.length ?? 0])));
