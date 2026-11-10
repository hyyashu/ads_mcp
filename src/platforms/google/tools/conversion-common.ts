import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { GoogleAdsClient } from "../client";
import { Gaql, isRealDate, lit, pick } from "../gaql";
import { tailId } from "./campaign-reads";
import { str } from "./common";

/**
 * Shared by the conversion upload, goal and value rule tools (conversion-ops.ts, conversion-goals.ts, conversion-value-rules.ts).
 */

/** ConversionActionCategory values of the v26 REST schema (without UNSPECIFIED / UNKNOWN). */
export const CATEGORIES = ["DEFAULT", "PAGE_VIEW", "PURCHASE", "SIGNUP", "DOWNLOAD", "ADD_TO_CART", "BEGIN_CHECKOUT", "SUBSCRIBE_PAID", "PHONE_CALL_LEAD", "IMPORTED_LEAD", "SUBMIT_LEAD_FORM", "BOOK_APPOINTMENT", "REQUEST_QUOTE", "GET_DIRECTIONS", "OUTBOUND_CLICK", "CONTACT", "ENGAGEMENT", "STORE_VISIT", "STORE_SALE", "QUALIFIED_LEAD", "CONVERTED_LEAD", "YOUTUBE_FOLLOW_ON_VIEWS", "MESSAGE_LEAD", "IN_APP_AD_REVENUE"] as const;
/** ConversionOrigin values of the v26 REST schema (without UNSPECIFIED / UNKNOWN). */
export const ORIGINS = ["WEBSITE", "GOOGLE_HOSTED", "APP", "CALL_FROM_ADS", "STORE", "YOUTUBE_HOSTED", "LOCAL_SERVICES_ADS"] as const;

/**
 * Google's date-time format for conversions: "yyyy-mm-dd hh:mm:ss+|-hh:mm", for example "2019-01-01 12:32:45-08:00"
 * (ClickConversion.conversion_date_time and the other date-time fields in the v26 reference). The offset is required.
 */
const DATE_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2})$/;
export function parseDateTime(v: string): number | null {
  const m = DATE_TIME.exec(v);
  if (!m || !isRealDate(m[1]!)) return null;
  const [h, mi, s, oh, om] = [m[2], m[3], m[4], m[6], m[7]].map(Number) as [number, number, number, number, number];
  if (h > 23 || mi > 59 || s > 59 || oh > 14 || om > 59) return null;
  const local = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return local - (m[5] === "+" ? 1 : -1) * (oh * 60 + om) * 60_000;
}
export const dateTime = z
  .string()
  .refine((v) => parseDateTime(v) !== null, 'expected "yyyy-mm-dd hh:mm:ss+|-hh:mm" with a real date, time and time zone offset, e.g. "2026-06-01 14:30:00-04:00"');

/** ISO 4217 three-letter currency code. */
export const currencyCode = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code such as USD");

/**
 * The account that manages conversions for this account (customer.conversion_tracking_setting.google_ads_conversion_customer),
 * as a numeric id, or null when Google reports none.
 */
export async function conversionCustomer(ads: GoogleAdsClient): Promise<string | null> {
  const [r] = await ads.query(new Gaql().select("customer.id", "customer.conversion_tracking_setting.google_ads_conversion_customer").from("customer").limit(1), { maxRows: 1 });
  return r ? tailId(pick(r, "customer.conversion_tracking_setting.google_ads_conversion_customer")) : null;
}

/**
 * Uploads, adjustments and account-level goals must be sent to the account's Google Ads conversion customer. When conversions are
 * managed by another account (cross-account conversion tracking), this connected account cannot do it.
 */
export function requireOwnConversionCustomer(ads: GoogleAdsClient, cc: string | null, what: string): void {
  if (cc && cc !== ads.customerId) {
    throw new ToolError("invalid_argument", `Conversions for this account are managed by account ${cc} (cross-account conversion tracking). Google accepts ${what} only in that account: connect account ${cc} and run this there. Nothing was changed.`);
  }
}

export interface ConversionAction {
  id: string;
  name: string | null;
  status: string | null;
  type: string | null;
  category: string | null;
  owner_customer_id: string | null;
}

/** One conversion action by id, or not_found. */
export async function readConversionAction(ads: GoogleAdsClient, id: string): Promise<ConversionAction> {
  const [r] = await ads.query(
    new Gaql().select("conversion_action.id", "conversion_action.name", "conversion_action.status", "conversion_action.type", "conversion_action.category", "conversion_action.owner_customer").from("conversion_action").where(`conversion_action.id = ${lit.id(id)}`).limit(1),
    { maxRows: 1 },
  );
  if (!r) throw new ToolError("not_found", `No conversion action ${id} in this account. Use list_conversion_actions to find it.`);
  return { id, name: str(r, "conversion_action.name"), status: str(r, "conversion_action.status"), type: str(r, "conversion_action.type"), category: str(r, "conversion_action.category"), owner_customer_id: tailId(pick(r, "conversion_action.owner_customer")) };
}
