/**
 * Tag Manager audit: rule-based checks of a container's LIVE version, using only documented fields (docs/VERIFICATION.md,
 * "Tag Manager tools (2026-11-10)"). Used by audit_gtm_container and exported for the combined audit_tracking_setup tool.
 *
 * Reusable API (all pure except readLiveForAudit):
 *   readLiveForAudit(gtm: GtmClient): Promise<LiveForAudit>
 *       containers.get + versions:live (2 requests). live is null when nothing was ever published.
 *   recogniseGa4(live: GtmVersion | null, container: GtmContainerInfo): { measurement_ids: string[]; google_tag_ids: string[] }
 *       GA4 Measurement IDs (G-…) found in tag, variable and Google tag config parameters and in container.tagIds. GA4 tag type
 *       codes are not documented, so recognition is by Measurement ID only.
 *   recogniseGoogleAds(live: GtmVersion | null, container?: GtmContainerInfo): { conversion_tags: AdsTag[]; remarketing_tags: AdsTag[]; conversion_ids: string[] }
 *       Tags of type awct (conversion) and sp (remarketing), codes from Google's archived tag dictionary; AW-… ids anywhere.
 *   recogniseMetaPixel(live: GtmVersion | null): MetaPixelTag[]
 *       Custom HTML tags (type html) holding Meta's documented pixel base code (connect.facebook.net/…/fbevents.js) or fbq() events.
 *   customHtmlTags(live: GtmVersion | null): { tag_id; name; paused; external_hosts: string[] }[]
 *   auditContainer(input: LiveForAudit, now?: Date): AuditResult
 * Everything taken from the container (names, HTML, parameter values) is untrusted text.
 */
import { z } from "zod";
import { ToolError } from "../../mcp/errors";
import { canonicalJson } from "../../security/canonical";
import type { GtmClient } from "./client";
import { adsConversionIds, externalHosts, measurementIds, metaPixel, param, typeLabel } from "./model";
import type { GtmContainerInfo, GtmTag, GtmVersion } from "./types";

export interface LiveForAudit {
  container: GtmContainerInfo;
  live: GtmVersion | null;
  checked_at: string;
}

/** containers.get and versions:live. */
export async function readLiveForAudit(gtm: GtmClient): Promise<LiveForAudit> {
  const container = await gtm.getContainer();
  const live = await gtm.liveVersion();
  return { container, live, checked_at: new Date().toISOString() };
}

export const AdsTagSchema = z.object({ tag_id: z.string(), name: z.string(), paused: z.boolean(), conversion_id: z.string().nullable(), conversion_label: z.string().nullable() });
export type AdsTag = z.infer<typeof AdsTagSchema>;
export const MetaPixelTagSchema = z.object({ tag_id: z.string(), name: z.string(), pixel_ids: z.array(z.string()), has_base_code: z.boolean(), has_events: z.boolean(), paused: z.boolean() });
export type MetaPixelTag = z.infer<typeof MetaPixelTagSchema>;

const tagsOf = (v: GtmVersion | null) => v?.tag ?? [];
const htmlOf = (t: GtmTag) => (t.type === "html" ? (param(t.parameter, "html")?.value ?? "") : "");
const paused = (t: GtmTag) => t.paused === true;

export function recogniseGa4(live: GtmVersion | null, container: GtmContainerInfo): { measurement_ids: string[]; google_tag_ids: string[] } {
  const ids = measurementIds([tagsOf(live).map((t) => t.parameter), (live?.variable ?? []).map((v) => v.parameter), (live?.gtagConfig ?? []).map((g) => g.parameter), container.tagIds ?? []]);
  return { measurement_ids: ids, google_tag_ids: [...(container.tagIds ?? [])].sort() };
}

