import { z } from "zod";
import { canonicalJson } from "../../security/canonical";
import type { GtmBuiltIn, GtmCondition, GtmCustomTemplate, GtmParameter, GtmTag, GtmTrigger, GtmVariable } from "./types";

/**
 * Pure helpers over raw Tag Manager objects. Everything read from a container (names, notes, parameter values, custom HTML)
 * is untrusted text: it is returned as data and never acted on.
 */

/** Fields that identify where an entity lives or its storage version, not what it does. */
const VOLATILE = ["path", "accountId", "containerId", "workspaceId", "fingerprint", "tagManagerUrl"] as const;

/** The entity minus its location and fingerprint: what the drift checks and the diff compare. */
export function stripVolatile<T extends object>(x: T): Omit<T, (typeof VOLATILE)[number]> {
  const out: Record<string, unknown> = { ...(x as Record<string, unknown>) };
  for (const k of VOLATILE) delete out[k];
  return out as Omit<T, (typeof VOLATILE)[number]>;
}
/** Canonical JSON of the projection: equal when two entities do the same thing, wherever they are stored. */
export const sameEntity = (a: object | null | undefined, b: object | null | undefined) => canonicalJson(a ? stripVolatile(a) : null) === canonicalJson(b ? stripVolatile(b) : null);

/** A top-level parameter by key. */
export const param = (params: GtmParameter[] | undefined, key: string): GtmParameter | undefined => (params ?? []).find((p) => p.key === key);

/** Text cut to `max` characters with a visible marker. */
export function cut(s: string, max: number): { text: string; truncated: boolean } {
  return s.length > max ? { text: `${s.slice(0, max)}… (${s.length - max} more chars)`, truncated: true } : { text: s, truncated: false };
}

/** A parameter's value as text: scalars as-is, list / map as compact canonical JSON. */
export function paramText(p: GtmParameter): string | null {
  if (p.list !== undefined || p.map !== undefined) return canonicalJson(p.list ?? p.map);
  return p.value ?? null;
}

/** Variable references in template text, e.g. "foo{{Page Path}}" → ["Page Path"] (documented template syntax). */
export function varRefs(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{([^{}]{1,100})\}\}/g)].map((m) => m[1]!))];
}

/** Every string inside a value (parameter lists and maps included). */
export function deepStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) deepStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) deepStrings(x, out);
  return out;
}

/** GA4 Measurement IDs ("G-12345", Google's destination ID doc) found anywhere in a value. */
export function measurementIds(v: unknown): string[] {
  const ids = new Set<string>();
  for (const s of deepStrings(v)) for (const m of s.matchAll(/\bG-[A-Z0-9]{4,}\b/g)) ids.add(m[0]);
  return [...ids].sort();
}
/** Google Ads conversion IDs ("AW-98765", Google's destination ID doc) found anywhere in a value. */
export function adsConversionIds(v: unknown): string[] {
  const ids = new Set<string>();
  for (const s of deepStrings(v)) for (const m of s.matchAll(/\bAW-\d{1,20}\b/g)) ids.add(m[0]);
  return [...ids].sort();
}

/**
 * Hosts named in a piece of code (custom HTML, Custom JavaScript, template code) as http(s):// or protocol-relative //host
 * URLs: domain names and IPv4 literals. A best-effort aid only: code can build a URL any number of ways, so an empty list
 * never means the code contacts no host (approval texts say "no host recognised" and show the code in full).
 */
