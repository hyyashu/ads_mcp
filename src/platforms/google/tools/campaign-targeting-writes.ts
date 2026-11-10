import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { type Change, type Effect, moneyChange } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, isRealDate, lit, num, pick } from "../gaql";
import { mapCaps, tailId } from "./campaign-reads";
import { accountId, idSchema, str, toMicros } from "./common";
import { rn, stateWrite } from "./write-kit";

const change = (ref: { resource: string; id: string; name?: string | null }, field: string, before: string | number | null, after: string | number | null, effect: Effect, unit: Change["unit"] = "text"): Change => ({ ...ref, field, before, after, unit, effect });

interface Camp {
  id: string;
  name: string | null;
  status: string;
  channel: string | null;
}
async function readCampaign(ads: GoogleAdsClient, id: string, extra: string[] = []): Promise<{ c: Camp; row: Row }> {
  const [r] = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type", ...extra).from("campaign").where(`campaign.id = ${lit.id(id)}`).limit(1), { maxRows: 1 });
  if (!r) throw new ToolError("not_found", `No campaign ${id} in this account.`);
  if (str(r, "campaign.status") === "REMOVED") throw new ToolError("invalid_argument", "The campaign is removed and cannot be changed.");
  return { c: { id, name: str(r, "campaign.name"), status: str(r, "campaign.status")!, channel: str(r, "campaign.advertising_channel_type") }, row: r };
}
const ccRn = (ads: GoogleAdsClient, campaignId: string, criterionId: string) => `customers/${ads.customerId}/campaignCriteria/${campaignId}~${criterionId}`;

async function readCriteria(ads: GoogleAdsClient, campaignId: string, type: string, fields: string[]) {
  return ads.query(
    new Gaql().select("campaign_criterion.criterion_id", "campaign_criterion.negative", "campaign_criterion.bid_modifier", ...fields).from("campaign_criterion").where(`campaign.id = ${lit.id(campaignId)}`).where(`campaign_criterion.type = '${type}'`).where("campaign_criterion.status != 'REMOVED'").orderBy("campaign_criterion.criterion_id"),
    { maxRows: 5000 },
  );
}

// --------------------------------------------------------------------------------------- update_location_targeting
export const updateLocationTargeting = stateWrite({
  name: "update_location_targeting",
  title: "Update location targeting",
  risk: "write",
  description:
    "Adds or removes targeted and excluded locations on a campaign (Google location ids from resolve_google_locations), and optionally sets whether ads reach people IN the locations (PRESENCE) or also people interested in them (PRESENCE_OR_INTEREST). Is high impact when it widens reach. Removing every targeted location would target all countries, so that is refused. Applied atomically and confirmed by re-reading.",
  input: z
    .object({
      account_id: accountId,
      campaign_id: idSchema,
      add_targeted: z.array(idSchema).max(100).default([]),
      add_excluded: z.array(idSchema).max(100).default([]),
      remove: z.array(idSchema).max(100).default([]).describe("Location ids to remove, targeted or excluded."),
      location_match: z.enum(["PRESENCE", "PRESENCE_OR_INTEREST"]).optional(),
    })
    .refine((v) => v.add_targeted.length + v.add_excluded.length + v.remove.length > 0 || v.location_match, "give locations to add or remove, or location_match"),
  output: z.object({ campaign_id: z.string(), targeted: z.array(z.string()), excluded: z.array(z.string()), location_match: z.string().nullable() }),
  read: async (a, ads) => {
    const { c, row } = await readCampaign(ads, a.campaign_id, ["campaign.geo_target_type_setting.positive_geo_target_type"]);
    const rows = await readCriteria(ads, a.campaign_id, "LOCATION", ["campaign_criterion.location.geo_target_constant"]);
    const loc = rows.map((r) => ({ geo: tailId(pick(r, "campaign_criterion.location.geo_target_constant")) ?? "", criterion_id: String(pick(r, "campaign_criterion.criterion_id")), negative: pick(r, "campaign_criterion.negative") === true }));
    return { campaign: c, match: str(row, "campaign.geo_target_type_setting.positive_geo_target_type"), targeted: loc.filter((l) => !l.negative).map((l) => l.geo).sort(), excluded: loc.filter((l) => l.negative).map((l) => l.geo).sort(), criteria: loc.sort((x, y) => x.geo.localeCompare(y.geo)) };
  },
  build: (a, s, ads) => {
    const ref = { resource: "campaign", id: a.campaign_id, name: s.campaign.name };
    const have = new Map(s.criteria.map((l) => [l.geo, l]));
    const ops: Row[] = [];
    const changes: Change[] = [];
    for (const g of [...new Set(a.remove)]) {
      const l = have.get(g);
      if (!l) throw new ToolError("invalid_argument", `Location ${g} is not on this campaign.`);
      ops.push({ campaignCriterionOperation: { remove: ccRn(ads, a.campaign_id, l.criterion_id) } });
      // Removing a target narrows reach; removing an exclusion widens it.
      changes.push(change(ref, l.negative ? "excluded_location" : "targeted_location", g, null, l.negative ? "enable" : "pause"));
    }
    const removed = new Set(a.remove);
    for (const [list, negative] of [[a.add_targeted, false], [a.add_excluded, true]] as const) {
      for (const g of [...new Set(list)]) {
        const l = have.get(g);
        if (l && !removed.has(g)) {
          if (l.negative === negative) continue; // already there: skip
          throw new ToolError("invalid_argument", `Location ${g} is already ${l.negative ? "excluded" : "targeted"}; remove it first.`);
        }
        ops.push({ campaignCriterionOperation: { create: { campaign: rn(ads, "campaigns", a.campaign_id), negative, location: { geoTargetConstant: `geoTargetConstants/${g}` } } } });
        changes.push(change(ref, negative ? "excluded_location" : "targeted_location", null, g, negative ? "pause" : "enable"));
      }
    }
    const targetedAfter = new Set([...s.targeted.filter((g) => !removed.has(g)), ...a.add_targeted]);
    if (s.targeted.length > 0 && targetedAfter.size === 0) throw new ToolError("invalid_argument", "This would remove every targeted location, which makes the campaign target all countries. Add a location first.");
    if (a.location_match && a.location_match !== s.match) {
      ops.push({ campaignOperation: { update: { resourceName: rn(ads, "campaigns", a.campaign_id), geoTargetTypeSetting: { positiveGeoTargetType: a.location_match } }, updateMask: "geo_target_type_setting.positive_geo_target_type" } });
      changes.push(change(ref, "location_match", s.match, a.location_match, a.location_match === "PRESENCE_OR_INTEREST" ? "enable" : "pause"));
    }
    return { summary: `Campaign "${s.campaign.name ?? a.campaign_id}" locations: ${changes.map((c) => `${c.field} ${c.before ?? "+"}${c.after ? ` -> ${c.after}` : " removed"}`).join("; ")}`, changes, ops };
  },
  landed: (a, _b, after) =>
    a.add_targeted.every((g) => after.targeted.includes(g)) &&
    a.add_excluded.every((g) => after.excluded.includes(g)) &&
    a.remove.filter((g) => !a.add_targeted.includes(g) && !a.add_excluded.includes(g)).every((g) => !after.targeted.includes(g) && !after.excluded.includes(g)) &&
    (!a.location_match || after.match === a.location_match),
  result: (a, after) => ({ campaign_id: a.campaign_id, targeted: after.targeted, excluded: after.excluded, location_match: after.match }),
});

