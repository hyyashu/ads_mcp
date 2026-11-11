import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, isRealDate, lit, num, pick } from "../gaql";
import { tailId } from "./campaign-reads";
import { accountId, googleRead, idSchema, str } from "./common";
import { rn, stateWrite } from "./write-kit";

/**
 * Smart Bidding seasonality adjustments and data exclusions, per the v26 guides
 * developers.google.com/google-ads/api/docs/campaigns/bidding/seasonality-adjustments and .../data-exclusions and the
 * BiddingSeasonalityAdjustment / BiddingDataExclusion references:
 *  - scope CAMPAIGN (campaigns, at most 2,000) or CHANNEL (advertising_channel_types DISPLAY, SEARCH, SHOPPING); the
 *    CUSTOMER scope is read-only ("cannot be used in mutates");
 *  - start/end "yyyy-MM-dd HH:mm:ss" in the account's time zone, end exclusive, length within (0, 14 days];
 *  - seasonality adjustments look forward (events in the future), conversion_rate_modifier 0.1 to 10.0 (1.0 = none);
 *  - data exclusions look backward (start in the past).
 */

export const KINDS = ["seasonality_adjustment", "data_exclusion"] as const;
type Kind = (typeof KINDS)[number];
const LABEL: Record<Kind, string> = { seasonality_adjustment: "seasonality adjustment", data_exclusion: "data exclusion" };
const RESOURCE: Record<Kind, string> = { seasonality_adjustment: "bidding_seasonality_adjustment", data_exclusion: "bidding_data_exclusion" };
const ID_FIELD: Record<Kind, string> = { seasonality_adjustment: "seasonality_adjustment_id", data_exclusion: "data_exclusion_id" };
const COLLECTION: Record<Kind, string> = { seasonality_adjustment: "biddingSeasonalityAdjustments", data_exclusion: "biddingDataExclusions" };
const OPERATION: Record<Kind, string> = { seasonality_adjustment: "biddingSeasonalityAdjustmentOperation", data_exclusion: "biddingDataExclusionOperation" };

const CHANNEL_TYPES = ["SEARCH", "DISPLAY", "SHOPPING"] as const;
const DEVICES = ["MOBILE", "TABLET", "DESKTOP", "CONNECTED_TV", "OTHER"] as const;
const MAX_DAYS = 14;

/** One seasonality adjustment or data exclusion as returned to the caller. */
const adjustmentSchema = z.object({
  type: z.enum(KINDS),
  id: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  scope: z.string().nullable(),
  status: z.string().nullable(),
  campaign_ids: z.array(z.string()),
  channel_types: z.array(z.string()),
  devices: z.array(z.string()).describe("Empty means all devices."),
  start_date_time: z.string().nullable(),
  end_date_time: z.string().nullable().describe("Exclusive end, in the account's time zone."),
  conversion_rate_modifier: z.number().nullable().describe("Seasonality adjustments only (1.0 = no change)."),
});
type Adjustment = z.infer<typeof adjustmentSchema>;

/** Base query for one kind. FROM stays a literal per kind so the GAQL sweep checks both. */
function baseQuery(kind: Kind): Gaql {
  return kind === "seasonality_adjustment"
    ? new Gaql().select("bidding_seasonality_adjustment.seasonality_adjustment_id", "bidding_seasonality_adjustment.name", "bidding_seasonality_adjustment.description", "bidding_seasonality_adjustment.scope", "bidding_seasonality_adjustment.status", "bidding_seasonality_adjustment.campaigns", "bidding_seasonality_adjustment.advertising_channel_types", "bidding_seasonality_adjustment.devices", "bidding_seasonality_adjustment.start_date_time", "bidding_seasonality_adjustment.end_date_time", "bidding_seasonality_adjustment.conversion_rate_modifier").from("bidding_seasonality_adjustment")
    : new Gaql().select("bidding_data_exclusion.data_exclusion_id", "bidding_data_exclusion.name", "bidding_data_exclusion.description", "bidding_data_exclusion.scope", "bidding_data_exclusion.status", "bidding_data_exclusion.campaigns", "bidding_data_exclusion.advertising_channel_types", "bidding_data_exclusion.devices", "bidding_data_exclusion.start_date_time", "bidding_data_exclusion.end_date_time").from("bidding_data_exclusion");
}

