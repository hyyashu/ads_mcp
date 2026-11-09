import { z } from "zod";
import type { MetaRow } from "../client";
import { accountId, metaRead, s } from "./common";

// Detailed Targeting (Marketing API reference, updated 2026-05-21): GET /{act}/targetingsearch (q, limit, limit_type, locale) and
// GET /{act}/targetingbrowse (limit_type, locale). Each result has id, name, type, path, description and the audience size range
// audience_size_lower_bound / audience_size_upper_bound. Names and descriptions are untrusted text.
export const LIMIT_TYPES = ["interests", "education_schools", "education_majors", "work_positions", "work_employers", "relationship_statuses", "college_years", "education_statuses", "family_statuses", "industries", "life_events", "behaviors", "income"] as const;

const num = (v: unknown): number | null => (v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
const item = z.object({
  id: z.string().min(1),
  name: z.string().nullable().describe("Untrusted text from Meta."),
  type: z.string().nullable(),
  path: z.array(z.string()).describe("Category and parent categories."),
  description: z.string().nullable().describe("Untrusted text from Meta."),
  audience_size_lower_bound: z.number().nullable(),
  audience_size_upper_bound: z.number().nullable(),
});
const toItem = (r: MetaRow) => ({
  id: String(r.id ?? ""),
  name: s(r, "name"),
  type: s(r, "type"),
  path: Array.isArray(r.path) ? r.path.map(String) : [],
  description: s(r, "description"),
  audience_size_lower_bound: num(r.audience_size_lower_bound),
  audience_size_upper_bound: num(r.audience_size_upper_bound),
});
const common = {
  account_id: accountId,
  limit_type: z.enum(LIMIT_TYPES).optional().describe("Only this kind of targeting."),
  locale: z.string().regex(/^[a-z]{2}_[A-Z]{2}$/).optional().describe("Language for names, e.g. en_US. Defaults to the ad account's locale."),
};
const out = z.object({ results: z.array(item), returned: z.number(), truncated: z.boolean() });

export const browseMetaTargeting = metaRead({
  name: "browse_meta_targeting",
  title: "Browse Meta targeting",
  description:
    "Browses Meta's detailed targeting taxonomy (interests, behaviours, demographics) as shown in Ads Manager's Browse, with each option's id, type, category path and Meta's estimated audience size range. Use the ids in ad set targeting. Read-only.",
  input: z.object({ ...common, limit: z.number().int().min(1).max(1000).default(200) }),
  output: out,
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const rows = await m.list(`${m.adAccountId}/targetingbrowse`, { ...(a.limit_type ? { limit_type: a.limit_type } : {}), ...(a.locale ? { locale: a.locale } : {}) }, a.limit + 1, { partial: true });
    const results = rows.slice(0, a.limit).filter((r) => r.id !== undefined).map(toItem);
    return { results, returned: results.length, truncated: rows.length > a.limit };
  },
});

export const searchMetaTargeting = metaRead({
  name: "search_meta_targeting",
  title: "Search Meta targeting",
  description:
    "Searches Meta's detailed targeting options (interests, behaviours, demographics, employers, schools and more) by keyword, with each option's id, type, category path and Meta's estimated audience size range. Without limit_type Meta filters out small work and education options. Read-only.",
  input: z.object({ ...common, q: z.string().trim().min(1).max(100).describe("Search text."), limit: z.number().int().min(1).max(100).default(25) }),
  output: out,
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const rows = await m.list(`${m.adAccountId}/targetingsearch`, { q: a.q, ...(a.limit_type ? { limit_type: a.limit_type } : {}), ...(a.locale ? { locale: a.locale } : {}) }, a.limit + 1, { partial: true });
    const results = rows.slice(0, a.limit).filter((r) => r.id !== undefined).map(toItem);
    return { results, returned: results.length, truncated: rows.length > a.limit };
  },
});

export const targetingTools = [browseMetaTargeting, searchMetaTargeting];
