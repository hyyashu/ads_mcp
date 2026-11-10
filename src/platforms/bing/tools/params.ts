import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { AnyTool } from "../../../mcp/tool";
import type { Change } from "../../../policy/change-set";
import { type QueryParameter, addQueryParameter, enableDisableQueryParameter, getQueryParameters, removeQueryParameter } from "../api/params";
import { accountId, bingRead, bingWrite, page, readBack } from "./common";

// Facts: docs/VERIFICATION.md, "Blocking, URL parameters and country targeting (2026-11-10)". What ignoring a parameter does
// comes from Microsoft's help page "Ignore URL Parameters"; what IsEnabled=false does is not documented anywhere.

/**
 * "queryParameter may contain only unreserved letters and colon symbol (:)": read as RFC 3986 unreserved characters
 * (letters, digits, - . _ ~) plus ':'. The 128-character cap is this server's bound; Bing documents none.
 */
const parameterName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9\-._~:]+$/, "only letters, digits, - . _ ~ and : (Bing: 'only unreserved letters and colon symbol')")
  .describe("The URL parameter name without '?', '=' or a value, e.g. sessionid or utm_source.");

const ParamSchema = z.object({
  parameter: z.string().describe("The parameter name (untrusted text from Bing)."),
  enabled: z.boolean().nullable().describe("Bing's IsEnabled flag. Microsoft does not document what a disabled entry does."),
  source: z.number().nullable().describe("Bing's Source number, as reported; Microsoft does not say what the values mean."),
  added_at: z.string().nullable().describe("Bing's Date for the entry (ISO instant)."),
});
const paramOut = (p: QueryParameter): z.infer<typeof ParamSchema> => ({ parameter: p.parameter, enabled: p.isEnabled, source: p.source, added_at: p.date });
const find = (all: QueryParameter[], name: string) => all.find((p) => p.parameter === name);

const WHAT_IT_DOES =
  "Per Microsoft's help, Bing drops an ignored parameter from the site's URLs and treats URLs that differ only in it as one page, consolidating their ranking signals into the URL without it. Bing treats this as a very strong hint and changes take time.";

// ---------------------------------------------------------------------------------------- list_bing_url_parameters
export const listBingUrlParameters = bingRead({
  name: "list_bing_url_parameters",
  title: "List Bing ignored URL parameters",
  description:
    "Lists the URL parameters a Bing Webmaster site asked Bing to ignore (URL normalization, 'Ignore URL Parameters' in the portal): the parameter name, whether it is enabled, Bing's source number and date. For an ignored parameter, Bing treats URLs that differ only in that parameter as one page.",
  input: z.object({ account_id: accountId, limit: z.number().int().min(1).max(1000).default(200).describe("Most entries to return (sorted by name).") }),
  output: z.object({ site_url: z.string(), parameters: z.array(ParamSchema), returned: z.number(), total: z.number(), truncated: z.boolean(), note: z.string() }),
  handler: async (a, ctx) => {
    const all = (await getQueryParameters(ctx.services.bing)).sort((x, y) => x.parameter.localeCompare(y.parameter));
    const p = page(all, a.limit);
    return { site_url: ctx.services.bing.siteUrl, parameters: p.rows.map(paramOut), returned: p.returned, total: p.total, truncated: p.truncated, note: WHAT_IT_DOES };
  },
});