function toAdjustment(kind: Kind, r: Row): Adjustment {
  const p = RESOURCE[kind];
  const list = (f: string) => ((pick(r, `${p}.${f}`) as unknown[] | undefined) ?? []).map(String);
  const mod = pick(r, `${p}.conversion_rate_modifier`);
  return {
    type: kind,
    id: String(pick(r, `${p}.${ID_FIELD[kind]}`) ?? ""),
    name: str(r, `${p}.name`),
    description: str(r, `${p}.description`),
    scope: str(r, `${p}.scope`),
    status: str(r, `${p}.status`),
    campaign_ids: list("campaigns").map((c) => tailId(c) ?? c).sort(),
    channel_types: list("advertising_channel_types").sort(),
    devices: list("devices").sort(),
    start_date_time: str(r, `${p}.start_date_time`),
    end_date_time: str(r, `${p}.end_date_time`),
    conversion_rate_modifier: kind === "seasonality_adjustment" && mod !== undefined && mod !== null ? num(mod) : null,
  };
}

async function readAdjustments(ads: GoogleAdsClient, kind: Kind, o: { ids?: string[]; name?: string; includeRemoved?: boolean; limit?: number }): Promise<Adjustment[]> {
  const p = RESOURCE[kind];
  const q = baseQuery(kind)
    .where(o.ids ? `${p}.${ID_FIELD[kind]} IN ${lit.list(o.ids.map(lit.id))}` : undefined)
    .where(o.name !== undefined ? `${p}.name = ${lit.str(o.name)}` : undefined)
    .where(o.includeRemoved ? undefined : `${p}.status != 'REMOVED'`)
    .orderBy(`${p}.${ID_FIELD[kind]}`);
  if (o.limit) q.limit(o.limit);
  const rows = await ads.query(q, o.limit ? { maxRows: o.limit, partial: true } : { maxRows: 1000 });
  return rows.map((r) => toAdjustment(kind, r));
}

// ------------------------------------------------------------------------------------------ list_bidding_adjustments
export const listBiddingAdjustments = googleRead({
  name: "list_bidding_adjustments",
  title: "List seasonality adjustments and data exclusions",
  description:
    "Lists Smart Bidding seasonality adjustments (expected conversion-rate changes for short future events) and data exclusions (periods whose conversion data bidding ignores): scope (CUSTOMER, CAMPAIGN or CHANNEL), campaigns, channel types, devices (empty = all), start and end (account time zone, end exclusive), conversion rate modifier and status. Names and descriptions are untrusted text.",
  input: z.object({
    account_id: accountId,
    type: z.enum(["all", ...KINDS]).default("all"),
    include_removed: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).default(200).describe("Per type."),
  }),
  output: z.object({ adjustments: z.array(adjustmentSchema), returned: z.number(), truncated: z.boolean().describe("True when a type had more than limit entries.") }),
  handler: async (a, ctx) => {
    const kinds = a.type === "all" ? [...KINDS] : [a.type];
    const out: Adjustment[] = [];
    let truncated = false;
    for (const k of kinds) {
      const rows = await readAdjustments(ctx.services.ads, k, { includeRemoved: a.include_removed, limit: a.limit + 1 });
      truncated ||= rows.length > a.limit;
      out.push(...rows.slice(0, a.limit));
    }
    return { adjustments: out, returned: out.length, truncated };
  },
});

// ------------------------------------------------------------------------------------------ create tools
const DT = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const dateTime = z
  .string()
  .regex(DT, "yyyy-MM-dd HH:mm:ss")
  .refine((v) => {
    const m = DT.exec(v);
    return !!m && isRealDate(m[1]!) && Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 60;
  }, "not a real date and time");