// ------------------------------------------------------------------------------------- campaign proximity (radius)
const proximityState = async (a: { campaign_id: string }, ads: GoogleAdsClient) => {
  const { c } = await readCampaign(ads, a.campaign_id);
  const rows = await readCriteria(ads, a.campaign_id, "PROXIMITY", ["campaign_criterion.proximity.radius", "campaign_criterion.proximity.radius_units", "campaign_criterion.proximity.geo_point.latitude_in_micro_degrees", "campaign_criterion.proximity.geo_point.longitude_in_micro_degrees", "campaign_criterion.proximity.address.postal_code", "campaign_criterion.proximity.address.city_name", "campaign_criterion.proximity.address.country_code"]);
  const p = (r: Row, f: string) => pick(r, `campaign_criterion.proximity.${f}`);
  return {
    campaign: c,
    proximities: rows.map((r) => ({
      criterion_id: String(pick(r, "campaign_criterion.criterion_id")),
      key: `${p(r, "geo_point.latitude_in_micro_degrees") ?? ""},${p(r, "geo_point.longitude_in_micro_degrees") ?? ""}|${String(p(r, "address.postal_code") ?? "").toLowerCase()}|${String(p(r, "address.city_name") ?? "").toLowerCase()}|${p(r, "radius")}|${p(r, "radius_units")}`,
      label: `${p(r, "radius")} ${String(p(r, "radius_units") ?? "").toLowerCase()} around ${p(r, "address.city_name") ?? p(r, "address.postal_code") ?? `${num(p(r, "geo_point.latitude_in_micro_degrees")) / 1e6},${num(p(r, "geo_point.longitude_in_micro_degrees")) / 1e6}`}`,
    })),
  };
};
const proximityInput = z
  .object({
    account_id: accountId,
    campaign_id: idSchema,
    radius: z.number().positive().max(800),
    radius_units: z.enum(["KILOMETERS", "MILES"]),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    address: z.object({ street_address: z.string().max(200).optional(), city_name: z.string().max(100).optional(), postal_code: z.string().max(20).optional(), country_code: z.string().regex(/^[A-Z]{2}$/) }).optional(),
  })
  .refine((v) => (v.latitude !== undefined && v.longitude !== undefined) || v.address, "give latitude and longitude, or an address");
