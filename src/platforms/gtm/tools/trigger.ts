import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { canonicalJson } from "../../../security/canonical";
import { type GtmClient, gtmIdOrFail } from "../client";
import { conditionText } from "../model";
import type { GtmCondition, GtmParameter, GtmTrigger } from "../types";
import { DRAFT_ONLY, GTM_EDIT_CONTAINERS, accountId, entityName, notesText, singleLine } from "./common";
import { type DraftLocation, confirmAfterSend, draftBase, gtmStateWrite, inServerWorkspace, location, q, refuseUnknownRefs, resolveRefs, wsLabel, wsPrefix } from "./write-kit";

/** EventType values offered (Trigger reference); urlMatches and the other types are left out (their operands are not documented). */
const TYPES = ["pageview", "domReady", "windowLoaded", "customEvent", "click", "linkClick", "formSubmission", "historyChange"] as const;
const TYPE_LABEL: Record<(typeof TYPES)[number], string> = { pageview: "Page View", domReady: "DOM Ready", windowLoaded: "Window Loaded", customEvent: "Custom Event", click: "Click", linkClick: "Link Click", formSubmission: "Form Submission", historyChange: "History Change" };
const OPERATORS = ["equals", "contains", "startsWith", "endsWith", "matchRegex", "cssSelector", "greater", "greaterOrEquals", "less", "lessOrEquals"] as const;

const input = z
  .object({
    account_id: accountId,
    name: entityName,
    type: z.enum(TYPES),
    event_name: singleLine(100).trim().min(1).optional().describe("Required for customEvent (only): the dataLayer event name."),
    conditions: z
      .array(
        z.object({
          variable: z.string().trim().min(1).max(100).regex(/^[^{}\u0000-\u001f\u007f]+$/).describe("Name of a variable or enabled built-in variable, e.g. Page Path (without braces)."),
          operator: z.enum(OPERATORS),
          value: singleLine(500),
          negate: z.boolean().default(false),
          ignore_case: z.boolean().default(false).describe("matchRegex only."),
        }),
      )
      .max(10)
      .default([])
      .describe("All conditions must hold for the trigger to fire."),
    wait_for_tags_ms: z.number().int().min(1).max(10_000).optional().describe("linkClick / formSubmission only: wait for tags up to this many milliseconds."),
    check_validation: z.boolean().optional().describe("linkClick / formSubmission only."),
    notes: notesText.optional(),
  })
  .refine((a) => (a.type === "customEvent") === (a.event_name !== undefined), "event_name is required for customEvent and only allowed there")
  .refine((a) => a.conditions.every((c) => !c.ignore_case || c.operator === "matchRegex"), "ignore_case is only for matchRegex")
  .refine((a) => (a.wait_for_tags_ms === undefined && a.check_validation === undefined) || a.type === "linkClick" || a.type === "formSubmission", "wait_for_tags_ms and check_validation are only for linkClick and formSubmission");
type In = z.infer<typeof input>;

interface S extends DraftLocation {
  public_id: string | null;
  /** The trigger with the requested name (case-insensitive), when one exists. */
  same_name: { id: string; type: string; filter: unknown; custom_event_filter: unknown } | null;
  similar_ids: string[];
  known_vars: string[];
  unknown_vars: string[];
  /** Listed name of the enabled built-in variable of type event (customEvent), else null. */
  event_builtin: string | null;
}

const tpl = (key: string, value: string): GtmParameter => ({ type: "template", key, value });
const bool = (key: string): GtmParameter => ({ type: "boolean", key, value: "true" });

/** The documented Condition shape: arg0 a variable reference, arg1 the operand, optional negate / ignore_case booleans. */
function conditions(a: In): GtmCondition[] {
  return a.conditions.map((c) => ({ type: c.operator, parameter: [tpl("arg0", `{{${c.variable}}}`), tpl("arg1", c.value), ...(c.negate ? [bool("negate")] : []), ...(c.ignore_case ? [bool("ignore_case")] : [])] }));
}
export function triggerBody(a: In, s: S): GtmTrigger {
  const filter = conditions(a);
  return {
    name: a.name,
    type: a.type,
    ...(filter.length ? { filter } : {}),
    ...(a.type === "customEvent" ? { customEventFilter: [{ type: "equals", parameter: [tpl("arg0", `{{${s.event_builtin}}}`), tpl("arg1", a.event_name!)] }] } : {}),
    ...(a.wait_for_tags_ms !== undefined ? { waitForTags: { type: "boolean", value: "true" }, waitForTagsTimeout: { type: "template", value: String(a.wait_for_tags_ms) } } : {}),
    ...(a.check_validation !== undefined ? { checkValidation: { type: "boolean", value: String(a.check_validation) } } : {}),
    notes: `${a.notes ? `${a.notes}\n` : ""}Created by JackOfAds.`,
  };
}
/** Type and filters, compared case-insensitively on the type (§1.5: enum spelling on the wire is not confirmed). */
const shape = (t: { type?: string; filter?: unknown; customEventFilter?: unknown }) => canonicalJson([(t.type ?? "").toLowerCase(), t.filter ?? [], t.customEventFilter ?? []]);

