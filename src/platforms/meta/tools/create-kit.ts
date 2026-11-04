import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { type Change, moneyChange } from "../../../policy/change-set";
import { type MetaAdsClient, type MetaRow, currencyOffset, toMinor } from "../client";
import { EDGE_CAP, requireOnEdge, requirePromotablePage, s } from "./common";
import { epoch } from "./edits";

/*
 * Shared pieces of the Meta creation tools, checked against the Marketing API v27 docs on 2026-11-05.
 *
 * Objective / optimization goal / billing event: Meta's docs point to an "Outcome-Driven Ads Experiences mapping table" that the
 * docs search did not return, so only combinations shown in Meta's own guides are accepted:
 *   OUTCOME_SALES, OUTCOME_LEADS, OUTCOME_ENGAGEMENT, OUTCOME_TRAFFIC with OFFSITE_CONVERSIONS / IMPRESSIONS and a pixel
 *     promoted_object (Dynamic Creative guide: "You must set the optimization_goal to OFFSITE_CONVERSIONS for OUTCOME_SALES,
 *     OUTCOME_ENGAGEMENT, OUTCOME_LEADS, and OUTCOME_TRAFFIC", example with billing_event IMPRESSIONS and
 *     promoted_object {pixel_id, custom_event_type: PURCHASE});
 *   OUTCOME_TRAFFIC with LINK_CLICKS / LINK_CLICKS (Audience Network guide example).
 * OUTCOME_AWARENESS and OUTCOME_APP_PROMOTION have no documented combination here and are not offered. PURCHASE is the only
 * custom_event_type shown in the docs found.
 *
 * Campaign: special_ad_categories is required (an empty array is allowed); without a campaign budget,
 * is_adset_budget_sharing_enabled must be sent as true or false (v24+, Ad Set Budget Sharing guide). Special ad categories
 * offered: HOUSING, EMPLOYMENT, FINANCIAL_PRODUCTS_SERVICES. Their documented audience restrictions are enforced: age fixed to
 * 18-65+, no gender selection, city radius at least 15 miles / 25 km, no detailed-targeting interests (only a Meta-approved
 * list is allowed, which cannot be checked here).
 * Targeting: geo_locations {countries, regions [{key}], cities [{key, radius, distance_unit}]}, age_min/age_max, genders,
 * flexible_spec [{interests: [{id}]}]. targeting_automation.advantage_audience is always sent explicitly (v23+ requires an
 * explicit value for non-default targeting); with it on, age_min must be 18-25 and age_max cannot be set (fixed at 65).
 * Placements: publisher_platforms facebook/instagram with documented positions. Instagram Explore and Messenger Stories were
 * removed in v26 and are never offered; meta_moment_maker_spec is never sent.
 */

export const OBJECTIVES = ["OUTCOME_SALES", "OUTCOME_LEADS", "OUTCOME_ENGAGEMENT", "OUTCOME_TRAFFIC"] as const;
export type Objective = (typeof OBJECTIVES)[number];
export const GOALS = ["OFFSITE_CONVERSIONS", "LINK_CLICKS"] as const;
export type Goal = (typeof GOALS)[number];
/** Documented (objective, optimization goal) pairs and the billing event shown with each. */
export const COMBOS: Record<Objective, Partial<Record<Goal, string>>> = {
  OUTCOME_SALES: { OFFSITE_CONVERSIONS: "IMPRESSIONS" },
  OUTCOME_LEADS: { OFFSITE_CONVERSIONS: "IMPRESSIONS" },
  OUTCOME_ENGAGEMENT: { OFFSITE_CONVERSIONS: "IMPRESSIONS" },
  OUTCOME_TRAFFIC: { OFFSITE_CONVERSIONS: "IMPRESSIONS", LINK_CLICKS: "LINK_CLICKS" },
};
export const COMBO_TEXT = "OUTCOME_SALES, OUTCOME_LEADS, OUTCOME_ENGAGEMENT or OUTCOME_TRAFFIC with OFFSITE_CONVERSIONS (billed on IMPRESSIONS, needs pixel_id); OUTCOME_TRAFFIC with LINK_CLICKS (billed on LINK_CLICKS)";
export function billingFor(objective: string, goal: Goal): string {
  const b = (COMBOS as Record<string, Partial<Record<Goal, string>>>)[objective]?.[goal];
  if (!b) throw new ToolError("invalid_argument", `Optimization goal ${goal} is not a documented combination for ${objective}. Allowed: ${COMBO_TEXT}.`);
  return b;
}

