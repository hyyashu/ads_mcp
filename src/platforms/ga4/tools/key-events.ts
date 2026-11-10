import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change } from "../../../policy/change-set";
import { canonicalJson } from "../../../security/canonical";
import { STANDARD_LIMITS, fmt, idOf, isStandard, plural, sortedUnique } from "../admin";
import type { Ga4Client } from "../client";
import { eventCountsLast28Days } from "../queries";
import { eventName } from "../report";
import type { CountingMethod, KeyEvent } from "../types";
import { accountId, ga4Write } from "./common";

/**
 * Key event writes (Admin API v1beta properties.keyEvents.create / delete, scope analytics.edit). Both follow
 * plan (read-only, snapshot) → approval → execute (re-read, refuse on drift, send once, read back) → verify.
 * Key events count from the moment they are marked, not retroactively (Data API schema page).
 */
const COUNTING = { ONCE_PER_EVENT: "counted once per event", ONCE_PER_SESSION: "counted once per session" } as const;

const adsLinkSentence = (n: number, action: "create" | "remove") =>
  n === 0
    ? ""
    : action === "create"
      ? ` ${plural(n, "Google Ads account")} ${n === 1 ? "is" : "are"} linked to this property: if ${n === 1 ? "it imports" : "they import"} GA4 key events, this can change what Smart Bidding optimises for.`
      : ` ${plural(n, "Google Ads account")} ${n === 1 ? "is" : "are"} linked: any conversion ${n === 1 ? "it imports" : "they import"} from this key event will stop receiving data.`;

const keyEventNames = (list: KeyEvent[]) => sortedUnique(list.map((k) => k.eventName ?? "").filter(Boolean));

