import { z } from "zod";
import type { ReadTool } from "../../../mcp/tool";
import { DURING, lit } from "../gaql";
import type { GoogleServices } from "../services";

export const ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

export const accountId = z.string().min(1).describe("Connected Google Ads account id, as listed in your connections.");
export const campaignIds = z.array(z.string().regex(/^\d{1,20}$/, "numeric campaign id")).max(50).describe("Limit to these campaign ids (up to 50).");

/** Either a named period (evaluated in the account's own time zone by Google) or an explicit start/end date. */
export const dateFields = {
  date_range: z.enum(DURING).default("LAST_30_DAYS").describe("Named period, evaluated in the account's time zone."),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Explicit start date (YYYY-MM-DD). Use with end_date; overrides date_range."),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Explicit end date (YYYY-MM-DD)."),
};
export const datesOk = (v: { start_date?: string; end_date?: string }) => (v.start_date === undefined) === (v.end_date === undefined);
export const datesMsg = { message: "start_date and end_date must be given together" };

export function dateClause(v: { date_range: string; start_date?: string; end_date?: string }): string {
  if (v.start_date && v.end_date) {
    if (v.start_date > v.end_date) throw new Error("start_date must not be after end_date");
    return `segments.date BETWEEN ${lit.date(v.start_date)} AND ${lit.date(v.end_date)}`;
  }
  return `segments.date DURING ${lit.enumOf(v.date_range, DURING)}`;
}

export const nullable = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** Division that returns null instead of NaN/Infinity, so a metric is never reported as a number it is not. */
export const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
export const round = (n: number | null, digits = 4): number | null => (n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits);

type ReadDef<I extends z.ZodObject, O extends z.ZodType> = Omit<ReadTool<I, O, GoogleServices>, "kind" | "platform" | "permissions"> & { permissions?: Partial<ReadTool["permissions"]> };

/** Declares a Google Ads read tool with the standard scope and platform permission documentation. */
export function googleRead<I extends z.ZodObject, O extends z.ZodType>(def: ReadDef<I, O>): ReadTool<I, O, GoogleServices> {
  return {
    ...def,
    kind: "read",
    platform: "google_ads",
    permissions: {
      scope: "ads:read",
      platformPermissions: [ADS_SCOPE],
      notes: "The Google Cloud project that issued the OAuth credentials needs Google Ads API access (Explorer, Basic or Standard). Developer tokens were sunset on 2026-09-09.",
      ...def.permissions,
    },
  };
}

export const Money = z.number().describe("In the account's currency (micros converted to units).");

import type { WriteTool } from "../../../mcp/tool";

type WriteDef<I extends z.ZodObject, O extends z.ZodType> = Omit<WriteTool<I, O, GoogleServices>, "kind" | "platform" | "permissions"> & { permissions?: Partial<WriteTool["permissions"]> };

/** Declares a Google Ads write tool. Writes never run directly: the pipeline queues an approval first. */
export function googleWrite<I extends z.ZodObject, O extends z.ZodType>(def: WriteDef<I, O>): WriteTool<I, O, GoogleServices> {
  return {
    ...def,
    kind: "write",
    platform: "google_ads",
    permissions: {
      scope: "ads:write",
      platformPermissions: [ADS_SCOPE],
      notes: "Requires write access to the account for the connected Google user, and Google Ads API access on the Cloud project.",
      ...def.permissions,
    },
  };
}
