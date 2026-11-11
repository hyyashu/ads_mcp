import { type BingClient, asList, bingDate, bool, num } from "../client";

/**
 * URL normalization parameters ("Ignore URL Parameters" in the portal). Facts: docs/VERIFICATION.md, "Blocking, URL parameters
 * and country targeting (2026-11-10)".
 *
 * - GetQueryParameters(siteUrl) GET → QueryParameter[] {Date, IsEnabled, Parameter, Source (int, meaning not documented)}.
 * - AddQueryParameter(siteUrl, queryParameter) POST, EnableDisableQueryParameter(siteUrl, queryParameter, isEnabled) POST,
 *   RemoveQueryParameter(siteUrl, queryParameter) POST; all answer {"d": null}. Remarks (Add and EnableDisable): "queryParameter
 *   may contain only unreserved letters and colon symbol (:). The site can has only limited number of url normalization
 *   marameters." The limit is not given.
 */
export interface QueryParameter {
  parameter: string;
  isEnabled: boolean | null;
  /** Bing's Source number, reported as is: Microsoft does not say what the values mean. */
  source: number | null;
  date: string | null;
}

export function parseQueryParameters(d: unknown): QueryParameter[] {
  return asList(d, "the URL parameter list")
    .filter((r) => typeof r.Parameter === "string" && r.Parameter !== "")
    .map((r) => ({ parameter: r.Parameter as string, isEnabled: bool(r.IsEnabled), source: num(r.Source), date: bingDate(r.Date) }));
}

/** GetQueryParameters: the site's URL normalization parameters. */
export async function getQueryParameters(bing: BingClient): Promise<QueryParameter[]> {
  return parseQueryParameters(await bing.read("GetQueryParameters"));
}

export async function addQueryParameter(bing: BingClient, queryParameter: string): Promise<void> {
  await bing.send("AddQueryParameter", { queryParameter });
}

export async function enableDisableQueryParameter(bing: BingClient, queryParameter: string, isEnabled: boolean): Promise<void> {
  await bing.send("EnableDisableQueryParameter", { queryParameter, isEnabled });
}

export async function removeQueryParameter(bing: BingClient, queryParameter: string): Promise<void> {
  await bing.send("RemoveQueryParameter", { queryParameter });
}