export const SPECIAL = ["HOUSING", "EMPLOYMENT", "FINANCIAL_PRODUCTS_SERVICES"] as const;
const FB_POSITIONS = ["feed", "story", "facebook_reels", "marketplace", "video_feeds", "search", "profile_feed"] as const;
const IG_POSITIONS = ["stream", "story", "reels", "profile_feed", "ig_search"] as const;
export const CTA = ["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "BOOK_NOW", "CONTACT_US", "DOWNLOAD", "GET_OFFER", "APPLY_NOW", "ORDER_NOW", "SUBSCRIBE", "BUY_NOW", "GET_QUOTE"] as const;

// ------------------------------------------------------------------------------------------------------- input pieces
const noCtl = /^[^\u0000-\u001f\u007f]+$/;
export const objName = (max: number) => z.string().trim().min(1).max(max).regex(noCtl, "no control characters or line breaks");
export const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/, "no control characters");
export const httpsLink = z
  .string()
  .max(1000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password && !!u.hostname;
    } catch {
      return false;
    }
  }, "an https URL without credentials (at most 1000 characters)");
export const urlTags = z.string().max(1024).regex(/^[A-Za-z0-9_.~%-]+=[^&\s]*(&[A-Za-z0-9_.~%-]+=[^&\s]*)*$/, "key=value pairs joined with &").optional().describe("Query parameters added to clicked URLs, e.g. utm_source=meta&utm_medium=paid.");
export const isoTime = z.string().refine((v) => epoch(v) !== null && /T\d{2}:\d{2}/.test(v), "an ISO 8601 date-time with a time zone");
const id = z.string().regex(/^\d{1,25}$/, "numeric id");
export const imageHash = z.string().regex(/^[A-Za-z0-9]{8,64}$/, "an image hash from discover_meta_assets");

export const targetingInput = z.object({
  countries: z.array(z.string().regex(/^[A-Z]{2}$/, "ISO country code")).min(1).max(25),
  regions: z.array(z.object({ key: z.string().regex(/^\d{1,12}$/) })).max(50).optional().describe("Region keys from search_meta_targeting."),
  cities: z.array(z.object({ key: z.string().regex(/^\d{1,12}$/), radius: z.number().min(1).max(50).optional(), distance_unit: z.enum(["mile", "kilometer"]).optional() })).max(50).optional(),
  age_min: z.number().int().min(18).max(65).optional(),
  age_max: z.number().int().min(18).max(65).optional(),
  genders: z.array(z.union([z.literal(1), z.literal(2)])).min(1).max(2).optional().describe("1 = men, 2 = women. Omit for all."),
  interests: z.array(id).max(50).optional().describe("Interest ids from browse_meta_targeting or search_meta_targeting."),
  advantage_audience: z.boolean().default(false).describe("Advantage+ audience: lets Meta expand beyond age and interests. With it on, age_min must be 18-25 and age_max is fixed at 65."),
  publisher_platforms: z.array(z.enum(["facebook", "instagram"])).min(1).max(2).optional().describe("Manual placements. Omit for automatic placements."),
  facebook_positions: z.array(z.enum(FB_POSITIONS)).min(1).max(FB_POSITIONS.length).optional(),
  instagram_positions: z.array(z.enum(IG_POSITIONS)).min(1).max(IG_POSITIONS.length).optional(),
});
export type TargetingIn = z.infer<typeof targetingInput>;

export const budgetInput = z.object({
  level: z.enum(["campaign", "ad_set"]).describe("campaign: Advantage campaign budget. ad_set: the ad set owns the budget."),
  type: z.enum(["daily", "lifetime"]),
  amount: z.number().positive().max(100_000_000).describe("In the account's currency."),
});
export type BudgetIn = z.infer<typeof budgetInput>;

export const adSetCore = {
  ad_set_name: objName(255),
  optimization_goal: z.enum(GOALS),
  pixel_id: id.optional().describe("Required with OFFSITE_CONVERSIONS: a pixel of this ad account."),
  custom_event_type: z.enum(["PURCHASE"]).default("PURCHASE").describe("Conversion event for OFFSITE_CONVERSIONS. Only PURCHASE is documented in the guides checked."),
  targeting: targetingInput,
  start_time: isoTime.optional(),
  end_time: isoTime.optional().describe("Required with a lifetime budget."),
};

