import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change, Effect } from "../../../policy/change-set";
import { canonicalJson } from "../../../security/canonical";
import { withHidden } from "../../core/hidden";
import { type GtmClient, gtmIdOrFail } from "../client";
import { hostsNote, param, riskyConstructs, stripVolatile, typeLabel, varRefs } from "../model";
import type { GtmParameter, GtmTag } from "../types";
import { DRAFT_ONLY, GTM_EDIT_CONTAINERS, accountId, consentInput, entityName, firingOption, gtmId, htmlBody, notesText, paramEdits } from "./common";
import { type DraftLocation, NEXT_STEP_TAG, confirmAfterSend, draftBase, gtmStateWrite, inServerWorkspace, location, q, refuseUnknownRefs, resolveRefs, wsLabel, wsPrefix } from "./write-kit";

/** Top-level parameter types a caller may set (Parameter reference: template text, boolean "true"/"false", base-10 integer). */
const SCALAR = new Set(["template", "boolean", "integer"]);
const lc = (s: string | undefined) => (s ?? "").toLowerCase();

/** Checks replacements against the reference tag's own top-level parameters; returns them with their documented type. */
function checkParamEdits(edits: { key: string; value: string }[], params: GtmParameter[] | undefined): void {
  const seen = new Set<string>();
  for (const e of edits) {
    if (seen.has(e.key)) throw new ToolError("invalid_argument", `Parameter ${e.key} is listed twice.`);
    seen.add(e.key);
    if (e.key === "html") throw new ToolError("invalid_argument", "Custom HTML is changed with html, not parameters.");
    const p = param(params, e.key);
    if (!p) throw new ToolError("invalid_argument", `Parameter ${e.key} is not a top-level parameter of the tag. list_gtm_tags shows its parameters.`);
    const t = lc(p.type);
    if (!SCALAR.has(t)) throw new ToolError("invalid_argument", `Parameter ${e.key} is a ${p.type} parameter; only template, boolean and integer parameters can be set.`);
    if (t === "boolean" && e.value !== "true" && e.value !== "false") throw new ToolError("invalid_argument", `Parameter ${e.key} is boolean: use "true" or "false".`);
    if (t === "integer" && !/^-?\d{1,18}$/.test(e.value)) throw new ToolError("invalid_argument", `Parameter ${e.key} is an integer: use base-10 digits.`);
  }
}
const replaceParams = (params: GtmParameter[] | undefined, edits: { key: string; value: string }[]): GtmParameter[] =>
  (params ?? []).map((p) => {
    const e = edits.find((x) => x.key === p.key);
    return e ? { ...p, value: e.value } : p;
  });
const consentBody = (c: z.infer<typeof consentInput>) => ({ consentStatus: c.status, ...(c.types.length ? { consentType: { type: "list", list: c.types.map((t) => ({ type: "template", value: t })) } } : {}) });
/** Normalised parameter list for comparing what was sent with what reads back. */
const normParams = (ps: GtmParameter[] | undefined): unknown => (ps ?? []).map((p) => ({ type: lc(p.type), key: p.key ?? null, value: p.value ?? null, list: p.list ? normParams(p.list) : null, map: p.map ? normParams(p.map) : null }));
const sortIds = (x: string[] | undefined) => [...(x ?? [])].sort();
const consentText = (c: { consentStatus?: string; consentType?: GtmParameter } | undefined) => (c ? `${c.consentStatus ?? "?"}${c.consentType?.list?.length ? `: ${c.consentType.list.map((x) => x.value).join(", ")}` : ""}` : null);

/** What an approver must know about custom HTML: hosts it loads from and risky constructs. */
const htmlNotes = (html: string) => {
  const risky = riskyConstructs(html);
  return `${hostsNote(html)}${risky.length ? `; contains ${risky.join(", ")}` : ""}`;
};

// ---- create_gtm_tag -------------------------------------------------------------------------------------------------------