// ------------------------------------------------------------------------------------------------ create_key_event
const defaultValueIn = z.object({ value: z.number().finite().min(0), currency_code: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. EUR") });
const keyEventResult = z.object({
  key_event_id: z.string(),
  event_name: z.string(),
  counting_method: z.string(),
  default_value: z.object({ value: z.number(), currency_code: z.string() }).nullable(),
  created: z.literal(true),
});

export const createKeyEvent = ga4Write({
  name: "create_key_event",
  title: "Mark a GA4 event as a key event",
  risk: "high_impact",
  description:
    "Marks an event as a key event (GA4's name for a conversion) on the property, counted once per event or once per session, optionally with a default value. Goes through approval by a person: linked Google Ads accounts that import GA4 key events may change what Smart Bidding optimises for. The approval shows whether the event was recorded in the last 28 days and how many Ads accounts are linked. Key events count from now on, not retroactively. Refused if the event is already a key event or a Standard property already has 30.",
  input: z.object({
    account_id: accountId,
    event_name: eventName,
    counting_method: z.enum(["ONCE_PER_EVENT", "ONCE_PER_SESSION"]).default("ONCE_PER_EVENT"),
    default_value: defaultValueIn.optional().describe("Value given to each key event when the event sends none."),
  }),
  output: keyEventResult,
  plan: async (a, ctx) => {
    const ga4 = ctx.services.ga4;
    const list = await ga4.listKeyEvents();
    const existing = list.find((k) => k.eventName === a.event_name);
    if (existing) throw new ToolError("invalid_argument", `"${a.event_name}" is already a key event (id ${idOf(existing.name)}).`);
    const prop = await ga4.getProperty();
    if (isStandard(prop) && list.length >= STANDARD_LIMITS.keyEvents) throw new ToolError("invalid_argument", `This Standard property already has ${list.length} key events (the limit is ${STANDARD_LIMITS.keyEvents}). Remove one first.`);
    const { counts } = await eventCountsLast28Days(ga4, [a.event_name]);
    const seen = counts.get(a.event_name)?.event_count ?? 0;
    const links = (await ga4.listGoogleAdsLinks()).length;
    const value = a.default_value ? `, default value ${a.default_value.value} ${a.default_value.currency_code}` : "";
    const summary =
      `Mark event "${a.event_name}" as a key event (${COUNTING[a.counting_method]}${value}). ` +
      (seen > 0 ? `It was recorded ${plural(seen, "time")} in the last 28 days.` : "It was not recorded in the last 28 days: it will count nothing until the site sends it.") +
      " Key events count from now on, not retroactively." +
      adsLinkSentence(links, "create");
    const changes: Change[] = [{ resource: "key_event", id: a.event_name, name: a.event_name, field: "key_event", before: null, after: a.event_name, unit: "text", effect: "create" }];
    return { summary, snapshot: { key_events: keyEventNames(list) }, changes };
  },
  execute: async (a, ctx, run) => {
    const ga4 = ctx.services.ga4;
    const before = await ga4.listKeyEvents();
    if (canonicalJson({ key_events: keyEventNames(before) }) !== canonicalJson(run.snapshot)) throw new ToolError("conflict", "The property's key events changed since this was requested. Nothing was changed; request it again.");
    await ga4.createKeyEvent({ eventName: a.event_name, countingMethod: a.counting_method as CountingMethod, ...(a.default_value ? { defaultValue: { numericValue: a.default_value.value, currencyCode: a.default_value.currency_code } } : {}) });
    const made = (await ga4.listKeyEvents()).find((k) => k.eventName === a.event_name);
    if (!made || made.countingMethod !== a.counting_method) throw new ToolError("unknown_outcome", "Google accepted the request but the key event does not read back as requested.");
    return {
      key_event_id: idOf(made.name),
      event_name: a.event_name,
      counting_method: made.countingMethod,
      default_value: a.default_value ? { value: a.default_value.value, currency_code: a.default_value.currency_code } : null,
      created: true as const,
    };
  },
  verify: async (a, ctx, run) => {
    const list = await ctx.services.ga4.listKeyEvents();
    if (list.some((k) => k.eventName === a.event_name)) return { outcome: "applied" };
    return canonicalJson({ key_events: keyEventNames(list) }) === canonicalJson(run.snapshot) ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: "the key events changed, but the requested one is not there" };
  },
});

// ------------------------------------------------------------------------------------------------ remove_key_event
interface KeySnapshot {
  name: string;
  event_name: string;
  counting_method: string | null;
  default_value: { numericValue: number | null; currencyCode: string | null } | null;
  create_time: string | null;
}
const snapOf = (k: KeyEvent): KeySnapshot => ({
  name: k.name ?? "",
  event_name: k.eventName ?? "",
  counting_method: k.countingMethod ?? null,
  default_value: k.defaultValue ? { numericValue: k.defaultValue.numericValue ?? null, currencyCode: k.defaultValue.currencyCode ?? null } : null,
  create_time: k.createTime ?? null,
});

async function findKeyEvent(ga4: Ga4Client, name: string): Promise<KeyEvent | undefined> {
  return (await ga4.listKeyEvents()).find((k) => k.name === name);
}

export const removeKeyEvent = ga4Write({
  name: "remove_key_event",
  title: "Stop counting a GA4 event as a key event",
  risk: "destructive",
  description:
    "Removes the key event marking from an event (the event itself keeps being collected). Destructive: never applied automatically. From then on GA4 stops counting it as a key event (earlier reports stay) and any Google Ads conversion imported from it stops receiving data; re-marking it later does not fill the gap. The approval shows how many key events it recorded in the last 28 days and how many Ads accounts are linked. Google may mark some key events as not deletable.",
  input: z.object({ account_id: accountId, event_name: eventName }),
  output: z.object({ removed: z.literal(true), event_name: z.string(), key_event_id: z.string() }),
  plan: async (a, ctx) => {
    const ga4 = ctx.services.ga4;
    const list = await ga4.listKeyEvents();
    const k = list.find((x) => x.eventName === a.event_name);
    if (!k) throw new ToolError("not_found", `"${a.event_name}" is not a key event of this property.${list.length ? ` Key events: ${keyEventNames(list).join(", ")}.` : " The property has no key events."}`);
    if (k.deletable === false) throw new ToolError("invalid_argument", `Google marks the key event "${a.event_name}" as not deletable.`);
    const { counts } = await eventCountsLast28Days(ga4, [a.event_name]);
    const recorded = counts.get(a.event_name)?.key_events ?? 0;
    const links = (await ga4.listGoogleAdsLinks()).length;
    const summary =
      `Stop counting "${a.event_name}" as a key event. It recorded ${fmt(recorded)} key ${recorded === 1 ? "event" : "events"} in the last 28 days. ` +
      "From now on GA4 will not count it as a key event (reports from before stay)." +
      adsLinkSentence(links, "remove") +
      " This cannot be undone through the API; create_key_event can re-mark it, but the gap is not back-filled.";
    const changes: Change[] = [{ resource: "key_event", id: idOf(k.name), name: a.event_name, field: "key_event", before: a.event_name, after: null, unit: "text", effect: "remove" }];
    return { summary, snapshot: snapOf(k), changes };
  },
  execute: async (a, ctx, run) => {
    const ga4 = ctx.services.ga4;
    const snap = run.snapshot as KeySnapshot;
    const now = await findKeyEvent(ga4, snap.name);
    if (!now || canonicalJson(snapOf(now)) !== canonicalJson(snap)) throw new ToolError("conflict", "The key event changed or was removed since this was requested. Nothing was changed; request it again.");
    await ga4.deleteKeyEvent(snap.name);
    if (await findKeyEvent(ga4, snap.name)) throw new ToolError("unknown_outcome", "Google accepted the request but the key event still reads back.");
    return { removed: true as const, event_name: a.event_name, key_event_id: idOf(snap.name) };
  },
  verify: async (_a, ctx, run) => {
    const snap = run.snapshot as KeySnapshot;
    const now = await findKeyEvent(ctx.services.ga4, snap.name);
    if (!now) return { outcome: "applied" };
    return canonicalJson(snapOf(now)) === canonicalJson(snap) ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: "the key event is still there but changed" };
  },
});