export const destination = {
  page_id: id.describe("A Facebook Page this ad account promotes (list_meta_pages)."),
  instagram_account_id: id.optional().describe("Instagram account connected to this ad account (list_meta_instagram_accounts)."),
  link: httpsLink.describe("Website the ad sends people to."),
  url_tags: urlTags,
};

// --------------------------------------------------------------------------------------------------------- validation
/** Builds the targeting spec, enforcing special ad category restrictions and the Advantage+ audience rules. */
export function buildTargeting(t: TargetingIn, special: readonly string[]): Record<string, unknown> {
  if (special.length) {
    const cats = special.join(", ");
    if ((t.age_min !== undefined && t.age_min !== 18) || (t.age_max !== undefined && t.age_max !== 65)) throw new ToolError("invalid_argument", `With special ad category ${cats}, Meta fixes the age range to 18-65+: do not narrow it.`);
    if (t.genders) throw new ToolError("invalid_argument", `With special ad category ${cats}, a specific gender cannot be chosen.`);
    if (t.interests?.length) throw new ToolError("invalid_argument", `With special ad category ${cats}, only interests on a Meta-approved list are allowed; interest targeting is not offered here.`);
    for (const c of t.cities ?? []) {
      // Meta states the minimum in each unit (15 miles or 25 km for the US and Canada), so compare in the unit given.
      const ok = c.radius !== undefined && (c.distance_unit === "kilometer" ? c.radius >= 25 : c.radius >= 15);
      if (!ok) throw new ToolError("invalid_argument", `With special ad category ${cats}, city targeting needs a radius of at least 15 miles or 25 km.`);
    }
  }
  if (t.age_min !== undefined && t.age_max !== undefined && t.age_min > t.age_max) throw new ToolError("invalid_argument", "age_min must not be above age_max.");
  if (t.advantage_audience) {
    if (t.age_max !== undefined && t.age_max !== 65) throw new ToolError("invalid_argument", "With Advantage+ audience Meta fixes age_max at 65: omit age_max or turn advantage_audience off.");
    if (t.age_min !== undefined && t.age_min > 25) throw new ToolError("invalid_argument", "With Advantage+ audience age_min must be 18-25.");
  }
  if ((t.facebook_positions || t.instagram_positions) && !t.publisher_platforms) throw new ToolError("invalid_argument", "Give publisher_platforms with manual positions.");
  if (t.facebook_positions && !t.publisher_platforms?.includes("facebook")) throw new ToolError("invalid_argument", "facebook_positions need facebook in publisher_platforms.");
  if (t.instagram_positions && !t.publisher_platforms?.includes("instagram")) throw new ToolError("invalid_argument", "instagram_positions need instagram in publisher_platforms.");
  const fb = t.facebook_positions ?? [];
  if (fb.some((p) => ["marketplace", "search", "profile_feed"].includes(p)) && !fb.includes("feed")) throw new ToolError("invalid_argument", "Facebook marketplace, search and profile_feed need Facebook feed too.");
  if (fb.includes("story") && !fb.includes("feed") && !(t.instagram_positions ?? []).includes("story")) throw new ToolError("invalid_argument", "Facebook story needs Facebook feed or Instagram story too.");

  const geo: Record<string, unknown> = { countries: t.countries };
  if (t.regions?.length) geo.regions = t.regions.map((r) => ({ key: r.key }));
  if (t.cities?.length) geo.cities = t.cities.map((c) => ({ key: c.key, ...(c.radius !== undefined ? { radius: c.radius, distance_unit: c.distance_unit ?? "mile" } : {}) }));
  return {
    geo_locations: geo,
    ...(t.age_min !== undefined ? { age_min: t.age_min } : {}),
    ...(t.age_max !== undefined ? { age_max: t.age_max } : {}),
    ...(t.genders ? { genders: t.genders } : {}),
    ...(t.interests?.length ? { flexible_spec: [{ interests: t.interests.map((i) => ({ id: i })) }] } : {}),
    ...(t.publisher_platforms ? { publisher_platforms: t.publisher_platforms } : {}),
    ...(t.facebook_positions ? { facebook_positions: t.facebook_positions } : {}),
    ...(t.instagram_positions ? { instagram_positions: t.instagram_positions } : {}),
    targeting_automation: { advantage_audience: t.advantage_audience ? 1 : 0 },
  };
}