const triggerIds = z.array(gtmId).max(10);
const createInput = z
  .object({
    account_id: accountId,
    name: entityName,
    tag: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("like_existing"),
        like_tag_id: gtmId.describe("An existing tag whose type and parameters are copied (e.g. a GA4 event or Google Ads conversion tag of this container)."),
        parameters: paramEdits.default([]).describe("Top-level template/boolean/integer parameters of the reference tag to replace. Keys must exist on it."),
      }),
      z.object({ kind: z.literal("custom_html"), html: htmlBody }),
    ]),
    firing_trigger_ids: triggerIds.min(1).describe("Triggers that fire the tag (ids from list_gtm_triggers). Built-in triggers such as All Pages have no documented id: create a pageview trigger with create_gtm_trigger instead."),
    blocking_trigger_ids: triggerIds.default([]),
    paused: z.boolean().default(false),
    tag_firing_option: firingOption.optional(),
    consent: consentInput.optional(),
    notes: notesText.optional(),
  })
  .refine((a) => !a.firing_trigger_ids.some((id) => a.blocking_trigger_ids.includes(id)), "a trigger cannot both fire and block the tag");
type CreateIn = z.infer<typeof createInput>;

interface CreateS extends DraftLocation {
  public_id: string | null;
  usage_context: string[];
  same_name: { id: string; projection: unknown } | null;
  reference: GtmTag | null;
  /** The requested trigger ids that exist, with their names; missing ids are listed separately. */
  triggers: Record<string, string>;
  missing_triggers: string[];
  known_vars: string[];
  unknown_vars: string[];
}

const textOfCreate = (a: CreateIn) => (a.tag.kind === "custom_html" ? a.tag.html : a.tag.parameters.map((p) => p.value).join("\n"));

async function readCreate(a: CreateIn, gtm: GtmClient): Promise<CreateS> {
  const container = await gtm.getContainer();
  const text = textOfCreate(a);
  const needVars = text.includes("{{");
  const b = await draftBase(gtm, { tags: true, triggers: true, variables: needVars, builtIns: needVars });
  const same = b.tags.find((t) => lc(t.name) === lc(a.name));
  const ref = a.tag.kind === "like_existing" ? (b.tags.find((t) => t.tagId === (a.tag as { like_tag_id: string }).like_tag_id) ?? null) : null;
  const ids = [...a.firing_trigger_ids, ...a.blocking_trigger_ids];
  const byId = new Map(b.triggers.map((t) => [t.triggerId ?? "", t.name ?? ""]));
  const refs = resolveRefs(varRefs(text), b.variables, b.builtIns);
  return {
    ...location(b),
    public_id: container.publicId ?? null,
    usage_context: container.usageContext ?? [],
    same_name: same ? { id: same.tagId ?? "", projection: stripVolatile(same) } : null,
    reference: ref ? (stripVolatile(ref) as GtmTag) : null,
    triggers: Object.fromEntries(ids.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)!])),
    missing_triggers: [...new Set(ids.filter((id) => !byId.has(id)))].sort(),
    known_vars: refs.known,
    unknown_vars: refs.unknown,
  };
}

export function createBody(a: CreateIn, s: CreateS): GtmTag {
  const html = a.tag.kind === "custom_html";
  return {
    name: a.name,
    type: html ? "html" : s.reference!.type!,
    parameter: html ? [{ type: "template", key: "html", value: (a.tag as { html: string }).html }] : replaceParams(s.reference!.parameter, (a.tag as { parameters: { key: string; value: string }[] }).parameters),
    firingTriggerId: a.firing_trigger_ids,
    ...(a.blocking_trigger_ids.length ? { blockingTriggerId: a.blocking_trigger_ids } : {}),
    paused: a.paused,
    ...(a.tag_firing_option ? { tagFiringOption: a.tag_firing_option } : {}),
    ...(a.consent ? { consentSettings: consentBody(a.consent) } : {}),
    notes: `${a.notes ? `${a.notes}\n` : ""}Created by JackOfAds.`,
  };
}
const createdMatches = (body: GtmTag, got: GtmTag | null | undefined) =>
  !!got && got.name === body.name && got.type === body.type && canonicalJson(normParams(got.parameter)) === canonicalJson(normParams(body.parameter)) && canonicalJson(sortIds(got.firingTriggerId)) === canonicalJson(sortIds(body.firingTriggerId)) && canonicalJson(sortIds(got.blockingTriggerId)) === canonicalJson(sortIds(body.blockingTriggerId)) && (got.paused === true) === (body.paused === true);