/** matchRegex values must compile; lookarounds and backreferences are refused (Tag Manager uses RE2-like syntax). */
function checkRegex(v: string) {
  if (/\(\?<?[=!]/.test(v) || /\\[1-9]/.test(v)) throw new ToolError("invalid_argument", `The regular expression ${q(v)} uses lookarounds or backreferences, which Tag Manager's RE2-style matching does not support.`);
  try {
    new RegExp(v);
  } catch {
    throw new ToolError("invalid_argument", `${q(v)} is not a valid regular expression.`);
  }
}

async function read(a: In, gtm: GtmClient): Promise<S> {
  const container = await gtm.getContainer();
  const needVars = a.conditions.length > 0 || a.type === "customEvent";
  const b = await draftBase(gtm, { triggers: true, variables: needVars, builtIns: needVars });
  const lower = a.name.toLowerCase();
  const same = b.triggers.find((t) => (t.name ?? "").toLowerCase() === lower);
  const refs = resolveRefs(
    a.conditions.map((c) => c.variable),
    b.variables,
    b.builtIns,
  );
  const ev = a.type === "customEvent" ? (b.builtIns.find((x) => (x.type ?? "").toLowerCase() === "event")?.name ?? null) : null;
  const s: S = { ...location(b), public_id: container.publicId ?? null, same_name: same ? { id: same.triggerId ?? "", type: same.type ?? "", filter: same.filter ?? [], custom_event_filter: same.customEventFilter ?? [] } : null, similar_ids: [], known_vars: refs.known, unknown_vars: refs.unknown, event_builtin: ev };
  if (a.type !== "customEvent" || ev) {
    const want = shape(triggerBody(a, s));
    s.similar_ids = b.triggers.filter((t) => shape(t) === want).map((t) => t.triggerId ?? "").sort();
  }
  return s;
}

export const createGtmTrigger = gtmStateWrite({
  name: "create_gtm_trigger",
  title: "Create a Tag Manager trigger",
  description:
    "Creates a trigger (Page View, DOM Ready, Window Loaded, Custom Event, Click, Link Click, Form Submission or History Change) with conditions on variables, in the server's own JackOfAds draft workspace (created on first use). Draft only: nothing changes on the site until a version is created and published. Returns the trigger_id to use in create_gtm_tag / update_gtm_tag.",
  risk: "write",
  scope: GTM_EDIT_CONTAINERS,
  input,
  output: z.object({ trigger_id: z.string(), name: z.string(), type: z.string(), workspace_id: z.string(), workspace_created: z.boolean(), similar_trigger_ids: z.array(z.string()), next_step: z.string() }),
  read,
  build: (a, s) => {
    if (s.same_name) throw new ToolError("invalid_argument", `A trigger named ${q(a.name)} already exists (id ${s.same_name.id}). Choose another name.`);
    for (const c of a.conditions) if (c.operator === "matchRegex") checkRegex(c.value);
    refuseUnknownRefs(s.unknown_vars);
    if (a.type === "customEvent" && !s.event_builtin) throw new ToolError("invalid_argument", "Enable the built-in variable Event in Tag Manager first (Variables → Configure): a Custom Event trigger compares it with event_name.");
    const body = triggerBody(a, s);
    const conds = [...(body.customEventFilter ?? []), ...(body.filter ?? [])].map(conditionText);
    const what = `${TYPE_LABEL[a.type]}${conds.length ? ` · fires when ${conds.join(" and ")}` : " · fires on every such event"}`;
    const similar = s.similar_ids.length ? ` Note: trigger(s) ${s.similar_ids.join(", ")} already have the same type and conditions.` : "";
    return {
      summary: `${wsPrefix(s)}Create trigger ${q(a.name)} (${TYPE_LABEL[a.type]}) in Tag Manager container ${s.public_id ?? ""} (${wsLabel(s)}): ${conds.length ? `fires when ${conds.join(" and ")}` : "fires on every such event"}. It fires nothing until a tag uses it.${similar} ${DRAFT_ONLY}`,
      changes: [{ resource: "gtm_trigger", id: "new", name: a.name, field: "trigger", before: null, after: what, unit: "text", effect: "neutral" }],
    };
  },
  apply: async (a, s0, gtm) => {
    const { wsId, created, state } = await inServerWorkspace(gtm, s0, () => read(a, gtm));
    const body = triggerBody(a, state);
    const res = await gtm.createTrigger(wsId, body);
    return confirmAfterSend("trigger", async () => {
      const id = gtmIdOrFail(String(res.triggerId ?? ""), "trigger");
      const got = await gtm.getTrigger(wsId, id);
      if (got.name !== a.name || shape(got) !== shape(body)) throw new ToolError("unknown_outcome", "Tag Manager accepted the trigger but it does not read back as requested.");
      return { trigger_id: id, name: a.name, type: got.type ?? a.type, workspace_id: wsId, workspace_created: created, similar_trigger_ids: state.similar_ids, next_step: "Use trigger_id in create_gtm_tag or update_gtm_tag." };
    });
  },
  verify: async (a, before, gtm) => {
    const now = await read(a, gtm);
    if (!now.same_name) return { outcome: "not_applied" };
    const want = shape(triggerBody(a, before));
    const got = shape({ type: now.same_name.type, filter: now.same_name.filter, customEventFilter: now.same_name.custom_event_filter });
    if (got === want && now.base === "workspace") return { outcome: "applied" };
    return { outcome: "indeterminate", detail: now.base === "workspace" ? "a trigger with this name exists but differs from the request" : "a trigger with this name is in the latest version, not in the JackOfAds workspace" };
  },
});
