import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { formatCustomerId, idOf } from "../admin";
import { GA4_EDIT, accountId, ga4Read } from "./common";
import { UNTRUSTED } from "./properties";

// ------------------------------------------------------------------------------------------------ get_ga4_ads_links
export const getGa4AdsLinks = ga4Read({
  name: "get_ga4_ads_links",
  title: "Google Ads accounts linked to the GA4 property",
  description: `Fetched live from Google Analytics (Admin API v1beta googleAdsLinks.list). The Google Ads accounts linked to this property, with whether personalized advertising is enabled. Without a link, Google Ads dimensions and cost in GA4 stay empty and GA4 key events cannot be imported into Google Ads. The creator's email is not returned. ${UNTRUSTED}`,
  input: z.object({ account_id: accountId }),
  output: z.object({
    property: z.string(),
    links: z.array(
      z.object({
        link_id: z.string().describe("GA4's link id, not the Google Ads customer id."),
        customer_id: z.string().describe("Google Ads customer id, 123-456-7890."),
        can_manage_clients: z.boolean().nullable(),
        ads_personalization_enabled: z.boolean().nullable(),
        create_time: z.string().nullable(),
        update_time: z.string().nullable(),
      }),
    ),
    returned: z.number().int(),
    note: z.string().nullable(),
  }),
  handler: async (_a, ctx) => {
    const ga4 = ctx.services.ga4;
    const links = (await ga4.listGoogleAdsLinks()).map((l) => ({
      link_id: idOf(l.name),
      customer_id: formatCustomerId(l.customerId),
      can_manage_clients: typeof l.canManageClients === "boolean" ? l.canManageClients : null,
      ads_personalization_enabled: typeof l.adsPersonalizationEnabled === "boolean" ? l.adsPersonalizationEnabled : null,
      create_time: l.createTime ?? null,
      update_time: l.updateTime ?? null,
    }));
    return { property: ga4.property, links, returned: links.length, note: links.length ? null : "No Google Ads accounts are linked: Google Ads dimensions and cost in GA4 will be empty." };
  },
});

// ------------------------------------------------------------------------------------------------ get_ga4_change_history
/** ChangeHistoryResourceType values of Admin API v1beta (checked 2026-11-10). */
const RESOURCE_TYPES = [
  "ACCOUNT",
  "PROPERTY",
  "FIREBASE_LINK",
  "GOOGLE_ADS_LINK",
  "GOOGLE_SIGNALS_SETTINGS",
  "CONVERSION_EVENT",
  "MEASUREMENT_PROTOCOL_SECRET",
  "CUSTOM_DIMENSION",
  "CUSTOM_METRIC",
  "DATA_RETENTION_SETTINGS",
  "DISPLAY_VIDEO_360_ADVERTISER_LINK",
  "DISPLAY_VIDEO_360_ADVERTISER_LINK_PROPOSAL",
  "DATA_STREAM",
  "ATTRIBUTION_SETTINGS",
] as const;
const CUT = 1_000;
const compact = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = JSON.stringify(v);
  return s.length > CUT ? `${s.slice(0, CUT)}…` : s;
};
/** A ChangeHistoryResource is a oneof: its single key names the kind of resource (e.g. "customDimension"). */
const kindOf = (r: Record<string, unknown> | undefined) => (r ? (Object.keys(r)[0] ?? null) : null);

export const READ_ONLY_HISTORY = "Google only allows reading GA4 change history with a connection that may make changes. Reconnect Google Analytics with changes allowed to use this tool.";

export const getGa4ChangeHistory = ga4Read({
  name: "get_ga4_change_history",
  title: "GA4 property change history",
  description: `Fetched live from Google Analytics (Admin API v1beta accounts:searchChangeHistoryEvents). Who changed what on this property in the last N days (key events, custom dimensions, data streams, Google Ads links, attribution settings, ...), with before and after values. Google requires a connection with changes allowed (analytics.edit) even to read this, so it fails on read-only connections. Only changes the API supports are returned; the GA4 UI can show more. ${UNTRUSTED}`,
  permissions: { platformPermissions: [GA4_EDIT], notes: "Google requires the edit scope even to read change history (searchChangeHistoryEvents accepts only analytics.edit)." },
  input: z.object({
    account_id: accountId,
    days: z.number().int().min(1).max(365).default(30),
    resource_types: z.array(z.enum(RESOURCE_TYPES)).max(RESOURCE_TYPES.length).optional(),
    actions: z.array(z.enum(["CREATED", "UPDATED", "DELETED"])).max(3).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    property: z.string(),
    account: z.string(),
    since: z.string(),
    events: z.array(
      z.object({
        id: z.string(),
        change_time: z.string().nullable(),
        actor_type: z.string().nullable().describe("USER, SYSTEM or SUPPORT."),
        actor_email: z.string().nullable(),
        changes_filtered: z.boolean(),
        changes: z.array(z.object({ resource: z.string(), action: z.string().nullable(), resource_kind: z.string().nullable(), before: z.string().nullable(), after: z.string().nullable() })),
      }),
    ),
    returned: z.number().int(),
    truncated: z.boolean(),
    note: z.string(),
  }),
  handler: async (a, ctx) => {
    if (ctx.account?.access !== "write") throw new ToolError("platform_permission_denied", READ_ONLY_HISTORY);
    const ga4 = ctx.services.ga4;
    const p = await ga4.getProperty();
    const acct = [p.account, p.parent].find((x) => !!x && /^accounts\/\d{1,20}$/.test(x));
    if (!acct) throw new ToolError("unsupported", "Could not determine the GA4 account of this property, so its change history cannot be read.");
    const since = new Date(Date.now() - a.days * 86_400_000).toISOString();
    const { items, truncated } = await ga4.searchChangeHistory(
      acct,
      { property: ga4.property, earliestChangeTime: since, ...(a.resource_types?.length ? { resourceType: a.resource_types } : {}), ...(a.actions?.length ? { action: a.actions } : {}) },
      { maxRows: a.limit },
    );
    const events = items.map((e) => ({
      id: e.id ?? "",
      change_time: e.changeTime ?? null,
      actor_type: e.actorType ?? null,
      actor_email: e.userActorEmail ?? null,
      changes_filtered: !!e.changesFiltered,
      changes: (e.changes ?? []).map((c) => {
        const kind = kindOf(c.resourceAfterChange) ?? kindOf(c.resourceBeforeChange);
        return {
          resource: c.resource ?? "",
          action: c.action ?? null,
          resource_kind: kind,
          before: compact(kind ? c.resourceBeforeChange?.[kind] : undefined),
          after: compact(kind ? c.resourceAfterChange?.[kind] : undefined),
        };
      }),
    }));
    return { property: ga4.property, account: acct, since, events, returned: events.length, truncated, note: "Only changes the API supports are returned; the GA4 UI can show more. Before/after values are compact JSON cut to 1,000 characters." };
  },
});