const trigList = (ids: string[], names: Record<string, string>) => ids.map((id) => `${q(names[id] ?? "?")} (id ${id})`).join(", ");

export const createGtmTag = gtmStateWrite({
  name: "create_gtm_tag",
  title: "Create a Tag Manager tag",
  description:
    "Creates a tag in the server's own JackOfAds draft workspace (created on first use). kind like_existing copies the type and parameters of an existing tag of this container (how GA4 event or Google Ads conversion tags are added) and replaces chosen top-level parameters; kind custom_html creates a Custom HTML tag (max 4,000 characters, shown in full to approvers, is high impact). Triggers must be ids from list_gtm_triggers. Draft only: nothing changes on the site until a version is created and published.",
  risk: "high_impact",
  scope: GTM_EDIT_CONTAINERS,
  input: createInput,
  output: z.object({ tag_id: z.string(), name: z.string(), type: z.string(), workspace_id: z.string(), workspace_created: z.boolean(), paused: z.boolean(), next_step: z.string() }),
  read: readCreate,
  build: (a, s) => {
    if (s.same_name) throw new ToolError("invalid_argument", `A tag named ${q(a.name)} already exists (id ${s.same_name.id}). Choose another name or use update_gtm_tag.`);
    if (s.missing_triggers.length) throw new ToolError("invalid_argument", `Unknown trigger id(s): ${s.missing_triggers.join(", ")}. Use ids from list_gtm_triggers. Built-in triggers such as All Pages have no documented id: create a Page View trigger with create_gtm_trigger to fire on all pages.`);
    refuseUnknownRefs(s.unknown_vars);
    const fires = trigList(a.firing_trigger_ids, s.triggers);
    const blocks = a.blocking_trigger_ids.length ? `; blocked by: ${trigList(a.blocking_trigger_ids, s.triggers)}` : "";
    const extras = [a.paused ? "created paused" : null, a.tag_firing_option ? `firing option ${a.tag_firing_option}` : null, a.consent ? `consent ${consentText(consentBody(a.consent))}` : null].filter(Boolean).join("; ");
    const where = `in Tag Manager container ${s.public_id ?? ""} (${wsLabel(s)})`;
    const rows: Change[] = [];
    let summary: string;
    if (a.tag.kind === "custom_html") {
      const usage = s.usage_context.map(lc);
      if (usage.length && !usage.includes("web")) throw new ToolError("invalid_argument", `Custom HTML tags are for web containers; this container is used for ${s.usage_context.join(", ")}.`);
      summary = `Create CUSTOM HTML tag ${q(a.name)} ${where}. It will run this code on every page matched by ${fires}${blocks}, with full access to the page: ${htmlNotes(a.tag.html)}.${extras ? ` (${extras})` : ""} Code:\n${a.tag.html}\n`;
      rows.push({ resource: "gtm_tag", id: "new", name: a.name, field: "tag", before: null, after: `Custom HTML · fires on: ${fires}`, unit: "text", effect: "create" });
      rows.push({ resource: "gtm_tag", id: "new", name: a.name, field: "parameter.html", before: null, after: a.tag.html, unit: "text", effect: "create" });
    } else {
      const ref = s.reference;
      if (!ref) throw new ToolError("not_found", `Tag ${a.tag.like_tag_id} is not in the ${s.base === "workspace" ? "JackOfAds workspace" : "latest version"}. list_gtm_tags shows the tags.`);
      if (ref.type === "html") throw new ToolError("invalid_argument", "The reference tag is a Custom HTML tag: use kind custom_html, so the code is shown in full to approvers.");
      checkParamEdits(a.tag.parameters, ref.parameter);
      const label = typeLabel(ref.type);
      const edits = a.tag.parameters.map((p) => `${p.key} = ${q(p.value)} (was ${q(param(ref.parameter, p.key)?.value ?? "")})`);
      summary = `Create tag ${q(a.name)} ${where}, type ${ref.type}${label ? ` (${label})` : ""} like tag ${q(ref.name ?? "")} (id ${a.tag.like_tag_id})${edits.length ? `, with ${edits.join(", ")}` : ", same settings"}; fires on: ${fires}${blocks}.${extras ? ` (${extras})` : ""}`;
      rows.push({ resource: "gtm_tag", id: "new", name: a.name, field: "tag", before: null, after: `${ref.type} like ${ref.name ?? ""} (id ${a.tag.like_tag_id}) · fires on: ${fires}`, unit: "text", effect: "create" });
      for (const p of a.tag.parameters) rows.push({ resource: "gtm_tag", id: "new", name: a.name, field: `parameter.${p.key}`, before: null, after: p.value, unit: "text", effect: "create" });
    }
    return { summary: `${wsPrefix(s)}${summary} ${DRAFT_ONLY}`, changes: rows };
  },
  apply: async (a, s0, gtm) => {
    const { wsId, created, state } = await inServerWorkspace(gtm, s0, () => readCreate(a, gtm));
    const body = createBody(a, state);
    const res = await gtm.createTag(wsId, body);
    return confirmAfterSend("tag", async () => {
      const id = gtmIdOrFail(String(res.tagId ?? ""), "tag");
      const got = await gtm.getTag(wsId, id);
      if (!createdMatches(body, got)) throw new ToolError("unknown_outcome", "Tag Manager accepted the tag but it does not read back as requested.");
      return { tag_id: id, name: a.name, type: body.type!, workspace_id: wsId, workspace_created: created, paused: got.paused === true, next_step: NEXT_STEP_TAG };
    });
  },
  verify: async (a, before, gtm) => {
    const now = await readCreate(a, gtm);
    if (!now.same_name) return { outcome: "not_applied" };
    if (now.base === "workspace" && (a.tag.kind === "custom_html" || before.reference) && createdMatches(createBody(a, before), now.same_name.projection as GtmTag)) return { outcome: "applied" };
    return { outcome: "indeterminate", detail: now.base === "workspace" ? "a tag with this name exists but differs from the request" : "a tag with this name is in the latest version, not in the JackOfAds workspace" };
  },
});