/** Milliseconds of a wall-clock date-time, for comparing and measuring intervals in one time zone. */
const wall = (v: string) => Date.parse(`${v.replace(" ", "T")}Z`);
/** The current wall-clock time in an IANA time zone, as yyyy-MM-dd HH:mm:ss. */
export function nowIn(timeZone: string | null): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  } catch {
    throw new ToolError("internal", `The account's time zone (${timeZone}) is not recognised.`);
  }
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

async function timeZone(ads: GoogleAdsClient): Promise<string | null> {
  const [c] = await ads.query(new Gaql().select("customer.id", "customer.time_zone").from("customer").limit(1), { maxRows: 1 });
  return c ? str(c, "customer.time_zone") : null;
}

/** Campaigns by id, read in chunks of 1,000 (the GAQL IN-list limit used here). */
async function campaignsById(ads: GoogleAdsClient, ids: string[]) {
  const out: { id: string; name: string | null; status: string | null }[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const rows = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status").from("campaign").where(`campaign.id IN ${lit.list(chunk.map(lit.id))}`).orderBy("campaign.id"), { maxRows: chunk.length + 1 });
    out.push(...rows.map((r) => ({ id: String(pick(r, "campaign.id") ?? ""), name: str(r, "campaign.name"), status: str(r, "campaign.status") })));
  }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}