/** Start and end as Unix seconds, validated: future, end after start, end required for lifetime budgets. */
export function schedule(a: { start_time?: string; end_time?: string }, lifetime: boolean, now = Math.floor(Date.now() / 1000)) {
  const start = a.start_time ? epoch(a.start_time)! : null;
  const end = a.end_time ? epoch(a.end_time)! : null;
  if (lifetime && end === null) throw new ToolError("invalid_argument", "A lifetime budget needs an end_time.");
  if (start !== null && start <= now) throw new ToolError("invalid_argument", "start_time must be in the future.");
  if (end !== null && end <= Math.max(now, start ?? 0)) throw new ToolError("invalid_argument", "end_time must be in the future and after start_time.");
  return { start, end };
}

/** Ad set POST parameters (without campaign_id, budget and is_dynamic_creative). Always PAUSED. */
export function adSetParams(a: { ad_set_name: string; optimization_goal: Goal; pixel_id?: string; custom_event_type: string; targeting: TargetingIn; start_time?: string; end_time?: string }, objective: string, special: readonly string[], lifetime: boolean) {
  const billing = billingFor(objective, a.optimization_goal);
  if (a.optimization_goal === "OFFSITE_CONVERSIONS" && !a.pixel_id) throw new ToolError("invalid_argument", "OFFSITE_CONVERSIONS needs a pixel_id.");
  if (a.optimization_goal !== "OFFSITE_CONVERSIONS" && a.pixel_id) throw new ToolError("invalid_argument", "pixel_id applies only to OFFSITE_CONVERSIONS.");
  const { start, end } = schedule(a, lifetime);
  return {
    name: a.ad_set_name,
    optimization_goal: a.optimization_goal,
    billing_event: billing,
    targeting: JSON.stringify(buildTargeting(a.targeting, special)),
    status: "PAUSED",
    ...(a.pixel_id ? { promoted_object: JSON.stringify({ pixel_id: a.pixel_id, custom_event_type: a.custom_event_type }) } : {}),
    ...(start !== null ? { start_time: String(start) } : {}),
    ...(end !== null ? { end_time: String(end) } : {}),
  } as Record<string, string>;
}

export function budgetParams(b: BudgetIn, currency: string | null): Record<string, string> {
  const v = toMinor(b.amount, currency);
  if (v <= 0) throw new ToolError("invalid_argument", "The budget is too small for this currency.");
  return { [b.type === "daily" ? "daily_budget" : "lifetime_budget"]: String(v) };
}

export function budgetChange(ref: { resource: string; id: string; name?: string | null }, b: BudgetIn, currency: string | null): Change {
  const off = currencyOffset(currency);
  if (off === null) throw new ToolError("internal", "The account's currency is unknown, so the budget cannot be shown.");
  return moneyChange(ref, `${b.type}_budget`, null, Math.round((toMinor(b.amount, currency) / off) * 1e6));
}

/** The Page must be promotable, the Instagram account connected, the pixel the account's own. */
export async function checkIdentity(m: MetaAdsClient, a: { page_id?: string; instagram_account_id?: string; pixel_id?: string }) {
  if (a.page_id) await requirePromotablePage(m, a.page_id);
  if (a.instagram_account_id) await requireOnEdge(m, "instagram_accounts", a.instagram_account_id, "Instagram account");
  if (a.pixel_id) await requireOnEdge(m, "adspixels", a.pixel_id, "pixel");
}

/** Every image hash must be an active image of this ad account; every video id one of its videos. */
export async function checkAssets(m: MetaAdsClient, hashes: string[], videos: string[]) {
  if (hashes.length) {
    const lib = new Set((await m.list(`${m.adAccountId}/adimages`, { fields: "hash,status" }, EDGE_CAP)).filter((r) => s(r, "status") !== "DELETED").map((r) => String(r.hash)));
    const missing = [...new Set(hashes)].filter((h) => !lib.has(h));
    if (missing.length) throw new ToolError("not_found", `Image hash ${missing.join(", ")} is not in this ad account's image library. Use discover_meta_assets; uploads are not supported here.`);
  }
  if (videos.length) {
    const lib = new Set((await m.list(`${m.adAccountId}/advideos`, { fields: "id" }, EDGE_CAP)).map((r) => String(r.id)));
    const missing = [...new Set(videos)].filter((v) => !lib.has(v));
    if (missing.length) throw new ToolError("not_found", `Video ${missing.join(", ")} is not in this ad account's video library. Use discover_meta_assets; uploads are not supported here.`);
  }
}