// ---- update_gtm_tag -------------------------------------------------------------------------------------------------------

const updateInput = z
  .object({
    account_id: accountId,
    tag_id: gtmId,
    name: entityName.optional(),
    paused: z.boolean().optional(),
    firing_trigger_ids: triggerIds.min(1).optional().describe("Replaces the list."),
    blocking_trigger_ids: triggerIds.optional().describe("Replaces the list."),
    tag_firing_option: firingOption.optional(),
    parameters: paramEdits.min(1).optional().describe("Top-level template/boolean/integer parameters to change; not for custom HTML."),
    html: htmlBody.optional().describe("Custom HTML tags only: the new code (max 4,000 characters), shown in full to approvers with the code it replaces."),
    consent: consentInput.optional(),
    notes: notesText.optional().describe("Replaces the tag's notes."),
  })
  .refine((a) => ["name", "paused", "firing_trigger_ids", "blocking_trigger_ids", "tag_firing_option", "parameters", "html", "consent", "notes"].some((k) => (a as Record<string, unknown>)[k] !== undefined), "nothing to change: give at least one field");
type UpdateIn = z.infer<typeof updateInput>;

interface UpdateS extends DraftLocation {
  public_id: string | null;
  tag: GtmTag | null;
  /** Names of the trigger ids named in the request that exist; ids already on the tag are kept even when not listed. */
  triggers: Record<string, string>;
  missing_triggers: string[];
  name_clash: string | null;
  known_vars: string[];
  unknown_vars: string[];
}

