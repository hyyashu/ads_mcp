import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change } from "../../../policy/change-set";
import { canonicalJson } from "../../../security/canonical";
import { STANDARD_LIMITS, idOf, isStandard, sortedUnique } from "../admin";
import { eventCountsLast28Days } from "../queries";
import { eventName } from "../report";
import type { Audience, AudienceCreate, AudienceFilterClause } from "../types";
import { accountId, ga4Write } from "./common";

/**
 * create_ga4_audience: Admin API v1alpha properties.audiences.create (alpha: Google may change it; scope analytics.edit).
 * Reduced, honest input (approved decision 6): event-based audiences only. Shapes from the v1alpha Audience reference
 * (2026-11-10): filterClauses are ANDed; a simpleFilter's filterExpression must be an andGroup of orGroups, and an orGroup
 * holds no groups; eventFilter{eventName}; membershipDurationDays ≤ 540; exclusionDurationMode EXCLUDE_TEMPORARILY /
 * EXCLUDE_PERMANENTLY. No sequences, dimension filters, event-count thresholds or event triggers in this version.
 */
const ALPHA = "Google's alpha API";

const orGroup = (events: string[]) => ({ orGroup: { expressions: events.map((e) => ({ eventFilter: { eventName: e } })) } });

export function audienceBody(a: { display_name: string; description: string; membership_duration_days: number; include_events: string[]; include_logic: "any" | "all"; exclude_events: string[]; exclusion: "temporarily" | "permanently" }): AudienceCreate {
  const clause = (clauseType: "INCLUDE" | "EXCLUDE", groups: { orGroup: { expressions: { eventFilter: { eventName: string } }[] } }[]): AudienceFilterClause => ({
    clauseType,
    simpleFilter: { scope: "AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS", filterExpression: { andGroup: { expressions: groups } } },
  });
  const include = clause("INCLUDE", a.include_logic === "any" ? [orGroup(a.include_events)] : a.include_events.map((e) => orGroup([e])));
  const body: AudienceCreate = { displayName: a.display_name, description: a.description, membershipDurationDays: a.membership_duration_days, filterClauses: [include] };
  if (a.exclude_events.length) {
    body.filterClauses.push(clause("EXCLUDE", [orGroup(a.exclude_events)]));
    body.exclusionDurationMode = a.exclusion === "permanently" ? "EXCLUDE_PERMANENTLY" : "EXCLUDE_TEMPORARILY";
  }
  return body;
}

const namesOf = (list: Audience[]) => sortedUnique(list.map((x) => (x.displayName ?? "").toLowerCase()));
/** "a", "a and b", "a, b and c" (or with "or"). */
const joinWith = (xs: string[], word: "and" | "or") => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ${word} ${xs.at(-1)}`);
const quoteList = (xs: string[]) => joinWith(xs, "and");

export const createGa4Audience = ga4Write({
  name: "create_ga4_audience",
  title: "Create a GA4 audience (alpha API)",
  risk: "write",
  description: `Creates an event-based audience on the property through ${ALPHA} (v1alpha, may change): users who triggered any (or all) of up to 5 events across all sessions, optionally excluding users who triggered any of up to 5 other events (temporarily or permanently), kept for 1-540 days. Typical use: remarketing to people who did X but not Y. Goes through approval. The definition and membership duration cannot be changed after creation. The approval names included or excluded events that were not recorded in the last 28 days. Refused if the name is taken or a Standard property has 100 audiences.`,
  input: z
    .object({
      account_id: accountId,
      display_name: z.string().trim().min(1).max(100),
      description: z.string().trim().min(1).max(500).describe("Required by Google."),
      membership_duration_days: z.number().int().min(1).max(540),
      include_events: z.array(eventName).min(1).max(5),
      include_logic: z.enum(["any", "all"]).default("any").describe("any: users who triggered at least one of include_events; all: every one of them."),
      exclude_events: z.array(eventName).max(5).default([]),
      exclusion: z.enum(["temporarily", "permanently"]).default("temporarily").describe("temporarily: excluded while they meet the exclusion; permanently: once excluded, never included again."),
    })
    .refine((v) => !v.include_events.some((e) => v.exclude_events.includes(e)), { message: "an event cannot be both included and excluded" }),
  output: z.object({ api_version: z.literal("v1alpha"), audience_id: z.string(), display_name: z.string(), membership_duration_days: z.number().int().nullable() }),
  plan: async (a, ctx) => {
    const ga4 = ctx.services.ga4;
    const list = await ga4.listAudiences();
    if (list.some((x) => (x.displayName ?? "").toLowerCase() === a.display_name.toLowerCase())) throw new ToolError("invalid_argument", `An audience named "${a.display_name}" already exists.`);
    const prop = await ga4.getProperty();
    if (isStandard(prop) && list.length >= STANDARD_LIMITS.audiences) throw new ToolError("invalid_argument", `This Standard property already has ${list.length} audiences (the limit is ${STANDARD_LIMITS.audiences}).`);
    const all = sortedUnique([...a.include_events, ...a.exclude_events]);
    const { counts } = await eventCountsLast28Days(ga4, all);
    const unseen = all.filter((e) => (counts.get(e)?.event_count ?? 0) === 0);
    const who = a.include_logic === "any" || a.include_events.length === 1 ? joinWith(a.include_events, "or") : `all of ${quoteList(a.include_events)}`;
    const summary =
      `Create audience "${a.display_name}" (${ALPHA}): users who triggered ${who} across all sessions` +
      (a.exclude_events.length ? `, excluding users who triggered ${joinWith(a.exclude_events, "or")} (${a.exclusion})` : "") +
      `, membership ${a.membership_duration_days} days. The definition and duration cannot be changed after creation.` +
      (unseen.length ? ` ${quoteList(unseen)} ${unseen.length === 1 ? "was" : "were"} not recorded in the last 28 days.` : "");
    const changes: Change[] = [{ resource: "audience", id: a.display_name.toLowerCase(), name: a.display_name, field: "audience", before: null, after: a.display_name, unit: "text", effect: "neutral" }];
    return { summary, snapshot: { names: namesOf(list) }, changes };
  },
  execute: async (a, ctx, run) => {
    const ga4 = ctx.services.ga4;
    if (canonicalJson({ names: namesOf(await ga4.listAudiences()) }) !== canonicalJson(run.snapshot)) throw new ToolError("conflict", "The property's audiences changed since this was requested. Nothing was changed; request it again.");
    const sent = await ga4.createAudience(audienceBody(a));
    const made = (await ga4.listAudiences()).find((x) => (sent.name ? x.name === sent.name : (x.displayName ?? "").toLowerCase() === a.display_name.toLowerCase()));
    if (!made) throw new ToolError("unknown_outcome", "Google accepted the request but the audience does not read back.");
    return { api_version: "v1alpha" as const, audience_id: idOf(made.name), display_name: made.displayName ?? a.display_name, membership_duration_days: made.membershipDurationDays ?? null };
  },
  verify: async (a, ctx, run) => {
    const list = await ctx.services.ga4.listAudiences();
    if (list.some((x) => (x.displayName ?? "").toLowerCase() === a.display_name.toLowerCase())) return { outcome: "applied" };
    return canonicalJson({ names: namesOf(list) }) === canonicalJson(run.snapshot) ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: "the audiences changed, but the requested one is not there" };
  },
});