// ------------------------------------------------------------------------------------------------------ name lookups
/** Ids of objects on an edge whose name equals `name`. Exact match unless `caseless` (used for clash checks, which are stricter). */
export async function named(m: MetaAdsClient, edge: string, name: string, caseless = false): Promise<string[]> {
  const rows = await m.list(edge, { fields: "id,name" }, EDGE_CAP);
  const want = caseless ? name.toLowerCase() : name;
  return rows.filter((r) => (caseless ? (s(r, "name") ?? "").toLowerCase() : s(r, "name")) === want).map((r) => String(r.id)).sort();
}

/** Refuses a name already used (case-insensitively) on the edge; the snapshot records that it was free. */
export async function requireFreeName(m: MetaAdsClient, edge: string, name: string, label: string): Promise<void> {
  if ((await named(m, edge, name, true)).length) throw new ToolError("invalid_argument", `A ${label} named "${name}" already exists. Names must be unique so the result can be verified; choose another name.`);
}

// --------------------------------------------------------------------------------------------------------- execution
export type Step = { key: string; label: string; post: (ids: Record<string, string>) => { path: string; params: Record<string, string> } };

/**
 * Sends the steps in order, each POST once and never retried. Every new id is recorded. If a step fails after an earlier step
 * created something, the request ends as unknown_outcome with a message that lists every id created so far (all PAUSED),
 * what is missing, and a cleanup suggestion; nothing is deleted automatically.
 */
export async function runSteps(m: MetaAdsClient, steps: Step[]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const st of steps) {
    const { path, params } = st.post(ids);
    let newId: string | null = null;
    let failure: ToolError | null = null;
    try {
      const res = await m.post<{ id?: string }>(path, params);
      newId = res?.id ? String(res.id) : null;
      if (!newId) failure = new ToolError("unknown_outcome", `Meta returned no id for the ${st.label}.`);
    } catch (e) {
      failure = e instanceof ToolError ? e : new ToolError("unknown_outcome", "Unexpected error while sending.");
    }
    if (failure) {
      const done = Object.entries(ids);
      if (!done.length) throw failure; // nothing was created before this step
      const maybe = failure.code === "unknown_outcome" || failure.code === "transient" || failure.code === "deadline_exceeded";
      const created = done.map(([k, v]) => `${steps.find((x) => x.key === k)!.label} ${v}`).join(", ");
      const missing = steps.slice(steps.indexOf(st)).map((x) => x.label).join(", ");
      throw new ToolError(
        "unknown_outcome",
        `Partly created. Created (all PAUSED, nothing spends): ${created}. The ${st.label} step failed${maybe ? " with an unknown outcome, so it may also exist" : ""}: ${failure.message} Not created: ${missing}. Nothing was deleted; to clean up, archive or delete the objects listed above with Ads Manager or later tools, or complete the missing steps.`,
      );
    }
    ids[st.key] = newId!;
  }
  return ids;
}

export type Lookup = { key: string; label: string; ids: string[] };
/** verify() verdict from name lookups: applied (each found once), not_applied (none found), else indeterminate with details. */
export function verdict(found: Lookup[]): { outcome: "applied" | "not_applied" | "indeterminate"; detail?: string } {
  const dup = found.filter((f) => f.ids.length > 1);
  if (dup.length) return { outcome: "indeterminate", detail: `ambiguous: ${dup.map((d) => `${d.ids.length} ${d.label}s with the requested name (${d.ids.join(", ")})`).join("; ")}` };
  const have = found.filter((f) => f.ids.length === 1);
  if (have.length === found.length) return { outcome: "applied" };
  if (!have.length) return { outcome: "not_applied" };
  return { outcome: "indeterminate", detail: `partial: exists ${have.map((h) => `${h.label} ${h.ids[0]}`).join(", ")}; missing ${found.filter((f) => !f.ids.length).map((f) => f.label).join(", ")}` };
}

export const ownedRow = async (m: MetaAdsClient, oid: string, fields: string[], label: string): Promise<MetaRow> => m.getOwned(oid, fields, label);