async function readUpdate(a: UpdateIn, gtm: GtmClient): Promise<UpdateS> {
  const container = await gtm.getContainer();
  const text = [a.html ?? "", ...(a.parameters ?? []).map((p) => p.value)].join("\n");
  const needVars = text.includes("{{");
  const b = await draftBase(gtm, { tags: true, triggers: true, variables: needVars, builtIns: needVars });
  const raw = b.tags.find((t) => t.tagId === a.tag_id) ?? null;
  const byId = new Map(b.triggers.map((t) => [t.triggerId ?? "", t.name ?? ""]));
  const onTag = new Set([...(raw?.firingTriggerId ?? []), ...(raw?.blockingTriggerId ?? [])]);
  const named = [...new Set([...(a.firing_trigger_ids ?? []), ...(a.blocking_trigger_ids ?? []), ...onTag])];
  const clash = a.name ? b.tags.find((t) => t.tagId !== a.tag_id && lc(t.name) === lc(a.name)) : undefined;
  const refs = resolveRefs(varRefs(text), b.variables, b.builtIns);
  const s: UpdateS = {
    ...location(b),
    public_id: container.publicId ?? null,
    tag: raw ? (stripVolatile(raw) as GtmTag) : null,
    triggers: Object.fromEntries(named.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)!])),
    missing_triggers: [...new Set([...(a.firing_trigger_ids ?? []), ...(a.blocking_trigger_ids ?? [])].filter((id) => !byId.has(id) && !onTag.has(id)))].sort(),
    name_clash: clash?.tagId ?? null,
    known_vars: refs.known,
    unknown_vars: refs.unknown,
  };
  return withHidden(s, { raw });
}

/** The tag with only the requested fields replaced: every other field (unknown ones included) passes through untouched. */
export function updatedTag(a: UpdateIn, t: GtmTag): GtmTag {
  const out: GtmTag = { ...t };
  if (a.name !== undefined) out.name = a.name;
  if (a.paused !== undefined) out.paused = a.paused;
  if (a.firing_trigger_ids !== undefined) out.firingTriggerId = a.firing_trigger_ids;
  if (a.blocking_trigger_ids !== undefined) out.blockingTriggerId = a.blocking_trigger_ids;
  if (a.tag_firing_option !== undefined) out.tagFiringOption = a.tag_firing_option;
  if (a.parameters) out.parameter = replaceParams(t.parameter, a.parameters);
  if (a.html !== undefined) out.parameter = replaceParams(out.parameter, [{ key: "html", value: a.html }]);
  if (a.consent) out.consentSettings = consentBody(a.consent);
  if (a.notes !== undefined) out.notes = a.notes;
  return out;
}

