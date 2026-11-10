import type { Ga4Client } from "./client";
import type { CustomDimension, Ga4Property, KeyEvent } from "./types";

/**
 * Small typed helpers over the Admin API objects (v1beta unless noted), shared by the GA4 tools.
 *
 * Standard-property limits come from Google Analytics Help "Configuration limits"
 * (https://support.google.com/analytics/answer/12229528, checked 2026-11-10): 30 key events, 100 audiences, 25 user-scoped
 * and 50 event-scoped custom dimensions. Item-scoped and 360 limits are not on that page, so they are not enforced: Google
 * decides and its error is passed through. Limits are only enforced when properties.get says GOOGLE_ANALYTICS_STANDARD.
 */
export const STANDARD_LIMITS = { keyEvents: 30, audiences: 100, userDims: 25, eventDims: 50 } as const;

export const isStandard = (p: Ga4Property) => p.serviceLevel === "GOOGLE_ANALYTICS_STANDARD";

/** The last segment of a resource name ("properties/1/keyEvents/9" → "9"). */
export const idOf = (name: string | undefined): string => (name ?? "").split("/").pop() ?? "";

export const sortedUnique = (xs: string[]): string[] => [...new Set(xs)].sort();

/** Google Ads customer ids as 123-456-7890 (10 digits); anything else is returned as given. */
export const formatCustomerId = (id: string | undefined): string => {
  const d = (id ?? "").replace(/-/g, "");
  return /^\d{10}$/.test(d) ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : (id ?? "");
};

export interface KeyEventOut {
  key_event_id: string;
  name: string;
  event_name: string;
  counting_method: string | null;
  default_value: { value: number | null; currency_code: string | null } | null;
  custom: boolean | null;
  deletable: boolean | null;
  create_time: string | null;
}
export const keyEventOut = (k: KeyEvent): KeyEventOut => ({
  key_event_id: idOf(k.name),
  name: k.name ?? "",
  event_name: k.eventName ?? "",
  counting_method: k.countingMethod ?? null,
  default_value: k.defaultValue ? { value: typeof k.defaultValue.numericValue === "number" ? k.defaultValue.numericValue : null, currency_code: k.defaultValue.currencyCode ?? null } : null,
  custom: typeof k.custom === "boolean" ? k.custom : null,
  deletable: typeof k.deletable === "boolean" ? k.deletable : null,
  create_time: k.createTime ?? null,
});

/** Key events by event name. */
export async function keyEventsByName(ga4: Ga4Client): Promise<Map<string, KeyEvent>> {
  const m = new Map<string, KeyEvent>();
  for (const k of await ga4.listKeyEvents()) if (k.eventName) m.set(k.eventName, k);
  return m;
}

/** The identity of a custom dimension: scope + parameter name (both immutable). */
export const customDimensionKey = (scope: string | undefined, parameterName: string | undefined) => `${scope ?? ""}|${parameterName ?? ""}`;

/** The name to use for a custom dimension in reports (Data API schema: customEvent:, customUser:, customItem:). */
export const reportNameOf = (d: Pick<CustomDimension, "scope" | "parameterName">): string | null => {
  const prefix = d.scope === "EVENT" ? "customEvent" : d.scope === "USER" ? "customUser" : d.scope === "ITEM" ? "customItem" : null;
  return prefix && d.parameterName ? `${prefix}:${d.parameterName}` : null;
};

/** "1,234" style counts for summaries. */
export const fmt = (n: number) => n.toLocaleString("en-US");
export const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