const proxKey = (a: z.infer<typeof proximityInput>) => `${a.latitude !== undefined ? Math.round(a.latitude * 1e6) : ""},${a.longitude !== undefined ? Math.round(a.longitude * 1e6) : ""}|${(a.address?.postal_code ?? "").toLowerCase()}|${(a.address?.city_name ?? "").toLowerCase()}|${a.radius}|${a.radius_units}`;
export const addCampaignProximity = stateWrite({
  name: "add_campaign_proximity",
  title: "Add radius targeting",
  risk: "write",
  description: "Targets a radius around a point (latitude/longitude) or an address on a campaign, after approval; it widens reach, so it is high impact. Radius in kilometers or miles. An identical radius is refused. Confirmed by re-reading.",
  input: proximityInput,
  output: z.object({ campaign_id: z.string(), criterion_id: z.string().nullable() }),
  read: proximityState,
  build: (a, s, ads) => {
    if (s.proximities.some((p) => p.key === proxKey(a))) throw new ToolError("invalid_argument", "Nothing would change: this radius is already targeted.");
    const proximity: Row = { radius: a.radius, radiusUnits: a.radius_units };
    if (a.latitude !== undefined && a.longitude !== undefined) proximity.geoPoint = { latitudeInMicroDegrees: Math.round(a.latitude * 1e6), longitudeInMicroDegrees: Math.round(a.longitude * 1e6) };
    if (a.address) proximity.address = { countryCode: a.address.country_code, ...(a.address.street_address ? { streetAddress: a.address.street_address } : {}), ...(a.address.city_name ? { cityName: a.address.city_name } : {}), ...(a.address.postal_code ? { postalCode: a.address.postal_code } : {}) };
    const label = `${a.radius} ${a.radius_units.toLowerCase()} around ${a.address?.city_name ?? a.address?.postal_code ?? `${a.latitude},${a.longitude}`}`;
    return { summary: `Campaign "${s.campaign.name ?? a.campaign_id}": target ${label}`, changes: [change({ resource: "campaign", id: a.campaign_id, name: s.campaign.name }, "proximity", null, label, "enable")], ops: [{ campaignCriterionOperation: { create: { campaign: rn(ads, "campaigns", a.campaign_id), proximity } } }] };
  },
  landed: (a, _b, after) => after.proximities.some((p) => p.key === proxKey(a)),
  result: (a, after) => ({ campaign_id: a.campaign_id, criterion_id: after.proximities.find((p) => p.key === proxKey(a))?.criterion_id ?? null }),
});
export const removeCampaignProximity = stateWrite({
  name: "remove_campaign_proximity",
  title: "Remove radius targeting",
  risk: "destructive",
  description: "Removes radius (proximity) targets from a campaign after a person approves it. Give the criterion ids from get_campaign_targeting. If no other location remains, the campaign targets all locations, so that is refused. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, campaign_id: idSchema, criterion_ids: z.array(idSchema).min(1).max(50) }),
  output: z.object({ campaign_id: z.string(), removed: z.array(z.string()) }),
  read: async (a, ads) => {
    const s = await proximityState(a, ads);
    const locs = await readCriteria(ads, a.campaign_id, "LOCATION", []);
    return { ...s, positive_locations: locs.filter((r) => pick(r, "campaign_criterion.negative") !== true).length };
  },
  build: (a, s, ads) => {
    const ids = [...new Set(a.criterion_ids)].sort();
    const missing = ids.filter((id) => !s.proximities.some((p) => p.criterion_id === id));
    if (missing.length) throw new ToolError("invalid_argument", `Not a radius target on this campaign: ${missing.join(", ")}`);
    if (ids.length === s.proximities.length && s.positive_locations === 0) throw new ToolError("invalid_argument", "This would remove the last location target, which makes the campaign target all locations. Add another location first.");
    return {
      summary: `Campaign "${s.campaign.name ?? a.campaign_id}": remove ${ids.map((id) => s.proximities.find((p) => p.criterion_id === id)!.label).join("; ")}`,
      changes: ids.map((id) => change({ resource: "campaign", id: a.campaign_id, name: s.campaign.name }, "proximity", s.proximities.find((p) => p.criterion_id === id)!.label, null, "remove")),
      ops: ids.map((id) => ({ campaignCriterionOperation: { remove: ccRn(ads, a.campaign_id, id) } })),
    };
  },
  landed: (a, _b, after) => a.criterion_ids.every((id) => !after.proximities.some((p) => p.criterion_id === id)),
  result: (a) => ({ campaign_id: a.campaign_id, removed: [...new Set(a.criterion_ids)].sort() }),
});

// ----------------------------------------------------------------------------------------- set_campaign_ad_schedule
const MINUTES = { 0: "ZERO", 15: "FIFTEEN", 30: "THIRTY", 45: "FORTY_FIVE" } as const;
const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
const slot = z
  .object({ day_of_week: z.enum(DAYS), start_hour: z.number().int().min(0).max(23), start_minute: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(45)]).default(0), end_hour: z.number().int().min(0).max(24), end_minute: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(45)]).default(0), bid_modifier: z.number().min(0.1).max(10).optional() })
  .refine((s) => s.start_hour * 60 + s.start_minute < s.end_hour * 60 + s.end_minute && (s.end_hour < 24 || s.end_minute === 0), "end must be after start (24:00 at most)");