function createTool(kind: Kind) {
  const seasonality = kind === "seasonality_adjustment";
  const input = z
    .object({
      account_id: accountId,
      name: z.string().trim().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters").describe(`Unique among the account's ${LABEL[kind]}s (at most 255 characters).`),
      description: z.string().trim().min(1).max(2048).optional(),
      scope: z.enum(["CAMPAIGN", "CHANNEL"]).describe("CAMPAIGN: the listed campaign_ids. CHANNEL: every campaign of the listed channel_types, now and later. (Google's CUSTOMER scope cannot be created through the API.)"),
      campaign_ids: z.array(idSchema).min(1).max(2000).optional().describe("Scope CAMPAIGN: up to 2,000 campaign ids."),
      channel_types: z.array(z.enum(CHANNEL_TYPES)).min(1).max(3).optional().describe("Scope CHANNEL: SEARCH, DISPLAY and/or SHOPPING."),
      devices: z.array(z.enum(DEVICES)).min(1).max(5).optional().describe("Limit to these devices; omit for all devices."),
      start_date_time: dateTime.describe(`Inclusive start, yyyy-MM-dd HH:mm:ss in the account's time zone. ${seasonality ? "Must be in the future." : "Must be in the past."}`),
      end_date_time: dateTime.describe(`Exclusive end, yyyy-MM-dd HH:mm:ss. At most ${MAX_DAYS} days after the start.`),
      ...(seasonality ? { conversion_rate_modifier: z.number().min(0.1).max(10).describe("Expected conversion-rate multiplier, 0.1 to 10.0 (1.5 = 50% higher, 0.5 = half; 1.0 would change nothing).") } : {}),
    })
    .refine((v) => (v.scope === "CAMPAIGN" ? !!v.campaign_ids?.length && !v.channel_types : !!v.channel_types?.length && !v.campaign_ids), "scope CAMPAIGN needs campaign_ids (and no channel_types); scope CHANNEL needs channel_types (and no campaign_ids)")
    .refine((v) => wall(v.end_date_time) > wall(v.start_date_time), "end_date_time must be after start_date_time")
    .refine((v) => wall(v.end_date_time) - wall(v.start_date_time) <= MAX_DAYS * 86_400_000, `the interval can be at most ${MAX_DAYS} days`);
  type A = z.infer<typeof input> & { conversion_rate_modifier?: number };
  const want = (a: A) => ({
    campaign_ids: [...new Set(a.campaign_ids ?? [])].sort(),
    channel_types: [...new Set(a.channel_types ?? [])].sort(),
    devices: [...new Set(a.devices ?? [])].sort(),
  });
  const matches = (a: A, x: Adjustment) => {
    const w = want(a);
    return x.status !== "REMOVED" && x.scope === a.scope && x.start_date_time === a.start_date_time && x.end_date_time === a.end_date_time && JSON.stringify(x.campaign_ids) === JSON.stringify(w.campaign_ids) && JSON.stringify(x.channel_types) === JSON.stringify(w.channel_types) && JSON.stringify(x.devices) === JSON.stringify(w.devices) && (!seasonality || x.conversion_rate_modifier === a.conversion_rate_modifier);
  };
  return stateWrite({
    name: seasonality ? "create_seasonality_adjustment" : "create_data_exclusion",
    title: seasonality ? "Create seasonality adjustment" : "Create data exclusion",
    // inventory/mapping.ts plans this tool as "write"; its change set marks the effect, so approvals come out high_impact.
    risk: "high_impact",
    description: seasonality
      ? `Creates a Smart Bidding seasonality adjustment after approval: tells automated bidding to expect a conversion-rate change (conversion_rate_modifier 0.1 to 10.0) during a short future event, for listed campaigns (scope CAMPAIGN, up to 2,000) or whole channel types (scope CHANNEL: SEARCH, DISPLAY, SHOPPING), optionally only some devices. Start must be in the future; the interval is at most ${MAX_DAYS} days (Google recommends 1 to 7). High impact: it changes bids. Confirmed by re-reading.`
      : `Creates a Smart Bidding data exclusion after approval: automated bidding ignores conversion data from a past period with tracking problems (start in the past, at most ${MAX_DAYS} days), for listed campaigns (scope CAMPAIGN, up to 2,000) or whole channel types (scope CHANNEL: SEARCH, DISPLAY, SHOPPING), optionally only some devices. Google allows 500 active data exclusions per account and advises using them rarely. High impact: it changes what bidding learns from. Confirmed by re-reading.`,
    input,
    output: adjustmentSchema,
    read: async (a, ads) => ({
      time_zone: await timeZone(ads),
      campaigns: a.scope === "CAMPAIGN" ? await campaignsById(ads, [...new Set(a.campaign_ids ?? [])]) : [],
      same_name: await readAdjustments(ads, kind, { name: a.name }),
    }),
    build: (a0, s, ads) => {
      const a = a0 as A;
      const w = want(a);
      const missing = w.campaign_ids.filter((id) => !s.campaigns.some((c) => c.id === id));
      if (missing.length) throw new ToolError("not_found", `No campaign ${missing.slice(0, 20).join(", ")} in this account.`);
      const removed = s.campaigns.filter((c) => c.status === "REMOVED");
      if (removed.length) throw new ToolError("invalid_argument", `Removed campaigns cannot be included: ${removed.slice(0, 20).map((c) => c.id).join(", ")}.`);
      if (seasonality && a.conversion_rate_modifier === 1) throw new ToolError("invalid_argument", "Nothing would change: a conversion_rate_modifier of 1.0 applies no adjustment.");
      if (s.same_name.length) throw new ToolError("invalid_argument", `A ${LABEL[kind]} named "${a.name}" already exists (id ${s.same_name[0]!.id}). Use another name.`);
      const now = nowIn(s.time_zone);
      if (seasonality && a.start_date_time <= now) throw new ToolError("invalid_argument", `A seasonality adjustment is for a future event: start_date_time must be after now (${now} in the account's time zone ${s.time_zone ?? "UTC"}).`);
      if (!seasonality && a.start_date_time >= now) throw new ToolError("invalid_argument", `A data exclusion covers a past period: start_date_time must be before now (${now} in the account's time zone ${s.time_zone ?? "UTC"}).`);
      const body: Row = {
        name: a.name,
        scope: a.scope,
        startDateTime: a.start_date_time,
        endDateTime: a.end_date_time,
        ...(a.description ? { description: a.description } : {}),
        ...(w.campaign_ids.length ? { campaigns: w.campaign_ids.map((id) => rn(ads, "campaigns", id)) } : {}),
        ...(w.channel_types.length ? { advertisingChannelTypes: w.channel_types } : {}),
        ...(w.devices.length ? { devices: w.devices } : {}),
        ...(seasonality ? { conversionRateModifier: a.conversion_rate_modifier } : {}),
      };
      const target = a.scope === "CAMPAIGN" ? `${w.campaign_ids.length} campaign(s)` : `all ${w.channel_types.join("/")} campaigns`;
      const what = `${a.start_date_time} to ${a.end_date_time}, ${target}${w.devices.length ? `, devices ${w.devices.join("/")}` : ""}${seasonality ? `, conversion rate x${a.conversion_rate_modifier}` : ""}`;
      const changes: Change[] = [{ resource: RESOURCE[kind], id: "new", name: a.name, field: kind, before: null, after: what, unit: "text", effect: "create" }];
      return { summary: `Create ${LABEL[kind]} "${a.name}": ${what}.`, changes, ops: [{ [OPERATION[kind]]: { create: body } }] };
    },
    landed: (a, _b, after) => after.same_name.some((x) => matches(a as A, x)),
    result: (a, after) => after.same_name.find((x) => matches(a as A, x))!,
  });
}
export const createSeasonalityAdjustment = createTool("seasonality_adjustment");
export const createDataExclusion = createTool("data_exclusion");

