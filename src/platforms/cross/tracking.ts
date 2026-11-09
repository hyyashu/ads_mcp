import { z } from "zod";
import { fetchKeyEventCounts, type Ga4Services } from "../ga4/api";
import type { GoogleServices } from "../google/services";
import { Gaql, pick } from "../google/gaql";
import { str } from "../google/tools/common";
import { readLiveForAudit, recogniseGa4, recogniseGoogleAds, recogniseMetaPixel } from "../gtm";
import type { GtmServices } from "../gtm/services";
import type { GtmParameter, GtmTag } from "../gtm/types";
import type { MetaServices } from "../meta/services";
import { ADWORDS, AccountOut, CoverageOut, GA4_READ, GTM_READ, META_READ, PeriodOut, accountInfo, crossRead, datesMsg, datesOk, idArg, newCoverage, optionalAccount, periodFields, resolveCrossPeriod } from "./common";

// audit_tracking_setup (design §5.5): does each conversion exist end to end? Joins the LIVE Tag Manager version (recognised
// only by documented tag types and snippets, see gtm/audit.ts) with GA4 streams and key events, Google Ads conversion actions
// and the Meta ad account's pixels. Every entity name is untrusted text from the platforms.

const ConversionRow = z.object({
  kind: z.enum(["ga4_measurement_id", "ga4_key_event", "google_ads_conversion_action", "gtm_google_ads_tag", "meta_pixel"]),
  id: z.string(),
  name: z.string().nullable(),
  defined_in: z.array(z.string()),
  missing_in: z.array(z.string()),
  status: z.enum(["ok", "gap", "not_applicable"]),
  details: z.array(z.string()),
});
type Row = z.infer<typeof ConversionRow>;