const slotKey = (d: string, sh: number, sm: string, eh: number, em: string) => `${d} ${sh}:${sm}-${eh}:${em}`;
export const setCampaignAdSchedule = stateWrite({
  name: "set_campaign_ad_schedule",
  title: "Set ad schedule",
  risk: "high_impact",
  description:
    "Replaces a campaign's ad schedule (days and hours when ads may show, in the account's time zone, optionally with a bid adjustment per slot), after a person approves it. Up to 6 slots per day. An empty schedule means ads may show at all times; pass clear: true to do that deliberately. Applied atomically and confirmed by re-reading.",
  input: z.object({ account_id: accountId, campaign_id: idSchema, slots: z.array(slot).max(42).default([]), clear: z.boolean().default(false) }).refine((v) => v.slots.length > 0 || v.clear, "give slots, or clear: true for no schedule"),
  output: z.object({ campaign_id: z.string(), slots: z.array(z.string()) }),
  read: async (a, ads) => {
    const { c } = await readCampaign(ads, a.campaign_id);
    const rows = await readCriteria(ads, a.campaign_id, "AD_SCHEDULE", ["campaign_criterion.ad_schedule.day_of_week", "campaign_criterion.ad_schedule.start_hour", "campaign_criterion.ad_schedule.start_minute", "campaign_criterion.ad_schedule.end_hour", "campaign_criterion.ad_schedule.end_minute"]);
    const p = (r: Row, f: string) => pick(r, `campaign_criterion.ad_schedule.${f}`);
    return { campaign: c, slots: rows.map((r) => ({ criterion_id: String(pick(r, "campaign_criterion.criterion_id")), key: slotKey(String(p(r, "day_of_week")), num(p(r, "start_hour")), String(p(r, "start_minute") ?? "ZERO"), num(p(r, "end_hour")), String(p(r, "end_minute") ?? "ZERO")), bid_modifier: pick(r, "campaign_criterion.bid_modifier") === undefined ? null : num(pick(r, "campaign_criterion.bid_modifier")) })).sort((x, y) => x.key.localeCompare(y.key)) };
  },
  build: (a, s, ads) => {
    const perDay = new Map<string, number>();
    for (const sl of a.slots) perDay.set(sl.day_of_week, (perDay.get(sl.day_of_week) ?? 0) + 1);
    if ([...perDay.values()].some((n) => n > 6)) throw new ToolError("invalid_argument", "At most 6 schedule slots per day.");
    const wanted = a.slots.map((sl) => ({ ...sl, key: slotKey(sl.day_of_week, sl.start_hour, MINUTES[sl.start_minute], sl.end_hour, MINUTES[sl.end_minute]) }));
    const have = new Map(s.slots.map((x) => [x.key, x]));
    const ops: Row[] = [];
    const changes: Change[] = [];
    const ref = { resource: "campaign", id: a.campaign_id, name: s.campaign.name };
    for (const x of s.slots) {
      const w = wanted.find((y) => y.key === x.key);
      if (w && (w.bid_modifier ?? null) === x.bid_modifier) continue;
      ops.push({ campaignCriterionOperation: { remove: ccRn(ads, a.campaign_id, x.criterion_id) } });
      if (!w) changes.push(change(ref, "ad_schedule", x.key, null, wanted.length ? "pause" : "enable"));
    }
    for (const w of wanted) {
      const x = have.get(w.key);
      if (x && (w.bid_modifier ?? null) === x.bid_modifier) continue;
      ops.push({ campaignCriterionOperation: { create: { campaign: rn(ads, "campaigns", a.campaign_id), adSchedule: { dayOfWeek: w.day_of_week, startHour: w.start_hour, startMinute: MINUTES[w.start_minute], endHour: w.end_hour, endMinute: MINUTES[w.end_minute] }, ...(w.bid_modifier !== undefined ? { bidModifier: w.bid_modifier } : {}) } } });
      changes.push(change(ref, "ad_schedule", x ? `${x.key} x${x.bid_modifier ?? 1}` : null, `${w.key}${w.bid_modifier !== undefined ? ` x${w.bid_modifier}` : ""}`, x && (w.bid_modifier ?? 1) < (x.bid_modifier ?? 1) ? "decrease_spend" : "enable"));
    }
    return { summary: `Campaign "${s.campaign.name ?? a.campaign_id}": ad schedule ${wanted.length ? `set to ${wanted.length} slot(s)` : "cleared (ads may show at all times)"}`, changes, ops };
  },
  landed: (a, _b, after) => {
    const want = a.slots.map((sl) => slotKey(sl.day_of_week, sl.start_hour, MINUTES[sl.start_minute], sl.end_hour, MINUTES[sl.end_minute])).sort();
    return JSON.stringify(after.slots.map((x) => x.key).sort()) === JSON.stringify(want);
  },
  result: (a, after) => ({ campaign_id: a.campaign_id, slots: after.slots.map((x) => x.key) }),
});