/** Field-by-field differences between two tags, for the summary and the change set. */
function tagDiff(a: UpdateIn, before: GtmTag, after: GtmTag, names: Record<string, string>): { field: string; before: string | null; after: string; effect: Effect }[] {
  const out: { field: string; before: string | null; after: string; effect: Effect }[] = [];
  const ids = (x: string[] | undefined) => (x ?? []).map((id) => `${names[id] ?? "?"} (${id})`).join(", ");
  if (a.name !== undefined && before.name !== after.name) out.push({ field: "name", before: before.name ?? null, after: after.name ?? "", effect: "neutral" });
  if (a.paused !== undefined && (before.paused === true) !== (after.paused === true)) out.push({ field: "paused", before: String(before.paused === true), after: String(after.paused === true), effect: after.paused ? "pause" : "enable" });
  if (a.firing_trigger_ids !== undefined && canonicalJson(sortIds(before.firingTriggerId)) !== canonicalJson(sortIds(after.firingTriggerId))) out.push({ field: "firing_triggers", before: ids(before.firingTriggerId), after: ids(after.firingTriggerId), effect: "create" });
  if (a.blocking_trigger_ids !== undefined && canonicalJson(sortIds(before.blockingTriggerId)) !== canonicalJson(sortIds(after.blockingTriggerId))) out.push({ field: "blocking_triggers", before: ids(before.blockingTriggerId), after: ids(after.blockingTriggerId), effect: "create" });
  if (a.tag_firing_option !== undefined && before.tagFiringOption !== after.tagFiringOption) out.push({ field: "tag_firing_option", before: before.tagFiringOption ?? null, after: after.tagFiringOption ?? "", effect: "create" });
  for (const p of a.parameters ?? []) {
    const was = param(before.parameter, p.key)?.value ?? null;
    if (was !== p.value) out.push({ field: `parameter.${p.key}`, before: was, after: p.value, effect: "create" });
  }
  if (a.html !== undefined) {
    const was = param(before.parameter, "html")?.value ?? null;
    if (was !== a.html) out.push({ field: "parameter.html", before: was, after: a.html, effect: "create" });
  }
  if (a.consent && canonicalJson(before.consentSettings ?? null) !== canonicalJson(after.consentSettings)) out.push({ field: "consent", before: consentText(before.consentSettings), after: consentText(after.consentSettings) ?? "", effect: "create" });
  if (a.notes !== undefined && (before.notes ?? "") !== a.notes) out.push({ field: "notes", before: before.notes ?? null, after: a.notes, effect: "neutral" });
  return out;
}
/** Every requested field reads back as requested. */
const updateLanded = (a: UpdateIn, before: GtmTag, got: GtmTag | null | undefined) => {
  if (!got) return false;
  const want = updatedTag(a, before);
  return (
    (a.name === undefined || got.name === want.name) &&
    (a.paused === undefined || (got.paused === true) === a.paused) &&
    (a.firing_trigger_ids === undefined || canonicalJson(sortIds(got.firingTriggerId)) === canonicalJson(sortIds(want.firingTriggerId))) &&
    (a.blocking_trigger_ids === undefined || canonicalJson(sortIds(got.blockingTriggerId)) === canonicalJson(sortIds(want.blockingTriggerId))) &&
    (a.tag_firing_option === undefined || lc(got.tagFiringOption) === lc(want.tagFiringOption)) &&
    (a.parameters === undefined && a.html === undefined ? true : canonicalJson(normParams(got.parameter)) === canonicalJson(normParams(want.parameter))) &&
    (a.consent === undefined || lc(got.consentSettings?.consentStatus) === lc(a.consent.status)) &&
    (a.notes === undefined || got.notes === a.notes)
  );
};

