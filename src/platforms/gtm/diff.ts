import type { Change, Effect } from "../../policy/change-set";
import { canonicalJson, sha256 } from "../../security/canonical";
import { conditionText, cut, msIso, param, paramText, stripVolatile } from "./model";
import type { GtmBuiltIn, GtmTag, GtmTrigger, GtmVariable, GtmVersion, Row } from "./types";

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
  /** Custom HTML (tag type html) code before / after, in full. */
  html?: { before: string | null; after: string | null };
}
export interface CoarseEntry {
  kind: CoarseKind;
  name: string;
  status: "added" | "removed" | "changed";
  detail: string | null;
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

const html = (t: GtmTag) => (t.type === "html" ? (param(t.parameter, "html")?.value ?? null) : null);

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
    ...(t.parameter ?? []).filter((p) => !(t.type === "html" && p.key === "html")).map((p): [string, string | null] => [`parameter.${p.key ?? "?"}`, paramText(p)]),
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
    ...(v.parameter ?? []).map((p): [string, string | null] => [`parameter.${p.key ?? "?"}`, paramText(p)]),
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

  const compare = <T extends object>(kind: DiffKind, before: T[], after: T[], idOf: (x: T) => string, nameOf: (x: T) => string, describe: (x: T, old: boolean) => DiffField[], htmlOf: (x: T) => string | null) => {
    const bm = new Map(before.map((x) => [idOf(x), x]));
    const am = new Map(after.map((x) => [idOf(x), x]));
    for (const [id, x] of am) {
      const was = bm.get(id);
      if (!was) entries.push({ kind, id, name: nameOf(x), status: "added", fields: describe(x, false), ...(htmlOf(x) !== null ? { html: { before: null, after: htmlOf(x) } } : {}) });
      else if (!same(was, x)) {
        const fields = changedFields(describe(was, true), describe(x, false));
        const h = htmlOf(was) !== htmlOf(x) ? { before: htmlOf(was), after: htmlOf(x) } : undefined;
        if (!fields.length && !h) fields.push({ field: "other settings", before: "(as before)", after: "changed (a setting this summary does not show)" });
        entries.push({ kind, id, name: nameOf(x), status: "changed", fields, ...(h ? { html: h } : {}) });
      }
    }
    for (const [id, x] of bm) if (!am.has(id)) entries.push({ kind, id, name: nameOf(x), status: "removed", fields: describe(x, true).map((f) => ({ field: f.field, before: f.after, after: null })), ...(htmlOf(x) !== null ? { html: { before: htmlOf(x), after: null } } : {}) });
  };
  compare<GtmTag>("tag", live?.tag ?? [], target.tag ?? [], (t) => t.tagId ?? "", (t) => t.name ?? "", (t, old) => describeTag(t, old ? namesOld : namesNew), html);
  compare<GtmTrigger>("trigger", live?.trigger ?? [], target.trigger ?? [], (t) => t.triggerId ?? "", (t) => t.name ?? "", (t) => describeTrigger(t), () => null);
  compare<GtmVariable>("variable", live?.variable ?? [], target.variable ?? [], (v) => v.variableId ?? "", (v) => v.name ?? "", (v) => describeVariable(v), () => null);
  compare<GtmBuiltIn>("built_in_variable", live?.builtInVariable ?? [], target.builtInVariable ?? [], (b) => b.type ?? "", (b) => b.name ?? b.type ?? "", describeBuiltIn, () => null);
  entries.sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || x.name.localeCompare(y.name) || x.id.localeCompare(y.id, undefined, { numeric: true }));

  const coarse: CoarseEntry[] = [];
  for (const [kind, key] of COARSE) {
    const nm = (x: Row) => String(x.name ?? "");
    const bm = new Map(((live?.[key] as Row[] | undefined) ?? []).map((x) => [nm(x), x]));
    const am = new Map(((target[key] as Row[] | undefined) ?? []).map((x) => [nm(x), x]));
    for (const [name, x] of am) {
      const was = bm.get(name);
      if (!was) coarse.push({ kind, name, status: "added", detail: null });
      else if (!same(was, x)) {
        const code = kind === "custom_template" && was.templateData !== x.templateData ? `code changed (sha256 ${sha256(String(was.templateData ?? "")).slice(0, 12)} → ${sha256(String(x.templateData ?? "")).slice(0, 12)})` : "settings changed";
        coarse.push({ kind, name, status: "changed", detail: code });
      }
    }
    for (const name of bm.keys()) if (!am.has(name)) coarse.push({ kind, name, status: "removed", detail: null });
  }
  coarse.sort((x, y) => COARSE.findIndex((c) => c[0] === x.kind) - COARSE.findIndex((c) => c[0] === y.kind) || x.name.localeCompare(y.name));

  return { entries, coarse, rows: toRows(entries, coarse), sha256: sha256(canonicalJson({ entries, coarse })) };
}

function toRows(entries: DiffEntry[], coarse: CoarseEntry[]): Change[] {
  const rows: Change[] = [];
  for (const e of entries) {
    const ref = { resource: `gtm_${e.kind}`, id: e.id, name: e.name };
    const brief = e.fields.filter((f) => ["type", "firing triggers"].includes(f.field) || f.field.startsWith("filter") || f.field.startsWith("customEventFilter"));
    if (e.status === "added") {
      rows.push({ ...ref, field: e.kind, before: null, after: cell(brief.map((f) => `${f.field}: ${f.after}`).join(" · ") || "added"), unit: "text", effect: "create" });
      if (e.html) rows.push({ ...ref, field: "parameter.html", before: null, after: e.html.after, unit: "text", effect: "create" });
    } else if (e.status === "removed") {
      rows.push({ ...ref, field: e.kind, before: cell(brief.map((f) => `${f.field}: ${f.before}`).join(" · ") || "present"), after: null, unit: "text", effect: "remove" });
      if (e.html) rows.push({ ...ref, field: "parameter.html", before: e.html.before, after: null, unit: "text", effect: "remove" });
    } else {
      for (const f of e.fields) {
        const effect: Effect = f.field === "paused" ? (f.after === "true" ? "pause" : "enable") : "neutral";
        rows.push({ ...ref, field: f.field, before: cell(f.before), after: cell(f.after), unit: "text", effect });
      }
      if (e.html) rows.push({ ...ref, field: "parameter.html", before: e.html.before, after: e.html.after, unit: "text", effect: "neutral" });
    }
  }
  for (const c of coarse) rows.push({ resource: `gtm_${c.kind}`, id: c.name, name: c.name, field: c.kind, before: c.status === "added" ? null : "present", after: c.status === "removed" ? null : (c.detail ?? "added"), unit: "text", effect: c.status === "added" ? "create" : c.status === "removed" ? "remove" : "neutral" });
  return rows;
}

/** Longest custom HTML code in a diff (approval pages show it in full, so it is bounded). */
export const longestHtml = (d: Diff) => Math.max(0, ...d.entries.flatMap((e) => [e.html?.before?.length ?? 0, e.html?.after?.length ?? 0]));