// --------------------------------------------------------------------------------- set_campaign_device_bid_modifiers
const DEVICES = ["MOBILE", "DESKTOP", "TABLET", "CONNECTED_TV"] as const;
const deviceInput = z.partialRecord(z.enum(DEVICES), z.number().min(0).max(10)).refine((v) => Object.keys(v).length > 0, "give at least one device");
const modifierEffect = (before: number | null, after: number): Effect => (after === 0 ? "pause" : after > (before ?? 1) ? "increase_spend" : after < (before ?? 1) ? "decrease_spend" : "neutral");
export const setCampaignDeviceBidModifiers = stateWrite({
  name: "set_campaign_device_bid_modifiers",
  title: "Set campaign device bid adjustments",
  risk: "high_impact",
  description: "Sets device bid adjustments on a campaign: 1.0 = no change, 1.2 = +20%, 0.5 = -50%, 0 = do not show on that device (max 10). Raising an adjustment is high impact; lowering one does not. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, campaign_id: idSchema, modifiers: deviceInput }),
  output: z.object({ campaign_id: z.string(), modifiers: z.record(z.string(), z.number().nullable()) }),
  read: async (a, ads) => {
    const { c } = await readCampaign(ads, a.campaign_id);
    const rows = await readCriteria(ads, a.campaign_id, "DEVICE", ["campaign_criterion.device.type"]);
    return { campaign: c, devices: rows.map((r) => ({ device: String(pick(r, "campaign_criterion.device.type")), criterion_id: String(pick(r, "campaign_criterion.criterion_id")), bid_modifier: pick(r, "campaign_criterion.bid_modifier") === undefined ? null : num(pick(r, "campaign_criterion.bid_modifier")) })).sort((x, y) => x.device.localeCompare(y.device)) };
  },
  build: (a, s, ads) => {
    const ops: Row[] = [];
    const changes: Change[] = [];
    for (const [device, mod] of Object.entries(a.modifiers) as [string, number][]) {
      const cur = s.devices.find((d) => d.device === device);
      if (cur && cur.bid_modifier === mod) continue;
      if (cur) ops.push({ campaignCriterionOperation: { update: { resourceName: ccRn(ads, a.campaign_id, cur.criterion_id), bidModifier: mod }, updateMask: "bid_modifier" } });
      else ops.push({ campaignCriterionOperation: { create: { campaign: rn(ads, "campaigns", a.campaign_id), device: { type: device }, bidModifier: mod } } });
      changes.push(change({ resource: "campaign", id: a.campaign_id, name: s.campaign.name }, `device_bid_modifier.${device}`, cur?.bid_modifier ?? null, mod, modifierEffect(cur?.bid_modifier ?? null, mod), "text"));
    }
    if (!ops.length) throw new ToolError("invalid_argument", "Nothing would change: these adjustments are already set.");
    return { summary: `Campaign "${s.campaign.name ?? a.campaign_id}" device adjustments: ${changes.map((c) => `${c.field.split(".")[1]} ${c.before ?? "none"} -> ${c.after}`).join("; ")}`, changes, ops };
  },
  landed: (a, _b, after) => (Object.entries(a.modifiers) as [string, number][]).every(([d, m]) => after.devices.find((x) => x.device === d)?.bid_modifier === m),
  result: (a, after) => ({ campaign_id: a.campaign_id, modifiers: Object.fromEntries(after.devices.map((d) => [d.device, d.bid_modifier])) }),
});

// -------------------------------------------------------------------------------- set_ad_group_device_bid_modifiers
export const setAdGroupDeviceBidModifiers = stateWrite({
  name: "set_ad_group_device_bid_modifiers",
  title: "Set ad group device bid adjustments",
  risk: "high_impact",
  description: "Sets device bid adjustments on an ad group: 1.0 = no change, 1.2 = +20%, 0 = do not show on that device (max 10). Ad group adjustments override the campaign's. Raising an adjustment is high impact. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema, modifiers: deviceInput }),
  output: z.object({ ad_group_id: z.string(), modifiers: z.record(z.string(), z.number().nullable()) }),
  read: async (a, ads) => {
    const [g] = await ads.query(new Gaql().select("ad_group.id", "ad_group.name", "ad_group.status").from("ad_group").where(`ad_group.id = ${lit.id(a.ad_group_id)}`).limit(1), { maxRows: 1 });
    if (!g) throw new ToolError("not_found", `No ad group ${a.ad_group_id} in this account.`);
    if (str(g, "ad_group.status") === "REMOVED") throw new ToolError("invalid_argument", "The ad group is removed and cannot be changed.");
    const rows = await ads.query(new Gaql().select("ad_group_bid_modifier.criterion_id", "ad_group_bid_modifier.device.type", "ad_group_bid_modifier.bid_modifier").from("ad_group_bid_modifier").where(`ad_group.id = ${lit.id(a.ad_group_id)}`).where("ad_group_bid_modifier.device.type IN ('MOBILE', 'DESKTOP', 'TABLET', 'CONNECTED_TV')"), { maxRows: 50 });
    return { name: str(g, "ad_group.name"), devices: rows.map((r) => ({ device: String(pick(r, "ad_group_bid_modifier.device.type")), criterion_id: String(pick(r, "ad_group_bid_modifier.criterion_id")), bid_modifier: pick(r, "ad_group_bid_modifier.bid_modifier") === undefined ? null : num(pick(r, "ad_group_bid_modifier.bid_modifier")) })).sort((x, y) => x.device.localeCompare(y.device)) };
  },
  build: (a, s, ads) => {
    const ops: Row[] = [];
    const changes: Change[] = [];
    for (const [device, mod] of Object.entries(a.modifiers) as [string, number][]) {
      const cur = s.devices.find((d) => d.device === device);
      if (cur && cur.bid_modifier === mod) continue;
      if (cur) ops.push({ adGroupBidModifierOperation: { update: { resourceName: `customers/${ads.customerId}/adGroupBidModifiers/${a.ad_group_id}~${cur.criterion_id}`, bidModifier: mod }, updateMask: "bid_modifier" } });
      else ops.push({ adGroupBidModifierOperation: { create: { adGroup: rn(ads, "adGroups", a.ad_group_id), device: { type: device }, bidModifier: mod } } });
      changes.push(change({ resource: "ad_group", id: a.ad_group_id, name: s.name }, `device_bid_modifier.${device}`, cur?.bid_modifier ?? null, mod, modifierEffect(cur?.bid_modifier ?? null, mod)));
    }
    if (!ops.length) throw new ToolError("invalid_argument", "Nothing would change: these adjustments are already set.");
    return { summary: `Ad group "${s.name ?? a.ad_group_id}" device adjustments: ${changes.map((c) => `${c.field.split(".")[1]} ${c.before ?? "none"} -> ${c.after}`).join("; ")}`, changes, ops };
  },
  landed: (a, _b, after) => (Object.entries(a.modifiers) as [string, number][]).every(([d, m]) => after.devices.find((x) => x.device === d)?.bid_modifier === m),
  result: (a, after) => ({ ad_group_id: a.ad_group_id, modifiers: Object.fromEntries(after.devices.map((d) => [d.device, d.bid_modifier])) }),
});