// ------------------------------------------------------------------------------------------ add_bing_url_parameter
export const addBingUrlParameter = bingWrite({
  name: "add_bing_url_parameter",
  title: "Make Bing ignore a URL parameter",
  risk: "high_impact",
  description:
    "After approval by a person, tells Bing to ignore a URL parameter on a Bing Webmaster site: Bing then treats URLs that differ only in this parameter as one page. Only for parameters that do not change the page content (session IDs, tracking codes); ignoring one that selects content (e.g. an article ID) can make Bing drop real pages from its index. Refuses a parameter already in the list. Bing limits how many parameters a site can have (the number is not documented).",
  input: z.object({ account_id: accountId, parameter: parameterName }),
  output: z.object({ site_url: z.string(), parameter: ParamSchema }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    const all = await getQueryParameters(bing);
    const same = find(all, a.parameter);
    if (same) throw new ToolError("invalid_argument", `${a.parameter} is already in Bing's URL parameter list for ${bing.siteUrl} (${same.isEnabled === false ? "disabled" : "enabled"}). Nothing to add; use update_bing_url_parameter to enable or disable it.`, { definite: true });
    const caseTwin = all.find((p) => p.parameter.toLowerCase() === a.parameter.toLowerCase());
    const summary = [
      `Make Bing ignore the URL parameter "${a.parameter}" on ${bing.siteUrl}: URLs that differ only in ${a.parameter} will be treated as one page (e.g. ${bing.siteUrl.replace(/\/?$/, "/")}page?${a.parameter}=1 and ${bing.siteUrl.replace(/\/?$/, "/")}page?${a.parameter}=2 become one).`,
      WHAT_IT_DOES,
      `If ${a.parameter} changes what the page shows, Bing can drop real pages from its index.`,
      caseTwin ? `The list already has "${caseTwin.parameter}", which differs only in letter case.` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const changes: Change[] = [{ resource: "bing_url_parameter", id: a.parameter, name: null, field: "ignored_by_bing", before: null, after: "added", unit: "text", effect: "create" }];
    return { summary, changes, snapshot: { site_url: bing.siteUrl, parameter: a.parameter, present: false } };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    await addQueryParameter(bing, a.parameter);
    const got = find(await readBack(() => getQueryParameters(bing)), a.parameter);
    if (!got) throw new ToolError("unknown_outcome", "Bing accepted the request but the parameter is not in the list. Check list_bing_url_parameters before trying again.");
    return { site_url: bing.siteUrl, parameter: paramOut(got) };
  },
  verify: async (a, ctx) => (find(await getQueryParameters(ctx.services.bing), a.parameter) ? { outcome: "applied" } : { outcome: "not_applied" }),
});

// --------------------------------------------------------------------------------------- update_bing_url_parameter
export const updateBingUrlParameter = bingWrite({
  name: "update_bing_url_parameter",
  title: "Enable or disable a Bing URL parameter",
  risk: "high_impact",
  description:
    "After approval by a person, sets Bing's enabled flag of a parameter already in the site's ignored URL parameter list (EnableDisableQueryParameter). Microsoft does not document what a disabled entry does; read by the flag's name, enabled means Bing applies the rule (treats URLs differing only in the parameter as one page) and disabled means it keeps the entry without applying it. Refuses a parameter that is not listed or already in the requested state.",
  input: z.object({ account_id: accountId, parameter: parameterName, enabled: z.boolean().describe("true to enable the entry, false to disable it.") }),
  output: z.object({ site_url: z.string(), parameter: ParamSchema }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    const p = find(await getQueryParameters(bing), a.parameter);
    if (!p) throw new ToolError("not_found", `${a.parameter} is not in Bing's URL parameter list for ${bing.siteUrl}. Use list_bing_url_parameters for the exact names, or add_bing_url_parameter to add it.`, { definite: true });
    if (p.isEnabled === a.enabled) throw new ToolError("invalid_argument", `${a.parameter} is already ${a.enabled ? "enabled" : "disabled"}. Nothing to change.`, { definite: true });
    const summary = a.enabled
      ? `Enable the ignored URL parameter "${a.parameter}" on ${bing.siteUrl}. Read by the flag's name (Microsoft does not document it), Bing then treats URLs that differ only in ${a.parameter} as one page. ${WHAT_IT_DOES}`
      : `Disable the ignored URL parameter "${a.parameter}" on ${bing.siteUrl}. Microsoft does not document what a disabled entry does; read by the flag's name, Bing stops treating URLs that differ only in ${a.parameter} as one page, so they may be crawled and indexed as separate pages again.`;
    const changes: Change[] = [{ resource: "bing_url_parameter", id: a.parameter, name: null, field: "enabled", before: p.isEnabled === null ? null : String(p.isEnabled), after: String(a.enabled), unit: "status", effect: "create" }];
    return { summary, changes, snapshot: { site_url: bing.siteUrl, parameter: a.parameter, enabled: p.isEnabled } };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    await enableDisableQueryParameter(bing, a.parameter, a.enabled);
    const got = find(await readBack(() => getQueryParameters(bing)), a.parameter);
    if (!got || got.isEnabled !== a.enabled) throw new ToolError("unknown_outcome", "Bing accepted the request but the parameter does not read back in the requested state. Check list_bing_url_parameters before trying again.");
    return { site_url: bing.siteUrl, parameter: paramOut(got) };
  },
  verify: async (a, ctx) => {
    const got = find(await getQueryParameters(ctx.services.bing), a.parameter);
    if (!got) return { outcome: "indeterminate", detail: "the parameter is no longer in the list" };
    return got.isEnabled === a.enabled ? { outcome: "applied" } : { outcome: "not_applied" };
  },
});

// --------------------------------------------------------------------------------------- remove_bing_url_parameter
export const removeBingUrlParameter = bingWrite({
  name: "remove_bing_url_parameter",
  title: "Stop Bing ignoring a URL parameter",
  risk: "destructive",
  description:
    "After approval by a person, removes a parameter from a Bing Webmaster site's ignored URL parameter list. Bing then no longer treats URLs that differ only in it as one page, so they may be crawled and indexed as separate (duplicate) pages again. The parameter must be in the list.",
  input: z.object({ account_id: accountId, parameter: parameterName }),
  output: z.object({ site_url: z.string(), parameter: z.string(), removed: z.literal(true) }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    const p = find(await getQueryParameters(bing), a.parameter);
    if (!p) throw new ToolError("not_found", `${a.parameter} is not in Bing's URL parameter list for ${bing.siteUrl}. Use list_bing_url_parameters for the exact names.`, { definite: true });
    const changes: Change[] = [{ resource: "bing_url_parameter", id: a.parameter, name: null, field: "ignored_by_bing", before: p.isEnabled === false ? "listed (disabled)" : "listed (enabled)", after: null, unit: "text", effect: "remove" }];
    return {
      summary: `Remove "${a.parameter}" from Bing's ignored URL parameters for ${bing.siteUrl}. Bing will no longer treat URLs that differ only in ${a.parameter} as one page: they may be crawled and indexed as separate, duplicate pages again. Changes take time to show.`,
      changes,
      snapshot: { site_url: bing.siteUrl, parameter: a.parameter, enabled: p.isEnabled },
    };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    await removeQueryParameter(bing, a.parameter);
    if (find(await readBack(() => getQueryParameters(bing)), a.parameter)) throw new ToolError("unknown_outcome", "Bing accepted the request but the parameter is still listed. Check list_bing_url_parameters before trying again.");
    return { site_url: bing.siteUrl, parameter: a.parameter, removed: true as const };
  },
  verify: async (a, ctx) => (find(await getQueryParameters(ctx.services.bing), a.parameter) ? { outcome: "not_applied" } : { outcome: "applied" }),
});

export const paramTools: AnyTool[] = [listBingUrlParameters, addBingUrlParameter, updateBingUrlParameter, removeBingUrlParameter];