export function recogniseGoogleAds(live: GtmVersion | null, container?: GtmContainerInfo): { conversion_tags: AdsTag[]; remarketing_tags: AdsTag[]; conversion_ids: string[] } {
  const ads = (type: string) =>
    tagsOf(live)
      .filter((t) => t.type === type)
      .map((t) => ({ tag_id: t.tagId ?? "", name: t.name ?? "", paused: paused(t), conversion_id: param(t.parameter, "googleConversionId")?.value ?? null, conversion_label: param(t.parameter, "googleConversionLabel")?.value ?? null }));
  return {
    conversion_tags: ads("awct"),
    remarketing_tags: ads("sp"),
    conversion_ids: adsConversionIds([tagsOf(live).map((t) => t.parameter), (live?.variable ?? []).map((v) => v.parameter), (live?.gtagConfig ?? []).map((g) => g.parameter), container?.tagIds ?? []]),
  };
}

export function recogniseMetaPixel(live: GtmVersion | null): MetaPixelTag[] {
  return tagsOf(live).flatMap((t) => {
    const p = metaPixel(htmlOf(t));
    return p.base || p.events || p.pixelIds.length ? [{ tag_id: t.tagId ?? "", name: t.name ?? "", pixel_ids: p.pixelIds, has_base_code: p.base, has_events: p.events, paused: paused(t) }] : [];
  });
}

export function customHtmlTags(live: GtmVersion | null) {
  return tagsOf(live)
    .filter((t) => t.type === "html")
    .map((t) => ({ tag_id: t.tagId ?? "", name: t.name ?? "", paused: paused(t), external_hosts: externalHosts(htmlOf(t)).slice(0, 50) }));
}

// ---- rules ------------------------------------------------------------------------------------------------------------------

const Entity = z.object({ kind: z.enum(["tag", "trigger", "variable"]), id: z.string(), name: z.string() });
export const FindingSchema = z.object({
  rule: z.string(),
  severity: z.enum(["high", "medium", "info"]),
  message: z.string(),
  entities: z.array(Entity).max(50),
  entities_truncated: z.boolean(),
});
export type Finding = z.infer<typeof FindingSchema>;
export const AuditSchema = z.object({
  container: z.object({ public_id: z.string().nullable(), usage_context: z.array(z.string()), tag_ids: z.array(z.string()) }),
  version_id: z.string().nullable(),
  checked_at: z.string(),
  findings: z.array(FindingSchema),
  recognised: z.object({
    ga4_measurement_ids: z.array(z.string()),
    google_tag_ids: z.array(z.string()),
    google_ads_conversion_tags: z.array(AdsTagSchema),
    google_ads_remarketing_tags: z.array(AdsTagSchema),
    meta_pixel: z.array(MetaPixelTagSchema),
    custom_html_tags: z.array(z.object({ tag_id: z.string(), name: z.string(), paused: z.boolean(), external_hosts: z.array(z.string()) })),
  }),
  tag_type_counts: z.array(z.object({ type: z.string(), label: z.string().nullable(), count: z.number().int() })),
  limits: z.array(z.string()),
});
export type AuditResult = z.infer<typeof AuditSchema>;

export const AUDIT_MAX_TAGS = 5_000;
export const AUDIT_LIMITS = [
  "GA4 and Google tag types are not listed in Google's Tag Manager API documentation, so GA4 is recognised by Measurement IDs (G-…) found in tag, variable and Google tag config parameters. A Measurement ID kept outside the container (for example in a data layer value) is not seen.",
  "Only the live version is checked.",
  "Tag type names (Custom HTML, Google Ads Conversion Tracking awct, Remarketing sp) come from Google's tag dictionary, which Google has removed from its site; the archived copy is used.",
];