// ------------------------------------------------------------------------------------------- frequency caps
const capInput = z.object({ event_type: z.enum(["IMPRESSION", "VIDEO_VIEW"]).default("IMPRESSION"), level: z.enum(["CAMPAIGN", "AD_GROUP", "AD_GROUP_AD"]).default("CAMPAIGN"), time_unit: z.enum(["DAY", "WEEK", "MONTH"]), time_length: z.number().int().min(1).max(1).default(1), cap: z.number().int().min(1).max(1000) });
const capKey = (c: { level: string | null; event_type: string | null; time_unit: string | null; time_length: number | null }) => `${c.level}|${c.event_type}|${c.time_unit}|${c.time_length ?? 1}`;
function frequencyCapsTool(name: "update_campaign_frequency_caps" | "update_display_frequency_caps", channels: string[]) {
  return stateWrite({
    name,
    title: name === "update_display_frequency_caps" ? "Update Display frequency caps" : "Update campaign frequency caps",
    risk: "write",
    description: `Replaces the frequency caps (how many times one person may see ads per day, week or month) on a ${channels.join(" or ")} campaign, after approval. An empty list removes all caps (high impact because it widens delivery). One cap per level, event type and time unit. Confirmed by re-reading.`,
    input: z.object({ account_id: accountId, campaign_id: idSchema, caps: z.array(capInput).max(10) }),
    output: z.object({ campaign_id: z.string(), frequency_caps: z.array(z.object({ level: z.string().nullable(), event_type: z.string().nullable(), time_unit: z.string().nullable(), time_length: z.number().nullable(), cap: z.number().nullable() })) }),
    read: async (a, ads) => {
      const { c, row } = await readCampaign(ads, a.campaign_id, ["campaign.frequency_caps"]);
      if (!channels.includes(c.channel ?? "")) throw new ToolError("invalid_argument", `Frequency caps here apply to ${channels.join("/")} campaigns; this campaign is ${c.channel}.`);
      return { campaign: c, caps: mapCaps(pick(row, "campaign.frequency_caps")).sort((x, y) => capKey(x).localeCompare(capKey(y))) };
    },
    build: (a, s, ads) => {
      const keys = a.caps.map(capKey);
      if (new Set(keys).size !== keys.length) throw new ToolError("invalid_argument", "Only one cap per level, event type and time unit.");
      const want = a.caps.map((c) => ({ level: c.level, event_type: c.event_type, time_unit: c.time_unit, time_length: c.time_length, cap: c.cap })).sort((x, y) => capKey(x).localeCompare(capKey(y)));
      if (JSON.stringify(want) === JSON.stringify(s.caps)) throw new ToolError("invalid_argument", "Nothing would change: these caps are already set.");
      const ref = { resource: "campaign", id: a.campaign_id, name: s.campaign.name };
      const changes: Change[] = [];
      for (const k of new Set([...s.caps.map(capKey), ...want.map(capKey)])) {
        const b = s.caps.find((c) => capKey(c) === k)?.cap ?? null;
        const w = want.find((c) => capKey(c) === k)?.cap ?? null;
        if (b === w) continue;
        changes.push(change(ref, `frequency_cap.${k}`, b, w, w === null || (b !== null && w > b) ? "enable" : "pause"));
      }
      return {
        summary: `Campaign "${s.campaign.name ?? a.campaign_id}" frequency caps: ${want.length ? want.map((c) => `${c.cap} ${c.event_type?.toLowerCase()}s per ${c.time_unit?.toLowerCase()} (${c.level?.toLowerCase()})`).join("; ") : "none"}`,
        changes,
        // In the mask with an empty list clears the caps.
        ops: [{ campaignOperation: { update: { resourceName: rn(ads, "campaigns", a.campaign_id), frequencyCaps: want.map((c) => ({ key: { level: c.level, eventType: c.event_type, timeUnit: c.time_unit, timeLength: c.time_length }, cap: c.cap })) }, updateMask: "frequency_caps" } }],
      };
    },
    landed: (a, _b, after) => JSON.stringify(after.caps.map((c) => `${capKey(c)}=${c.cap}`).sort()) === JSON.stringify(a.caps.map((c) => `${capKey(c)}=${c.cap}`).sort()),
    result: (a, after) => ({ campaign_id: a.campaign_id, frequency_caps: after.caps }),
  });
}
export const updateCampaignFrequencyCaps = frequencyCapsTool("update_campaign_frequency_caps", ["DISPLAY", "VIDEO", "DEMAND_GEN"]);
export const updateDisplayFrequencyCaps = frequencyCapsTool("update_display_frequency_caps", ["DISPLAY"]);

