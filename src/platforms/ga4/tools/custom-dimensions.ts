import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change } from "../../../policy/change-set";
import { canonicalJson } from "../../../security/canonical";
import { STANDARD_LIMITS, customDimensionKey, idOf, isStandard, reportNameOf, sortedUnique } from "../admin";
import type { CustomDimension } from "../types";
import { accountId, ga4Write } from "./common";

/**
 * create_custom_dimension: Admin API v1beta properties.customDimensions.create (scope analytics.edit). Field rules from the
 * CustomDimension reference (2026-11-10): parameterName required and immutable, at most 24 characters for user scope and
 * 40 for event scope, letters/digits/underscore starting with a letter; displayName at most 82, letters/digits/space/
 * underscore starting with a letter; description at most 150; scope EVENT/USER/ITEM immutable; disallowAdsPersonalization
 * only for user scope. Uniqueness of display names is not stated by Google: refused here anyway (read-back needs a key).
 */
const SCOPE_WORD = { EVENT: "event-scoped", USER: "user-scoped", ITEM: "item-scoped" } as const;

const snapshotOf = (list: CustomDimension[]) => ({
  keys: sortedUnique(list.map((d) => customDimensionKey(d.scope, d.parameterName))),
  names: sortedUnique(list.map((d) => (d.displayName ?? "").toLowerCase())),
});

export const createCustomDimension = ga4Write({
  name: "create_custom_dimension",
  title: "Create a GA4 custom dimension",
  risk: "write",
  description:
    "Creates an event-, user- or item-scoped custom dimension from an event parameter or user property, so it can be used in reports (the result gives its report name, e.g. customEvent:plan_type, for run_ga4_report). Goes through approval. The parameter name and scope cannot be changed later, and a custom dimension can only be archived, not deleted. Refused if the parameter or display name is already used, or a Standard property is at its limit (50 event-scoped, 25 user-scoped).",
  input: z
    .object({
      account_id: accountId,
      parameter_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "letters, digits and underscores, starting with a letter").max(40).describe("The event parameter (event/item scope) or user property (user scope). Max 24 characters for USER, 40 for EVENT."),
      display_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_ ]*$/, "letters, digits, spaces and underscores, starting with a letter").max(82),
      scope: z.enum(["EVENT", "USER", "ITEM"]),
      description: z.string().max(150).optional(),
      disallow_ads_personalization: z.boolean().optional().describe("User scope only: exclude this dimension from ads personalization."),
    })
    .refine((v) => v.scope !== "USER" || v.parameter_name.length <= 24, { message: "user-scoped parameter names are at most 24 characters" })
    .refine((v) => v.disallow_ads_personalization === undefined || v.scope === "USER", { message: "disallow_ads_personalization applies to user-scoped dimensions only" }),
  output: z.object({ custom_dimension_id: z.string(), parameter_name: z.string(), display_name: z.string(), scope: z.string(), report_name: z.string().nullable().describe("Use this name in run_ga4_report.") }),
  plan: async (a, ctx) => {
    const ga4 = ctx.services.ga4;
    const list = await ga4.listCustomDimensions();
    const key = customDimensionKey(a.scope, a.parameter_name);
    const same = list.find((d) => customDimensionKey(d.scope, d.parameterName) === key);
    if (same) throw new ToolError("invalid_argument", `A ${SCOPE_WORD[a.scope]} custom dimension for parameter "${a.parameter_name}" already exists ("${same.displayName ?? ""}").`);
    if (list.some((d) => (d.displayName ?? "").toLowerCase() === a.display_name.toLowerCase())) throw new ToolError("invalid_argument", `A custom dimension named "${a.display_name}" already exists.`);
    const prop = await ga4.getProperty();
    const inScope = list.filter((d) => d.scope === a.scope).length;
    const limit = a.scope === "EVENT" ? STANDARD_LIMITS.eventDims : a.scope === "USER" ? STANDARD_LIMITS.userDims : null;
    const standard = isStandard(prop);
    if (standard && limit !== null && inScope >= limit) throw new ToolError("invalid_argument", `This Standard property already has ${inScope} ${SCOPE_WORD[a.scope]} custom dimensions (the limit is ${limit}).`);
    const usage = standard && limit !== null ? ` Uses ${inScope + 1} of ${limit} ${SCOPE_WORD[a.scope]} dimensions.` : "";
    const summary = `Create ${SCOPE_WORD[a.scope]} custom dimension "${a.display_name}" from ${a.scope === "USER" ? "user property" : "parameter"} "${a.parameter_name}". Its parameter name and scope cannot be changed later, and it can only be archived, not deleted.${usage}`;
    const changes: Change[] = [{ resource: "custom_dimension", id: key, name: a.display_name, field: "custom_dimension", before: null, after: a.display_name, unit: "text", effect: "neutral" }];
    return { summary, snapshot: snapshotOf(list), changes };
  },
  execute: async (a, ctx, run) => {
    const ga4 = ctx.services.ga4;
    if (canonicalJson(snapshotOf(await ga4.listCustomDimensions())) !== canonicalJson(run.snapshot)) throw new ToolError("conflict", "The property's custom dimensions changed since this was requested. Nothing was changed; request it again.");
    const sent = await ga4.createCustomDimension({
      parameterName: a.parameter_name,
      displayName: a.display_name,
      scope: a.scope,
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.disallow_ads_personalization !== undefined ? { disallowAdsPersonalization: a.disallow_ads_personalization } : {}),
    });
    const key = customDimensionKey(a.scope, a.parameter_name);
    const made = (await ga4.listCustomDimensions()).find((d) => (sent.name && d.name === sent.name) || customDimensionKey(d.scope, d.parameterName) === key);
    if (!made || customDimensionKey(made.scope, made.parameterName) !== key) throw new ToolError("unknown_outcome", "Google accepted the request but the custom dimension does not read back as requested.");
    return { custom_dimension_id: idOf(made.name), parameter_name: a.parameter_name, display_name: made.displayName ?? a.display_name, scope: a.scope, report_name: reportNameOf(made) };
  },
  verify: async (a, ctx, run) => {
    const list = await ctx.services.ga4.listCustomDimensions();
    if (list.some((d) => customDimensionKey(d.scope, d.parameterName) === customDimensionKey(a.scope, a.parameter_name))) return { outcome: "applied" };
    return canonicalJson(snapshotOf(list)) === canonicalJson(run.snapshot) ? { outcome: "not_applied" } : { outcome: "indeterminate", detail: "the custom dimensions changed, but the requested one is not there" };
  },
});
