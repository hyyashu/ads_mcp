import { wcfDay } from "./fake-bing";

/** Bing JSON rows shaped like Microsoft's samples ("__type", PascalCase, WCF dates). */
export const qs = (query: string, day: string, clicks: number, impressions: number, avgImpressionPosition = 5, avgClickPosition = 4) => ({
  __type: "QueryStats:#Microsoft.Bing.Webmaster.Api",
  AvgClickPosition: avgClickPosition,
  AvgImpressionPosition: avgImpressionPosition,
  Clicks: clicks,
  Date: wcfDay(day),
  Impressions: impressions,
  Query: query,
});
export const rt = (day: string, clicks: number, impressions: number) => ({ __type: "RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api", Clicks: clicks, Date: wcfDay(day), Impressions: impressions });
export const dq = (day: string, clicks: number, impressions: number, position: number) => ({ __type: "DetailedQueryStats:#Microsoft.Bing.Webmaster.Api", Clicks: clicks, Date: wcfDay(day), Impressions: impressions, Position: position });
export const kw = (query: string, impressions: number, broad: number) => ({ __type: "Keyword:#Microsoft.Bing.Webmaster.Api", BroadImpressions: broad, Impressions: impressions, Query: query });
export const ks = (query: string, day: string, impressions: number, broad: number) => ({ __type: "KeywordStats:#Microsoft.Bing.Webmaster.Api", BroadImpressions: broad, Date: wcfDay(day), Impressions: impressions, Query: query });

/** Eight weekly bucket dates, oldest first. */
export const WEEKS = ["2026-09-13", "2026-09-20", "2026-09-27", "2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25", "2026-11-01"] as const;

/** Consecutive days from `start` (YYYY-MM-DD). */
export const days = (start: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