// ----------------------------------------------------------------------------------------------- update_bid_strategy
const STRATEGIES = ["MANUAL_CPC", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_SPEND"] as const;
export const updateBidStrategy = stateWrite({
  name: "update_bid_strategy",
  title: "Update bid strategy",
  risk: "high_impact",
  description:
    "Changes a campaign's bidding (standard, campaign-level strategies only): MANUAL_CPC, MAXIMIZE_CONVERSIONS (optional target CPA), MAXIMIZE_CONVERSION_VALUE (optional target ROAS, e.g. 4.0 = 400%) or TARGET_SPEND (maximize clicks, optional max CPC). Campaigns on a shared portfolio strategy are refused. Is high impact unless only a target is lowered. Confirmed by re-reading.",
  input: z
    .object({ account_id: accountId, campaign_id: idSchema, strategy: z.enum(STRATEGIES), target_cpa: z.number().positive().max(1_000_000).optional(), target_roas: z.number().positive().max(1000).optional(), max_cpc: z.number().positive().max(10_000).optional() })
    .refine((v) => v.target_cpa === undefined || v.strategy === "MAXIMIZE_CONVERSIONS", "target_cpa only with MAXIMIZE_CONVERSIONS")
    .refine((v) => v.target_roas === undefined || v.strategy === "MAXIMIZE_CONVERSION_VALUE", "target_roas only with MAXIMIZE_CONVERSION_VALUE")
    .refine((v) => v.max_cpc === undefined || v.strategy === "TARGET_SPEND", "max_cpc only with TARGET_SPEND"),
  output: z.object({ campaign_id: z.string(), strategy: z.string().nullable(), target_cpa: z.number().nullable(), target_roas: z.number().nullable(), max_cpc: z.number().nullable() }),
  read: async (a, ads) => {
    const { c, row } = await readCampaign(ads, a.campaign_id, ["campaign.bidding_strategy_type", "campaign.bidding_strategy", "campaign.maximize_conversions.target_cpa_micros", "campaign.maximize_conversion_value.target_roas", "campaign.target_spend.cpc_bid_ceiling_micros"]);
    const n = (f: string) => (pick(row, f) === undefined ? null : num(pick(row, f)));
    return { campaign: c, strategy: str(row, "campaign.bidding_strategy_type"), portfolio: str(row, "campaign.bidding_strategy"), target_cpa_micros: n("campaign.maximize_conversions.target_cpa_micros"), target_roas: n("campaign.maximize_conversion_value.target_roas"), max_cpc_micros: n("campaign.target_spend.cpc_bid_ceiling_micros") };
  },
  build: (a, s, ads) => {
    if (s.portfolio) throw new ToolError("invalid_argument", "This campaign uses a shared portfolio bid strategy; changing it here would detach it. Not supported.");
    const update: Row = { resourceName: rn(ads, "campaigns", a.campaign_id) };
    let mask: string;
    if (a.strategy === "MANUAL_CPC") (update.manualCpc = {}), (mask = "manual_cpc");
    else if (a.strategy === "MAXIMIZE_CONVERSIONS") (update.maximizeConversions = a.target_cpa ? { targetCpaMicros: String(toMicros(a.target_cpa)) } : {}), (mask = a.target_cpa ? "maximize_conversions.target_cpa_micros" : "maximize_conversions");
    else if (a.strategy === "MAXIMIZE_CONVERSION_VALUE") (update.maximizeConversionValue = a.target_roas ? { targetRoas: a.target_roas } : {}), (mask = a.target_roas ? "maximize_conversion_value.target_roas" : "maximize_conversion_value");
    else (update.targetSpend = a.max_cpc ? { cpcBidCeilingMicros: String(toMicros(a.max_cpc)) } : {}), (mask = a.max_cpc ? "target_spend.cpc_bid_ceiling_micros" : "target_spend");
    const ref = { resource: "campaign", id: a.campaign_id, name: s.campaign.name };
    const changes: Change[] = [];
    if (s.strategy !== a.strategy) changes.push(change(ref, "bidding_strategy", s.strategy, a.strategy, "increase_spend")); // direction unknown: treated as the riskier one
    if (a.target_cpa !== undefined && toMicros(a.target_cpa) !== s.target_cpa_micros) changes.push(moneyChange(ref, "target_cpa", s.strategy === a.strategy ? s.target_cpa_micros : null, toMicros(a.target_cpa)));
    if (a.target_roas !== undefined && a.target_roas !== s.target_roas) changes.push(change(ref, "target_roas", s.target_roas, a.target_roas, s.strategy === a.strategy && s.target_roas !== null && a.target_roas > s.target_roas ? "decrease_spend" : "increase_spend")); // a higher ROAS target bids less
    if (a.max_cpc !== undefined && toMicros(a.max_cpc) !== s.max_cpc_micros) changes.push(moneyChange(ref, "max_cpc", s.strategy === a.strategy ? s.max_cpc_micros : null, toMicros(a.max_cpc)));
    if (!changes.length) throw new ToolError("invalid_argument", "Nothing would change: the campaign already uses this bidding.");
    return { summary: `Campaign "${s.campaign.name ?? a.campaign_id}" bidding: ${s.strategy} -> ${a.strategy}${a.target_cpa ? `, target CPA ${a.target_cpa}` : ""}${a.target_roas ? `, target ROAS ${a.target_roas}` : ""}${a.max_cpc ? `, max CPC ${a.max_cpc}` : ""}`, changes, ops: [{ campaignOperation: { update, updateMask: mask } }] };
  },
  landed: (a, _b, after) => after.strategy === a.strategy && (a.target_cpa === undefined || after.target_cpa_micros === toMicros(a.target_cpa)) && (a.target_roas === undefined || after.target_roas === a.target_roas) && (a.max_cpc === undefined || after.max_cpc_micros === toMicros(a.max_cpc)),
  result: (a, after) => ({ campaign_id: a.campaign_id, strategy: after.strategy, target_cpa: after.target_cpa_micros === null ? null : after.target_cpa_micros / 1e6, target_roas: after.target_roas, max_cpc: after.max_cpc_micros === null ? null : after.max_cpc_micros / 1e6 }),
});

// --------------------------------------------------------------------------------------- update_display_campaign_schedule
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, "not a real date");
export const updateDisplayCampaignSchedule = stateWrite({
  name: "update_display_campaign_schedule",
  title: "Update Display campaign dates",
  risk: "write",
  description: "Changes a Display campaign's start and/or end date (whole days in the account's time zone), or removes the end date, after approval. Starting earlier, ending later or removing the end is high impact. For other campaign types use update_campaign_dates. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, campaign_id: idSchema, start_date: day.optional(), end_date: day.optional(), clear_end_date: z.boolean().default(false) }).refine((v) => v.start_date || v.end_date || v.clear_end_date, "give start_date, end_date or clear_end_date").refine((v) => !(v.end_date && v.clear_end_date), "end_date and clear_end_date conflict"),
  output: z.object({ campaign_id: z.string(), start_date_time: z.string().nullable(), end_date_time: z.string().nullable() }),
  read: async (a, ads) => {
    const { c, row } = await readCampaign(ads, a.campaign_id, ["campaign.start_date_time", "campaign.end_date_time"]);
    if (c.channel !== "DISPLAY") throw new ToolError("invalid_argument", `Campaign ${a.campaign_id} is not a Display campaign (it is ${c.channel}). Use update_campaign_dates.`);
    return { campaign: c, start: str(row, "campaign.start_date_time"), end: str(row, "campaign.end_date_time") };
  },
  build: (a, s, ads) => {
    const start = a.start_date ? `${a.start_date} 00:00:00` : s.start;
    const end = a.clear_end_date ? null : a.end_date ? `${a.end_date} 23:59:59` : s.end;
    if (start && end && start > end) throw new ToolError("invalid_argument", "The end would be before the start.");
    if (start === s.start && end === s.end) throw new ToolError("invalid_argument", "Nothing would change: the campaign already has these dates.");
    const update: Row = { resourceName: rn(ads, "campaigns", a.campaign_id) };
    const mask: string[] = [];
    if (a.start_date) (update.startDateTime = start), mask.push("start_date_time");
    if (a.end_date) (update.endDateTime = end), mask.push("end_date_time");
    if (a.clear_end_date) mask.push("end_date_time");
    const ref = { resource: "campaign", id: a.campaign_id, name: s.campaign.name };
    const changes: Change[] = [];
    if (start !== s.start) changes.push(change(ref, "start_date_time", s.start, start, "enable"));
    // A later (or no) end date runs the campaign longer; an earlier one stops it sooner.
    if (end !== s.end) changes.push(change(ref, "end_date_time", s.end, end, end === null || (s.end !== null && end > s.end) ? "enable" : "pause"));
    return { summary: `Display campaign "${s.campaign.name ?? a.campaign_id}": start ${s.start ?? "none"} -> ${start ?? "none"}; end ${s.end ?? "none"} -> ${end ?? "none"}`, changes, ops: [{ campaignOperation: { update, updateMask: mask.join(",") } }] };
  },
  landed: (a, b, after) => after.start === (a.start_date ? `${a.start_date} 00:00:00` : b.start) && after.end === (a.clear_end_date ? null : a.end_date ? `${a.end_date} 23:59:59` : b.end),
  result: (a, after) => ({ campaign_id: a.campaign_id, start_date_time: after.start, end_date_time: after.end }),
});

export const campaignTargetingWriteTools = [updateLocationTargeting, addCampaignProximity, removeCampaignProximity, setCampaignAdSchedule, setCampaignDeviceBidModifiers, setAdGroupDeviceBidModifiers, updateCampaignFrequencyCaps, updateDisplayFrequencyCaps, updateBidStrategy, updateDisplayCampaignSchedule];