/** Every parameter value of a tag (values of nested lists and maps included; keys and types left out). */
function paramValues(ps: GtmParameter[] | undefined, out: string[] = []): string[] {
  for (const p of ps ?? []) {
    if (typeof p.value === "string") out.push(p.value);
    paramValues(p.list as GtmParameter[] | undefined, out);
    paramValues(p.map as GtmParameter[] | undefined, out);
  }
  return out;
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Live tags that send `event`: a parameter value equal to the name, or a gtag('event', name) call in custom HTML. */
function tagsSending(tags: GtmTag[], event: string): GtmTag[] {
  const re = new RegExp(`gtag\\(\\s*['"]event['"]\\s*,\\s*['"]${esc(event)}['"]`);
  return tags.filter((t) => paramValues(t.parameter).some((v) => v === event || (t.type === "html" && re.test(v))));
}
/** send_to "AW-<id>/<label>" pairs in a conversion action's event snippets. */
export function snippetTargets(snippets: unknown): { id: string; label: string }[] {
  const out = new Map<string, { id: string; label: string }>();
  for (const s of Array.isArray(snippets) ? snippets : []) {
    const text = typeof (s as { eventSnippet?: unknown })?.eventSnippet === "string" ? ((s as { eventSnippet: string }).eventSnippet) : "";
    for (const m of text.matchAll(/AW-(\d{1,20})\/([A-Za-z0-9_-]{1,100})/g)) out.set(`${m[1]}/${m[2]}`, { id: m[1]!, label: m[2]! });
  }
  return [...out.values()];
}
const digits = (s: string | null) => (s ?? "").replace(/^AW-/i, "").trim();

export const auditTrackingSetup = crossRead<GtmServices>()("google_tag_manager", [GTM_READ, GA4_READ, ADWORDS, META_READ], {
  name: "audit_tracking_setup",
  title: "Audit tracking end to end",
  description:
    "Checks whether each conversion exists end to end across the live Tag Manager container and the GA4 property, Google Ads account and Meta ad account linked to it (or named): GA4 Measurement IDs vs the property's web streams, GA4 key events vs tags that send them (and whether they fired in the period), Google Ads conversion actions vs conversion tags (conversion id and label from the action's event snippet), and Meta pixels vs pixel code in the container. Flags anything defined in one place but missing in another; a source that is not linked is listed as not checked. Tags are recognised only by documented tag types and snippets.",
  input: z
    .object({
      account_id: z.string().min(1),
      property_account_id: idArg("GA4 property"),
      google_ads_account_id: idArg("Google Ads account"),
      meta_account_id: idArg("Meta ad account"),
      ...periodFields,
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    period: PeriodOut,
    accounts: z.array(AccountOut),
    rules: z.array(z.string()),
    coverage: CoverageOut,
    container: z.object({ public_id: z.string().nullable(), live_version_id: z.string().nullable(), checked_at: z.string() }),
    summary: z.object({ checked: z.number().int(), ok: z.number().int(), gaps: z.number().int() }),
    conversions: z.array(ConversionRow).describe("Every item found in any source (not capped: the sources' own lists are bounded)."),
  }),
  handler: async (a, ctx) => {
    const own = ctx.account!;
    const gtm = ctx.services.gtm;
    const [prop, gads, meta] = [
      await optionalAccount<Ga4Services>(ctx, "google_analytics", a.property_account_id, "property_account_id"),
      await optionalAccount<GoogleServices>(ctx, "google_ads", a.google_ads_account_id, "google_ads_account_id"),
      await optionalAccount<MetaServices>(ctx, "meta_ads", a.meta_account_id, "meta_account_id"),
    ];
    const period = await resolveCrossPeriod(a, prop ? [{ source: "google_analytics", account: prop.account.externalId, time_zone: prop.services.ga4.timeZone ?? prop.account.timeZone }] : []);
    const coverage = newCoverage();
    const live = await readLiveForAudit(gtm);
    const tags = live.live?.tag ?? [];
    const active = (ts: GtmTag[]) => ts.filter((t) => t.paused !== true);
    coverage.sources.push({ source: "google_tag_manager live version", rows_read: tags.length, complete: true, note: live.live ? null : "Nothing is published in this container." });
    const ga4Ids = recogniseGa4(live.live, live.container).measurement_ids;
    const adsTags = recogniseGoogleAds(live.live, live.container);
    const pixels = recogniseMetaPixel(live.live);
    const rows: Row[] = [];

    // ---- GA4
    if (prop) {
      const ga4 = prop.services.ga4;
      const [streams, keys] = await Promise.all([ga4.listDataStreams(), fetchKeyEventCounts(ga4, { period: { date_range: "LAST_28_DAYS", start_date: period.start_date, end_date: period.end_date } })]);
      coverage.sources.push({ source: "google_analytics data streams", rows_read: streams.length, complete: true, note: null }, { source: "google_analytics key events", rows_read: keys.key_events.length, complete: true, note: null });
      coverage.notes.push(...keys.data_quality.notes);
      const streamIds = new Map(streams.filter((s) => s.webStreamData?.measurementId).map((s) => [s.webStreamData!.measurementId!, s.displayName ?? null]));
      for (const id of [...new Set([...streamIds.keys(), ...ga4Ids])].sort()) {
        const inGa4 = streamIds.has(id);
        const inGtm = ga4Ids.includes(id);
        rows.push({ kind: "ga4_measurement_id", id, name: streamIds.get(id) ?? null, defined_in: [...(inGa4 ? ["google_analytics"] : []), ...(inGtm ? ["google_tag_manager"] : [])], missing_in: [...(inGa4 ? [] : ["google_analytics"]), ...(inGtm ? [] : ["google_tag_manager"])], status: inGa4 && inGtm ? "ok" : "gap", details: inGa4 ? (inGtm ? [] : ["A web stream of the property whose Measurement ID is not in the live container (it may be installed outside Tag Manager)."]) : ["Used in the live container but not a web stream of this property: data goes to another property."] });
      }
      for (const k of keys.key_events) {
        const sending = tagsSending(tags, k.event_name);
        const live_ = active(sending);
        const details: string[] = [];
        if (k.status === "no_events_in_period") details.push(`No events named ${k.event_name} were recorded from ${keys.period.start_date} to ${keys.period.end_date}.`);
        if (k.status === "created_during_period") details.push("Marked as a key event during the period.");
        if (sending.length && !live_.length) details.push(`Every container tag that sends it is paused: ${sending.map((t) => t.name ?? "").join(", ")}.`);
        if (!sending.length) details.push("No live container tag sends this event name (it may be sent by code on the site, a tag template or a GA4 'create event' rule).");
        else details.push(`Sent by: ${live_.map((t) => t.name ?? "").slice(0, 10).join(", ")}.`);
        rows.push({ kind: "ga4_key_event", id: k.event_name, name: k.event_name, defined_in: ["google_analytics", ...(live_.length ? ["google_tag_manager"] : [])], missing_in: live_.length ? [] : ["google_tag_manager"], status: live_.length && k.status !== "no_events_in_period" ? "ok" : "gap", details });
      }
    } else coverage.not_checked.push({ source: "google_analytics", reason: "No GA4 property is linked to this container (or named)." });

    // ---- Google Ads
    if (gads) {
      const ads = gads.services.ads;
      const [cust] = await ads.query(new Gaql().select("customer.conversion_tracking_setting.conversion_tracking_id", "customer.conversion_tracking_setting.cross_account_conversion_tracking_id").from("customer").limit(1), { maxRows: 1 });
      const actions = await ads.query(new Gaql().select("conversion_action.id", "conversion_action.name", "conversion_action.type", "conversion_action.tag_snippets").from("conversion_action").where("conversion_action.status = 'ENABLED'").orderBy("conversion_action.id").limit(2_000), { maxRows: 2_000 });
      coverage.sources.push({ source: "google_ads conversion actions (enabled)", rows_read: actions.length, complete: actions.length < 2_000, note: null });
      const trackingId = str(cust ?? {}, "customer.conversion_tracking_setting.cross_account_conversion_tracking_id") ?? str(cust ?? {}, "customer.conversion_tracking_setting.conversion_tracking_id");
      const used = new Set<string>();
      for (const r of actions) {
        const targets = snippetTargets(pick(r, "conversion_action.tag_snippets"));
        const id = str(r, "conversion_action.id") ?? "";
        const name = str(r, "conversion_action.name");
        if (!targets.length) {
          rows.push({ kind: "google_ads_conversion_action", id, name, defined_in: ["google_ads"], missing_in: [], status: "not_applicable", details: [`Type ${str(r, "conversion_action.type") ?? "unknown"}: no website event snippet, so no Tag Manager tag is expected.`] });
          continue;
        }
        const match = adsTags.conversion_tags.filter((t) => targets.some((x) => digits(t.conversion_id) === x.id && (t.conversion_label ?? "") === x.label));
        for (const t of match) used.add(t.tag_id);
        const on = match.filter((t) => !t.paused);
        rows.push({
          kind: "google_ads_conversion_action",
          id,
          name,
          defined_in: ["google_ads", ...(on.length ? ["google_tag_manager"] : [])],
          missing_in: on.length ? [] : ["google_tag_manager"],
          status: on.length ? "ok" : "gap",
          details: [`send_to ${targets.map((x) => `AW-${x.id}/${x.label}`).join(", ")}.`, ...(match.length && !on.length ? ["The matching conversion tags are paused."] : []), ...(!match.length ? ["No live conversion tag (type awct) has this conversion id and label (it may be sent by a Google tag or code outside Tag Manager)."] : [])],
        });
      }
      for (const t of adsTags.conversion_tags.filter((x) => !used.has(x.tag_id))) {
        const other = trackingId && digits(t.conversion_id) && digits(t.conversion_id) !== trackingId;
        rows.push({ kind: "gtm_google_ads_tag", id: t.tag_id, name: t.name, defined_in: ["google_tag_manager"], missing_in: ["google_ads"], status: "gap", details: [`Conversion id ${t.conversion_id ?? "(none)"}, label ${t.conversion_label ?? "(none)"}${t.paused ? ", paused" : ""}: no enabled conversion action of this account has this id and label.`, ...(other ? [`The account's conversion tracking id is ${trackingId}: this tag sends to a different account.`] : [])] });
      }
    } else coverage.not_checked.push({ source: "google_ads", reason: "No Google Ads account is linked to this container (or named)." });

    // ---- Meta
    if (meta) {
      const m = meta.services.meta;
      const list = await m.list(`${m.adAccountId}/adspixels`, { fields: "id,name,last_fired_time" }, 200);
      coverage.sources.push({ source: "meta_ads pixels", rows_read: list.length, complete: list.length < 200, note: null });
      const acct = new Map(list.map((p) => [String(p.id ?? ""), p]));
      const gtmIds = new Map<string, { names: string[]; base: boolean; paused: boolean }>();
      for (const p of pixels) for (const id of p.pixel_ids) {
        const cur = gtmIds.get(id) ?? { names: [], base: false, paused: true };
        cur.names.push(p.name);
        cur.base ||= p.has_base_code;
        cur.paused &&= p.paused;
        gtmIds.set(id, cur);
      }
      for (const id of [...new Set([...acct.keys(), ...gtmIds.keys()])].sort()) {
        const a_ = acct.get(id);
        const g = gtmIds.get(id);
        const details: string[] = [];
        if (a_) details.push(typeof a_.last_fired_time === "string" ? `Meta last received an event at ${a_.last_fired_time}.` : "Meta reports no event received.");
        if (g) details.push(`In container tags: ${g.names.join(", ")}${g.paused ? " (all paused)" : ""}${g.base ? "" : "; no base code with it"}.`);
        else details.push("Not initialised in the live container (it may be installed outside Tag Manager).");
        if (!a_) details.push("Not a pixel of this Meta ad account.");
        const ok = !!a_ && !!g && g.base && !g.paused;
        rows.push({ kind: "meta_pixel", id, name: a_ && typeof a_.name === "string" ? a_.name : null, defined_in: [...(a_ ? ["meta_ads"] : []), ...(g ? ["google_tag_manager"] : [])], missing_in: [...(a_ ? [] : ["meta_ads"]), ...(g ? [] : ["google_tag_manager"])], status: ok ? "ok" : "gap", details });
      }
    } else coverage.not_checked.push({ source: "meta_ads", reason: "No Meta ad account is linked to this container (or named)." });

    coverage.notes.push("Only the live (published) container version is checked; tags installed outside Tag Manager are not seen.");
    const rank = { gap: 0, ok: 1, not_applicable: 2 };
    rows.sort((x, y) => rank[x.status] - rank[y.status] || x.kind.localeCompare(y.kind) || x.id.localeCompare(y.id));
    return {
      period,
      accounts: [accountInfo("tag_manager_container", own), ...(prop ? [accountInfo("ga4_property", prop.account)] : []), ...(gads ? [accountInfo("google_ads", gads.account)] : []), ...(meta ? [accountInfo("meta_ads", meta.account)] : [])],
      rules: [
        "GA4 Measurement IDs (G-…) in the live container vs the property's web data streams.",
        "GA4 key events: sent by a live, unpaused tag when a tag parameter value equals the event name, or custom HTML calls gtag('event', '<name>'); fired = GA4 recorded the event in the period.",
        "Google Ads: enabled conversion actions with a website event snippet; their send_to 'AW-<id>/<label>' must equal a live, unpaused conversion tag's (type awct) conversion id and label.",
        "Meta: pixel ids of the ad account (adspixels) vs pixel ids initialised (fbq('init', id)) in live custom HTML tags with the base code.",
      ],
      coverage,
      container: { public_id: live.container.publicId ?? null, live_version_id: live.live?.containerVersionId ?? null, checked_at: live.checked_at },
      summary: { checked: rows.filter((r) => r.status !== "not_applicable").length, ok: rows.filter((r) => r.status === "ok").length, gaps: rows.filter((r) => r.status === "gap").length },
      conversions: rows,
    };
  },
});