export const updateGtmTag = gtmStateWrite({
  name: "update_gtm_tag",
  title: "Update a Tag Manager tag",
  description:
    "Changes a tag in the server's own JackOfAds draft workspace (created on first use from the latest version): name, paused, firing / blocking triggers (each list replaced), firing option, top-level template/boolean/integer parameters, custom HTML code (shown in full before and after), consent settings or notes. Every other setting of the tag is kept. Draft only: nothing changes on the site until a version is created and published.",
  risk: "high_impact",
  scope: GTM_EDIT_CONTAINERS,
  input: updateInput,
  output: z.object({ tag_id: z.string(), name: z.string(), workspace_id: z.string(), workspace_created: z.boolean(), changed_fields: z.array(z.string()), next_step: z.string() }),
  read: readUpdate,
  build: (a, s) => {
    const t = s.tag;
    if (!t) throw new ToolError("not_found", `Tag ${a.tag_id} is not in the ${s.base === "workspace" ? "JackOfAds workspace" : "latest version"}. A tag that exists only as an unversioned draft in another workspace cannot be edited here.`);
    if (a.html !== undefined && t.type !== "html") throw new ToolError("invalid_argument", "html can only be set on a Custom HTML tag.");
    if (a.parameters) checkParamEdits(a.parameters, t.parameter);
    if (s.name_clash) throw new ToolError("invalid_argument", `Another tag is already named ${q(a.name!)} (id ${s.name_clash}).`);
    if (s.missing_triggers.length) throw new ToolError("invalid_argument", `Unknown trigger id(s): ${s.missing_triggers.join(", ")}. Use ids from list_gtm_triggers.`);
    const both = (a.firing_trigger_ids ?? t.firingTriggerId ?? []).filter((id) => (a.blocking_trigger_ids ?? t.blockingTriggerId ?? []).includes(id));
    if (both.length) throw new ToolError("invalid_argument", `Trigger(s) ${both.join(", ")} would both fire and block the tag.`);
    refuseUnknownRefs(s.unknown_vars);
    const diff = tagDiff(a, t, updatedTag(a, t), s.triggers);
    if (!diff.length) throw new ToolError("invalid_argument", "Nothing would change: the tag already has these values.");
    const label = typeLabel(t.type);
    const parts = diff.map((d) => (d.field === "parameter.html" ? `custom HTML code changes (full code before and after in the change list; new code ${htmlNotes(d.after)})` : `${d.field} ${q(d.before ?? "")} → ${q(d.after)}`));
    const code = diff.find((d) => d.field === "parameter.html");
    return {
      summary: `${wsPrefix(s)}Update tag ${q(t.name ?? "")} (id ${a.tag_id}, type ${t.type ?? "?"}${label ? `, ${label}` : ""}) in Tag Manager container ${s.public_id ?? ""} (${wsLabel(s)}): ${parts.join("; ")}.${code ? `\nCode before:\n${code.before ?? ""}\nCode after:\n${code.after}\n` : ""} ${DRAFT_ONLY}`,
      changes: diff.map((d) => ({ resource: "gtm_tag", id: a.tag_id, name: t.name ?? null, field: d.field, before: d.before, after: d.after, unit: "text" as const, effect: d.effect })),
    };
  },
  apply: async (a, s0, gtm) => {
    const { wsId, created, state } = await inServerWorkspace(gtm, s0, () => readUpdate(a, gtm));
    const raw = (state as UpdateS & { __hidden?: { raw: GtmTag | null } }).__hidden?.raw;
    if (!raw?.fingerprint) throw new ToolError("conflict", "The tag could not be read with its fingerprint in the JackOfAds workspace. Nothing was changed.", { definite: true });
    const diff = tagDiff(a, state.tag!, updatedTag(a, state.tag!), state.triggers);
    await gtm.updateTag(wsId, a.tag_id, updatedTag(a, raw), raw.fingerprint);
    return confirmAfterSend("tag change", async () => {
      const got = await gtm.getTag(wsId, a.tag_id);
      if (!updateLanded(a, state.tag!, got)) throw new ToolError("unknown_outcome", "Tag Manager accepted the change but the tag does not read back as requested.");
      return { tag_id: a.tag_id, name: got.name ?? "", workspace_id: wsId, workspace_created: created, changed_fields: diff.map((d) => d.field), next_step: NEXT_STEP_TAG };
    });
  },
  verify: async (a, before, gtm) => {
    const now = await readUpdate(a, gtm);
    if (before.tag && updateLanded(a, before.tag, now.tag)) return { outcome: "applied" };
    if (canonicalJson(now.tag) === canonicalJson(before.tag)) return { outcome: "not_applied" };
    return { outcome: "indeterminate", detail: "the tag changed, but not to the requested values" };
  },
});