// ------------------------------------------------------------------------------------------ remove_bidding_adjustment
export const removeBiddingAdjustment = stateWrite({
  name: "remove_bidding_adjustment",
  title: "Remove seasonality adjustment or data exclusion",
  risk: "destructive",
  description: "Removes seasonality adjustments or data exclusions (give type and the ids from list_bidding_adjustments) after approval. Irreversible: a removed one cannot be restored, only created again. Applied atomically and confirmed by re-reading.",
  input: z.object({ account_id: accountId, type: z.enum(KINDS), ids: z.array(idSchema).min(1).max(50) }),
  output: z.object({ type: z.enum(KINDS), removed: z.array(z.string()) }),
  read: async (a, ads) => {
    const ids = [...new Set(a.ids)].sort();
    const found = await readAdjustments(ads, a.type, { ids, includeRemoved: true });
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    const other: Kind = a.type === "seasonality_adjustment" ? "data_exclusion" : "seasonality_adjustment";
    const elsewhere = missing.length ? (await readAdjustments(ads, other, { ids: missing, includeRemoved: true })).map((x) => x.id) : [];
    return { found, missing, other_type: elsewhere };
  },
  build: (a, s, ads) => {
    if (s.other_type.length) throw new ToolError("invalid_argument", `${s.other_type.join(", ")} ${s.other_type.length > 1 ? "are" : "is"} not a ${LABEL[a.type]} but a ${LABEL[a.type === "seasonality_adjustment" ? "data_exclusion" : "seasonality_adjustment"]}: use type ${a.type === "seasonality_adjustment" ? "data_exclusion" : "seasonality_adjustment"}.`);
    if (s.missing.length) throw new ToolError("not_found", `No ${LABEL[a.type]} ${s.missing.join(", ")} in this account.`);
    const live = s.found.filter((x) => x.status !== "REMOVED");
    if (!live.length) throw new ToolError("invalid_argument", `Nothing would change: ${s.found.map((x) => x.id).join(", ")} ${s.found.length > 1 ? "are" : "is"} already removed.`);
    if (live.length !== s.found.length) throw new ToolError("invalid_argument", `Already removed: ${s.found.filter((x) => x.status === "REMOVED").map((x) => x.id).join(", ")}. Leave them out.`);
    const changes: Change[] = live.map((x) => ({ resource: RESOURCE[a.type], id: x.id, name: x.name, field: "status", before: x.status, after: "REMOVED", unit: "status", effect: "remove" }));
    return { summary: `Remove ${live.length} ${LABEL[a.type]}(s): ${live.slice(0, 10).map((x) => `"${x.name ?? x.id}" (${x.start_date_time} to ${x.end_date_time})`).join("; ")}`, changes, ops: live.map((x) => ({ [OPERATION[a.type]]: { remove: rn(ads, COLLECTION[a.type], x.id) } })) };
  },
  landed: (a, _b, after) => a.ids.every((id) => after.found.find((x) => x.id === id)?.status !== "ENABLED"),
  result: (a) => ({ type: a.type, removed: [...new Set(a.ids)].sort() }),
});

export const biddingAdjustmentTools = [listBiddingAdjustments, createSeasonalityAdjustment, createDataExclusion, removeBiddingAdjustment];