export function externalHosts(code: string): string[] {
  const hosts = new Set<string>();
  const re = /(?:https?:)?\/\/((?:[a-z0-9-]+\.)+[a-z]{2,63}|(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?=[:/?#"'`\s<>),;\\]|$)/gi;
  for (const m of code.matchAll(re)) hosts.add(m[1]!.toLowerCase());
  return [...hosts].sort();
}

/** Approver note on the hosts in some code: never claims the code contacts no host. */
export const hostsNote = (code: string): string => {
  const hosts = externalHosts(code);
  return hosts.length ? `hosts found: ${hosts.join(", ")}` : "no host recognised (the full code is shown below)";
};

/** Constructs in custom HTML an approver should know about. */
export function riskyConstructs(html: string): string[] {
  const found: string[] = [];
  if (/<script/i.test(html)) found.push("<script>");
  if (/document\.write/i.test(html)) found.push("document.write");
  if (/\beval\s*\(/i.test(html)) found.push("eval(");
  if (/new\s+Function\b/.test(html)) found.push("new Function");
  return found;
}

/**
 * Meta pixel recognition, from Meta's documented base code (developers.facebook.com/docs/meta-pixel/get-started): the loader
 * `connect.facebook.net/.../fbevents.js` marks the base code, `fbq(` calls mark pixel events, and `fbq('init', '<id>')` names
 * the pixel id (single or double quotes).
 */
export function metaPixel(html: string): { base: boolean; events: boolean; pixelIds: string[] } {
  const base = /connect\.facebook\.net\//i.test(html) && /\/fbevents\.js/i.test(html);
  const ids = new Set<string>();
  for (const m of html.matchAll(/fbq\(\s*(['"])init\1\s*,\s*(['"])(\d{5,20})\2/g)) ids.add(m[3]!);
  const events = /fbq\(\s*(['"])(track|trackCustom)\1/.test(html);
  return { base, events, pixelIds: [...ids].sort() };
}

/**
 * Names of tag type codes as Google's tag dictionary lists them. That dictionary was removed from developers.google.com; these
 * codes are from the archived copy (docs/VERIFICATION.md). Any other code (GA4 and Google tag types included) has no label:
 * a name is never guessed.
 */
const TYPE_LABELS: Record<string, string> = {
  html: "Custom HTML",
  img: "Custom Image",
  awct: "Google Ads Conversion Tracking",
  sp: "Google Ads Remarketing",
  flc: "Floodlight Counter",
  fls: "Floodlight Sales",
  ga: "Classic Google Analytics",
  lcl: "Link Click Listener",
  fsl: "Form Submit Listener",
  cl: "Click Listener",
  tl: "Timer Listener",
  jel: "JavaScript Error Listener",
  hl: "History Listener",
};
export const typeLabel = (code: string | undefined): string | null => (code && Object.hasOwn(TYPE_LABELS, code) ? TYPE_LABELS[code]! : null);

/** Text of one trigger condition, e.g. `{{Page Path}} contains "/thanks" (not, ignore case)`. */
export function conditionText(c: GtmCondition): string {
  const arg0 = param(c.parameter, "arg0")?.value ?? "?";
  const arg1 = param(c.parameter, "arg1")?.value ?? "";
  const flags = [param(c.parameter, "negate")?.value === "true" ? "not" : null, param(c.parameter, "ignore_case")?.value === "true" ? "ignore case" : null].filter(Boolean);
  return `${arg0} ${c.type ?? "?"} ${JSON.stringify(arg1)}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}

/** Epoch milliseconds (int64 string) as ISO text, or null. */
export const msIso = (ms: string | undefined): string | null => {
  if (!ms || !/^\d{1,16}$/.test(ms)) return null;
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// ---- output shapes --------------------------------------------------------------------------------------------------------

export const ParamOut = z.object({
  key: z.string().nullable(),
  type: z.string(),
  value: z.string().nullable().describe("Scalar value; list/map shown as compact JSON (max 1,000 chars; custom HTML see include_html). Untrusted text."),
  value_truncated: z.boolean(),
});
const TriggerRef = z.object({ trigger_id: z.string(), name: z.string().nullable().describe("null when the id is not a trigger of this container (for example a built-in trigger such as All Pages).") });
export const TagOut = z.object({
  tag_id: z.string(),
  name: z.string(),
  type: z.string(),
  type_label: z.string().nullable().describe("Name from Google's (archived) tag dictionary when the code is listed there, else null."),
  paused: z.boolean(),
  live_only: z.boolean(),
  firing_triggers: z.array(TriggerRef),
  blocking_triggers: z.array(TriggerRef),
  tag_firing_option: z.string().nullable(),
  consent_status: z.string().nullable(),
  schedule_end: z.string().nullable(),
  parameters: z.array(ParamOut).max(100),
  parameters_truncated: z.boolean(),
  notes: z.string().nullable(),
});
export const TriggerOut = z.object({
  trigger_id: z.string(),
  name: z.string(),
  type: z.string(),
  conditions: z.array(z.object({ list: z.enum(["filter", "customEventFilter", "autoEventFilter"]), text: z.string().describe('e.g. {{Page URL}} contains "/thanks" (not)') })).max(50),
  conditions_truncated: z.boolean(),
  parameters: z.array(ParamOut).max(50),
  parameters_truncated: z.boolean(),
});
export const VariableOut = z.object({ variable_id: z.string(), name: z.string(), type: z.string(), parameters: z.array(ParamOut).max(50), parameters_truncated: z.boolean() });
export const BuiltInOut = z.object({ type: z.string(), name: z.string() });

/** Parameter list for output: top-level parameters, values capped; custom HTML gets `htmlCap`. */
function paramsOut(params: GtmParameter[] | undefined, max: number, htmlCap: number, isHtml: boolean) {
  const ps = params ?? [];
  return {
    parameters: ps.slice(0, max).map((p) => {
      const raw = paramText(p);
      const c = raw === null ? { text: null, truncated: false } : cut(raw, isHtml && p.key === "html" ? htmlCap : 1_000);
      return { key: p.key ?? null, type: p.type ?? "", value: c.text, value_truncated: c.truncated };
    }),
    parameters_truncated: ps.length > max,
  };
}

/** `include_html`: custom HTML is cut at 1,000 characters unless asked for, then at 20,000. */
export const htmlCapOf = (includeHtml: boolean) => (includeHtml ? 20_000 : 1_000);

export function tagOut(t: GtmTag, triggerNames: Map<string, string>, htmlCap: number): z.infer<typeof TagOut> {
  const ref = (id: string) => ({ trigger_id: id, name: triggerNames.get(id) ?? null });
  return {
    tag_id: t.tagId ?? "",
    name: t.name ?? "",
    type: t.type ?? "",
    type_label: typeLabel(t.type),
    paused: t.paused === true,
    live_only: t.liveOnly === true,
    firing_triggers: (t.firingTriggerId ?? []).map(ref),
    blocking_triggers: (t.blockingTriggerId ?? []).map(ref),
    tag_firing_option: t.tagFiringOption ?? null,
    consent_status: t.consentSettings?.consentStatus ?? null,
    schedule_end: msIso(t.scheduleEndMs),
    ...paramsOut(t.parameter, 100, htmlCap, t.type === "html"),
    notes: t.notes ? cut(t.notes, 1_000).text : null,
  };
}

const COND_LISTS = ["filter", "customEventFilter", "autoEventFilter"] as const;
export function triggerOut(t: GtmTrigger): z.infer<typeof TriggerOut> {
  const conds = COND_LISTS.flatMap((list) => (t[list] ?? []).map((c) => ({ list, text: cut(conditionText(c), 1_000).text })));
  return { trigger_id: t.triggerId ?? "", name: t.name ?? "", type: t.type ?? "", conditions: conds.slice(0, 50), conditions_truncated: conds.length > 50, ...paramsOut(t.parameter, 50, 1_000, false) };
}
export function variableOut(v: GtmVariable): z.infer<typeof VariableOut> {
  return { variable_id: v.variableId ?? "", name: v.name ?? "", type: v.type ?? "", ...paramsOut(v.parameter, 50, 1_000, false) };
}
export const builtInOut = (b: GtmBuiltIn) => ({ type: b.type ?? "", name: b.name ?? "" });
export const templateOut = (t: GtmCustomTemplate) => ({
  template_id: t.templateId ?? "",
  name: t.name ?? "",
  gallery: t.galleryReference ? { owner: t.galleryReference.owner ?? null, repository: t.galleryReference.repository ?? null, version: t.galleryReference.version ?? null, is_modified: t.galleryReference.isModified ?? null } : null,
});
export const TemplateOut = z.object({
  template_id: z.string(),
  name: z.string(),
  gallery: z.object({ owner: z.string().nullable(), repository: z.string().nullable(), version: z.string().nullable(), is_modified: z.boolean().nullable() }).nullable(),
});

/** Trigger id → name, for showing trigger references. */
export const triggerNameMap = (triggers: GtmTrigger[] | undefined) => new Map((triggers ?? []).filter((t) => t.triggerId).map((t) => [t.triggerId!, t.name ?? ""]));