export function auditContainer(input: LiveForAudit, now = new Date(), o: { includeInfo?: boolean } = {}): AuditResult {
  const { container, live } = input;
  const tags = tagsOf(live);
  if (tags.length > AUDIT_MAX_TAGS) throw new ToolError("unsupported", `The live version has ${tags.length} tags, more than the ${AUDIT_MAX_TAGS} this audit checks in one call. Nothing was checked.`, { definite: true, details: { reason: "row_cap", cap: AUDIT_MAX_TAGS, resource: "tags" } });
  const findings: Finding[] = [];
  const ent = (kind: "tag" | "trigger" | "variable", id: string | undefined, name: string | undefined) => ({ kind, id: id ?? "", name: name ?? "" });
  const tagEnt = (t: GtmTag) => ent("tag", t.tagId, t.name);
  const add = (rule: string, severity: Finding["severity"], message: string, entities: z.infer<typeof Entity>[] = []) =>
    findings.push({ rule, severity, message, entities: entities.slice(0, 50), entities_truncated: entities.length > 50 });

  const usage = container.usageContext ?? [];
  const web = !usage.length || usage.some((u) => u.toLowerCase() === "web");
  const ga4 = recogniseGa4(live, container);
  const ads = recogniseGoogleAds(live, container);
  const pixel = recogniseMetaPixel(live);
  const html = customHtmlTags(live);

  if (!live) {
    add("no_live_version", "high", "Nothing is published in this container: no tag runs on the site from it.");
  } else {
    const triggerIds = new Set((live.trigger ?? []).map((t) => t.triggerId));
    if (!tags.length) add("no_tags", "high", "The live version has no tags.");
    const sequenced = new Set(tags.flatMap((t) => [...(t.setupTag ?? []), ...(t.teardownTag ?? [])].map((s) => s.tagName)).filter(Boolean));
    const never = tags.filter((t) => !(t.firingTriggerId ?? []).length && !sequenced.has(t.name));
    if (never.length) add("tag_never_fires", "high", "These tags have no firing trigger and are not a setup or cleanup tag of another tag, so they never fire.", never.map(tagEnt));
    const selfBlock = tags.filter((t) => (t.firingTriggerId ?? []).some((id) => (t.blockingTriggerId ?? []).includes(id)));
    if (selfBlock.length) add("tag_blocks_itself", "high", "These tags list the same trigger as firing and blocking; a blocking trigger wins, so they do not fire on it.", selfBlock.map(tagEnt));
    const p = tags.filter(paused);
    if (p.length) add("paused_tags", "medium", "These tags are paused and do not fire.", p.map(tagEnt));
    const nowMs = now.getTime();
    const ended = tags.filter((t) => t.scheduleEndMs && /^\d+$/.test(t.scheduleEndMs) && Number(t.scheduleEndMs) < nowMs);
    if (ended.length) add("schedule_ended", "medium", "These tags' schedule has ended, so they no longer fire.", ended.map(tagEnt));
    const notStarted = tags.filter((t) => t.scheduleStartMs && /^\d+$/.test(t.scheduleStartMs) && Number(t.scheduleStartMs) > nowMs);
    if (notStarted.length) add("schedule_not_started", "info", "These tags are scheduled to start later.", notStarted.map(tagEnt));
    const groups = new Map<string, GtmTag[]>();
    for (const t of tags.filter((x) => !paused(x))) {
      const k = canonicalJson([t.type ?? "", t.parameter ?? [], [...(t.firingTriggerId ?? [])].sort()]);
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    const dups = [...groups.values()].filter((g) => g.length > 1);
    if (dups.length) add("duplicate_tags", "high", `${dups.length} group(s) of active tags have the same type, settings and firing triggers, so the same hit is sent more than once (double counting).`, dups.flat().map(tagEnt));
    const unknownRefs = tags.filter((t) => [...(t.firingTriggerId ?? []), ...(t.blockingTriggerId ?? [])].some((id) => !triggerIds.has(id)));
    if (unknownRefs.length) add("trigger_ref_unknown", "info", "These tags use trigger ids that are not triggers of this version; usually a built-in trigger such as All Pages, which Tag Manager does not list.", unknownRefs.map(tagEnt));
    const used = new Set(tags.flatMap((t) => [...(t.firingTriggerId ?? []), ...(t.blockingTriggerId ?? [])]));
    const unused = (live.trigger ?? []).filter((t) => !used.has(t.triggerId ?? ""));
    if (unused.length) add("unused_triggers", "info", "These triggers are not used by any tag.", unused.map((t) => ent("trigger", t.triggerId, t.name)));
    const consent = tags.filter((t) => (t.consentSettings?.consentStatus ?? "").toLowerCase() === "needed" && !(t.consentSettings?.consentType?.list ?? []).length);
    if (consent.length) add("consent_needed_without_types", "medium", "These tags require additional consent but name no consent type.", consent.map(tagEnt));
    const liveOnly = tags.filter((t) => t.liveOnly === true);
    if (liveOnly.length) add("live_only_tags", "info", "These tags only fire on the live site, not in preview or debug mode.", liveOnly.map(tagEnt));

    if (!web) {
      add("non_web_container", "info", `This container is used for ${usage.join(", ")}, not web: the GA4, Google Ads and Meta pixel checks were skipped.`);
    } else {
      if (!ga4.measurement_ids.length) add("no_ga4_measurement_id", "high", "No GA4 Measurement ID (G-…) was found in the live version's tags, variables, Google tag settings or the container's tag ids.");
      if (ga4.measurement_ids.length > 1) add("ga4_multiple_ids", "medium", `More than one GA4 Measurement ID is used: ${ga4.measurement_ids.join(", ")}.`);
      if (!ads.conversion_tags.length && !ads.conversion_ids.length) add("no_google_ads_conversion_tag", "medium", "No Google Ads conversion tag (type awct) and no Google Ads conversion ID (AW-…) was found.");
      if (ads.conversion_tags.length && ads.conversion_tags.every((t) => t.paused)) add("google_ads_conversion_paused", "high", "Every Google Ads conversion tag is paused: no conversions are sent from this container.", ads.conversion_tags.map((t) => ent("tag", t.tag_id, t.name)));
      if (!ads.remarketing_tags.length) add("no_google_ads_remarketing", "info", "No Google Ads remarketing tag (type sp) was found.");
      const bases = pixel.filter((p) => p.has_base_code);
      if (pixel.length) add("meta_pixel_present", "info", `Meta pixel code found in ${pixel.length} custom HTML tag(s).`, pixel.map((p) => ent("tag", p.tag_id, p.name)));
      else add("no_meta_pixel", "info", "No Meta pixel code was found in custom HTML tags.");
      if (pixel.some((p) => p.has_events) && !bases.length) add("meta_pixel_event_without_base", "high", "Meta pixel events (fbq) are sent but no tag holds the pixel base code, so they fail.", pixel.filter((p) => p.has_events).map((p) => ent("tag", p.tag_id, p.name)));
      const byId = new Map<string, MetaPixelTag[]>();
      for (const b of bases.filter((x) => !x.paused)) for (const id of b.pixel_ids) byId.set(id, [...(byId.get(id) ?? []), b]);
      const dupBase = [...byId.entries()].filter(([, ts]) => ts.length > 1);
      if (dupBase.length) add("meta_pixel_base_duplicated", "high", `The Meta pixel base code for ${dupBase.map(([id]) => id).join(", ")} is in more than one active tag (double counting).`, dupBase.flatMap(([, ts]) => ts.map((p) => ent("tag", p.tag_id, p.name))));
      const pixelIds = [...new Set(pixel.flatMap((p) => p.pixel_ids))].sort();
      if (pixelIds.length > 1) add("meta_pixel_multiple_ids", "medium", `More than one Meta pixel id is initialised: ${pixelIds.join(", ")}.`);
      if (html.length) add("custom_html_inventory", "info", "Custom HTML tags run code on the site; review each and the hosts it loads from (see recognised.custom_html_tags).", html.map((t) => ent("tag", t.tag_id, t.name)));
    }
  }

  const counts = new Map<string, number>();
  for (const t of tags) counts.set(t.type ?? "", (counts.get(t.type ?? "") ?? 0) + 1);
  const shown = o.includeInfo === false ? findings.filter((f) => f.severity !== "info") : findings;
  const rank = { high: 0, medium: 1, info: 2 };
  shown.sort((x, y) => rank[x.severity] - rank[y.severity]);
  return {
    container: { public_id: container.publicId ?? null, usage_context: usage, tag_ids: container.tagIds ?? [] },
    version_id: live?.containerVersionId ?? null,
    checked_at: input.checked_at,
    findings: shown,
    recognised: { ga4_measurement_ids: ga4.measurement_ids, google_tag_ids: ga4.google_tag_ids, google_ads_conversion_tags: ads.conversion_tags, google_ads_remarketing_tags: ads.remarketing_tags, meta_pixel: pixel, custom_html_tags: html },
    tag_type_counts: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([type, count]) => ({ type, label: typeLabel(type), count })),
    limits: AUDIT_LIMITS,
  };
}
