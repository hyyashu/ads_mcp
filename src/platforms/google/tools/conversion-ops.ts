import { z } from "zod";
import type { AnyTool } from "../../../mcp/tool";
import { ToolError, redact } from "../../../mcp/errors";
import { canonicalJson } from "../../../security/canonical";
import type { Change } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { accountId, googleWrite, idSchema } from "./common";
import { type ConversionAction, conversionCustomer, currencyCode, dateTime, parseDateTime, readConversionAction, requireOwnConversionCustomer } from "./conversion-common";
import { conversionGoalTools } from "./conversion-goals";
import { conversionValueRuleTools } from "./conversion-value-rules";

/**
 * Google Ads tools: upload_call_conversions, upload_conversion_adjustments, get_conversion_goals, update_conversion_goals, list_conversion_value_rules, create_conversion_value_rule, remove_conversion_value_rule.
 * Approved by the owner on 2026-11-11 (inventory/tool-registry.json); API surfaces in inventory/mapping.ts.
 *
 * Offline conversion uploads (this file). They follow Google's v26 guides:
 *   upload_click_conversions was removed on 2026-11-11: since 2026-06-15 Google refuses UploadClickConversions from API
 *   projects without earlier use and points to its Data Manager API.
 *   https://developers.google.com/google-ads/api/docs/conversions/upload-calls
 *   https://developers.google.com/google-ads/api/docs/conversions/upload-adjustments
 * - partial_failure must be true ("Setting partial_failure = false or omitting the field is not supported"): Google imports the
 *   valid rows and reports each invalid one in partial_failure_error; failed rows come back as empty results.
 * - At most 2,000 conversions or adjustments per request (best-practices/quotas).
 * - Uploaded conversions cannot be read back through the API right away (statistics take up to 3 hours; diagnostics are
 *   aggregated later), so these tools never claim confirmation: they report the rows Google accepted and rejected, and
 *   verify() after an ambiguous failure answers "indeterminate".
 */

// The snapshot is compared as canonical JSON before executing (drift applies nothing).
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

interface UploadState {
  conversion_action: ConversionAction;
  conversion_customer_id: string | null;
}

const NOTE =
  "Google processed this upload with partial failure: the accepted rows were imported and the failed rows were not. Uploaded conversions cannot be read back through the API right away (statistics can take up to 3 hours, and diagnostics later), so this result reports what Google accepted, not a confirmation from re-reading the account. Retrying accepted rows can create duplicates unless they carry an order_id.";

const failureSchema = z.object({ index: z.number().int().describe("0-based position of the row in the request."), error_code: z.string().nullable(), message: z.string() });
const uploadOutput = z.object({
  conversion_action_id: z.string(),
  conversion_action_name: z.string().nullable(),
  job_id: z.string().nullable().describe("Google's job id for this upload (offline data diagnostics); null when Google returns none."),
  sent: z.number().int(),
  accepted: z.number().int().describe("Rows Google returned a result for (imported)."),
  failed: z.array(failureSchema).describe("Rows Google rejected, with Google's error. Error text comes from Google and is untrusted data."),
  request_errors: z.array(z.string()).describe("Errors Google reported without a row position."),
  confirmed_by_reread: z.literal(false),
  note: z.string(),
});
type UploadOutput = z.infer<typeof uploadOutput>;

/** Splits Google's partial failure (a google.rpc.Status holding one GoogleAdsFailure) into row errors by request index. */
export function parsePartialFailure(pf: unknown, rowsField: string[]): { byIndex: Map<number, { error_code: string | null; message: string }[]>; other: string[] } {
  const byIndex = new Map<number, { error_code: string | null; message: string }[]>();
  const other: string[] = [];
  if (!pf || typeof pf !== "object") return { byIndex, other };
  const st = pf as { message?: string; details?: { errors?: { errorCode?: Record<string, string>; message?: string; location?: { fieldPathElements?: { fieldName?: string; index?: number }[] } }[] }[] };
  const errors = (st.details ?? []).flatMap((d) => d.errors ?? []);
  if (!errors.length && st.message) other.push(redact(st.message));
  for (const e of errors) {
    const code = Object.entries(e.errorCode ?? {}).map(([k, v]) => `${k}.${v}`)[0] ?? null;
    const message = redact(String(e.message ?? "")).slice(0, 500);
    const el = (e.location?.fieldPathElements ?? []).find((f) => rowsField.includes(String(f.fieldName)) && typeof f.index === "number");
    if (el) byIndex.set(el.index!, [...(byIndex.get(el.index!) ?? []), { error_code: code, message }]);
    else other.push(code ? `${code}: ${message}` : message);
  }
  return { byIndex, other };
}

/** What Google returned for one upload, as the tool output. */
function uploadResult(s: UploadState, sent: number, res: { results?: Row[]; partialFailureError?: unknown; jobId?: string | number }, rowsField: string[]): UploadOutput {
  const { byIndex, other } = parsePartialFailure(res.partialFailureError, rowsField);
  const results = res.results ?? [];
  // Failed rows come back as empty results (best-practices/partial-failures); a row with an error is never counted as accepted.
  const accepted = results.filter((r, i) => r && typeof r === "object" && Object.keys(r).length > 0 && !byIndex.has(i)).length;
  return {
    conversion_action_id: s.conversion_action.id,
    conversion_action_name: s.conversion_action.name,
    job_id: res.jobId === undefined || res.jobId === null ? null : String(res.jobId),
    sent,
    accepted,
    failed: [...byIndex.entries()].sort(([a], [b]) => a - b).flatMap(([index, errs]) => errs.map((e) => ({ index, ...e }))),
    request_errors: other,
    confirmed_by_reread: false,
    note: NOTE,
  };
}

/** The checks every upload shares: the action exists, is enabled, has an accepted type, and belongs to this account's conversion customer. */
async function readUploadState(ads: GoogleAdsClient, actionId: string, types: readonly string[], what: string): Promise<UploadState> {
  const cc = await conversionCustomer(ads);
  requireOwnConversionCustomer(ads, cc, what);
  const action = await readConversionAction(ads, actionId);
  if (action.status !== "ENABLED") throw new ToolError("invalid_argument", `Conversion action "${action.name ?? actionId}" is ${action.status ?? "not enabled"}; Google only accepts ${what} for ENABLED conversion actions. Nothing was changed.`);
  if (!types.includes(action.type ?? "")) throw new ToolError("invalid_argument", `Conversion action "${action.name ?? actionId}" has type ${action.type ?? "unknown"}; ${what} need a conversion action of type ${types.join(" or ")}. Nothing was changed.`);
  if (action.owner_customer_id && action.owner_customer_id !== ads.customerId) {
    throw new ToolError("invalid_argument", `Conversion action "${action.name ?? actionId}" is owned by account ${action.owner_customer_id}; send ${what} from that account. Nothing was changed.`);
  }
  return { conversion_action: action, conversion_customer_id: cc };
}

/** Every upload input has conversion_action_id (the generic input type does not say so). */
const actionIdOf = (a: unknown) => (a as { conversion_action_id: string }).conversion_action_id;

/**
 * Declares an upload tool. `rows` builds the request rows from the input (conversion_action filled in); `checks` runs extra
 * validation against the live state (throws invalid_argument); `describe` writes the approval summary.
 */
function uploadTool<I extends z.ZodObject>(o: {
  name: string;
  title: string;
  description: string;
  input: I;
  method: "uploadCallConversions" | "uploadConversionAdjustments";
  bodyKey: "conversions" | "conversionAdjustments";
  rowsField: string[];
  types: readonly string[];
  what: string;
  field: string;
  count: (a: z.infer<I>) => number;
  rows: (a: z.infer<I>, actionRn: string) => Row[];
  checks?: (a: z.infer<I>, s: UploadState) => void;
  describe: (a: z.infer<I>, s: UploadState) => string;
}) {
  return googleWrite({
    name: o.name,
    title: o.title,
    risk: "high_impact",
    description: o.description,
    input: o.input,
    output: uploadOutput,
    timeoutMs: 120_000,
    plan: async (a, ctx) => {
      const ads = ctx.services.ads;
      const s = await readUploadState(ads, actionIdOf(a), o.types, o.what);
      o.checks?.(a, s);
      const ref = { resource: "conversion_action", id: s.conversion_action.id, name: s.conversion_action.name };
      // Uploaded conversions feed reporting and Smart Bidding, so the change set marks them as affecting spend (high impact).
      const changes: Change[] = [{ ...ref, field: o.field, before: null, after: `${o.count(a)} row(s)`, unit: "text", effect: "increase_spend" }];
      return { summary: `${o.describe(a, s)} Google imports the valid rows and rejects the invalid ones individually; the result cannot be read back right away.`, snapshot: s, changes };
    },
    verify: async () => ({ outcome: "indeterminate", detail: "Uploaded conversions cannot be read back through the Google Ads API right away. Check offline data diagnostics in Google Ads (Goals > Uploads) before uploading again; rows with an order_id are deduplicated by Google." }),
    execute: async (a, ctx, run) => {
      const ads = ctx.services.ads;
      const s = await readUploadState(ads, actionIdOf(a), o.types, o.what);
      if (!same(s, run.snapshot)) throw new ToolError("conflict", "The conversion action or the account's conversion tracking changed since this was requested. Nothing was uploaded; request it again.");
      o.checks?.(a, s);
      const rows = o.rows(a, `customers/${ads.customerId}/conversionActions/${s.conversion_action.id}`);
      const res = await ads.upload<{ results?: Row[]; partialFailureError?: unknown; jobId?: string }>(o.method, { [o.bodyKey]: rows, partialFailure: true });
      return uploadResult(s, rows.length, res, o.rowsField);
    },
  });
}

const noControl = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters");
/** Click identifiers are URL parameters; 500 characters is this tool's safety limit, not a documented Google limit. */
const clickId = z.string().trim().min(1).max(500).regex(/^[^\s\u0000-\u001f\u007f]+$/, "no spaces or control characters");
const consent = z.enum(["GRANTED", "DENIED"]);
const fmt = (n: number) => String(Math.round(n * 100) / 100);
/** "total value 120 USD, 30 EUR" for a summary, or "" when no row has a value. */
function totals(rows: { value?: number | undefined; currency_code?: string | undefined }[]): string {
  const by = new Map<string, number>();
  for (const r of rows) if (r.value !== undefined) by.set(r.currency_code ?? "default currency", (by.get(r.currency_code ?? "default currency") ?? 0) + r.value);
  return by.size ? `; total value ${[...by].map(([c, v]) => `${fmt(v)} ${c}`).join(", ")}` : "";
}
/** Refuses a request that repeats the same key (Google rejects duplicates inside one request). */
function noRepeats<T>(rows: T[], key: (r: T) => string | null, what: string) {
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const k = key(r);
    if (k === null) return;
    if (seen.has(k)) throw new ToolError("invalid_argument", `Rows ${seen.get(k)} and ${i} (0-based) are the same ${what}. Remove the repeat. Nothing was changed.`);
    seen.set(k, i);
  });
}

// -------------------------------------------------------------------------------------------- upload_call_conversions
const callRow = z
  .object({
    caller_id: z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164 with a leading "+", e.g. "+16502531234"').describe("The number the call came from, E.164 with a leading +."),
    call_start_date_time: dateTime.describe('When the call started: "yyyy-mm-dd hh:mm:ss+|-hh:mm".'),
    conversion_date_time: dateTime.describe("When the conversion happened, after the call started."),
    value: z.number().min(0).max(1_000_000_000).optional().describe("Conversion value (Google requires it to be at least 0)."),
    currency_code: currencyCode.optional().describe("ISO 4217 code of value. Needs value."),
  })
  .refine((r) => r.currency_code === undefined || r.value !== undefined, "currency_code needs value")
  .refine((r) => parseDateTime(r.conversion_date_time)! > parseDateTime(r.call_start_date_time)!, "conversion_date_time must be after call_start_date_time");

const uploadCallConversions = uploadTool({
  name: "upload_call_conversions",
  title: "Upload offline call conversions",
  description:
    "Imports offline call conversions (calls from ads that led to a sale or lead) into one ENABLED conversion action of type UPLOAD_CALLS, after a person approves it. Each row has the caller's number (E.164), the call start time and the conversion time (with time zone offsets), and optionally value and currency; up to 2,000 rows. Google requires the consent field, so ad_user_data_consent is required. Conversion tracking must have been enabled when the calls happened. Imported conversions change reporting and Smart Bidding, so this is high impact. Google imports the valid rows and rejects invalid ones individually (for example TOO_RECENT_CALL: retry after 12 hours); the result lists both. Uploads cannot be read back right away (statistics take up to 3 hours), so the result is Google's response, not a confirmation from re-reading.",
  input: z.object({
    account_id: accountId,
    conversion_action_id: idSchema.describe("An ENABLED conversion action of type UPLOAD_CALLS (list_conversion_actions)."),
    conversions: z.array(callRow).min(1).max(2000).describe("Up to 2,000 rows (Google's limit per request)."),
    ad_user_data_consent: consent.describe("Consent for ad user data, applied to every row. Google's call import guide requires consent on each call conversion."),
  }),
  method: "uploadCallConversions",
  bodyKey: "conversions",
  rowsField: ["conversions"],
  types: ["UPLOAD_CALLS"],
  what: "call conversion uploads",
  field: "uploaded_call_conversions",
  count: (a) => a.conversions.length,
  // Google returns DUPLICATE_CALL_CONVERSION_IN_REQUEST for two rows about the same call.
  checks: (a) => noRepeats(a.conversions, (r) => `${r.caller_id}|${parseDateTime(r.call_start_date_time)}`, "call (caller id and call start)"),
  rows: (a, conversionAction) =>
    a.conversions.map((r) => ({
      conversionAction,
      callerId: r.caller_id,
      callStartDateTime: r.call_start_date_time,
      conversionDateTime: r.conversion_date_time,
      ...(r.value !== undefined ? { conversionValue: r.value } : {}),
      ...(r.currency_code ? { currencyCode: r.currency_code } : {}),
      consent: { adUserData: a.ad_user_data_consent },
    })),
  describe: (a, s) => `Upload ${a.conversions.length} offline call conversion(s) to conversion action "${s.conversion_action.name ?? s.conversion_action.id}" (UPLOAD_CALLS)${totals(a.conversions)}; ad user data consent ${a.ad_user_data_consent}.`,
});

// -------------------------------------------------------------------------------------- upload_conversion_adjustments
/** Conversion action types Google accepts adjustments for (upload-adjustments guide, Requirements). */
const ADJUSTABLE = ["SALESFORCE", "UPLOAD_CLICKS", "WEBPAGE"] as const;
const adjustmentRow = z
  .object({
    adjustment_type: z.enum(["RETRACTION", "RESTATEMENT"]).describe("RETRACTION removes the conversion; RESTATEMENT changes its value."),
    order_id: noControl(255).optional().describe("Order (transaction) id of the original conversion. Required when the conversion was uploaded with one, and for WEBPAGE conversion actions."),
    gclid: clickId.optional().describe("With conversion_date_time, identifies a conversion that was reported without an order id."),
    conversion_date_time: dateTime.optional().describe("Original conversion time, exactly as reported, with gclid."),
    adjustment_date_time: dateTime.describe("When the adjustment happened (after the conversion). A second restatement of the same conversion needs a later adjustment time, or Google ignores it as a duplicate."),
    restated_value: z.number().min(0).max(1_000_000_000).optional().describe("RESTATEMENT only: the new total value of the conversion (to change 100 to 70, give 70)."),
    currency_code: currencyCode.optional().describe("RESTATEMENT only: currency of restated_value; default is the conversion action's, then the account's."),
  })
  .refine((r) => (r.order_id !== undefined) !== (r.gclid !== undefined || r.conversion_date_time !== undefined), "identify the conversion by order_id, or by gclid with conversion_date_time (not both)")
  .refine((r) => r.order_id !== undefined || (r.gclid !== undefined && r.conversion_date_time !== undefined), "gclid and conversion_date_time go together")
  .refine((r) => (r.adjustment_type === "RESTATEMENT" ? r.restated_value !== undefined : r.restated_value === undefined && r.currency_code === undefined), "RESTATEMENT needs restated_value; RETRACTION takes no value or currency")
  .refine((r) => r.conversion_date_time === undefined || parseDateTime(r.adjustment_date_time)! > parseDateTime(r.conversion_date_time)!, "adjustment_date_time must be after conversion_date_time");

const uploadConversionAdjustments = uploadTool({
  name: "upload_conversion_adjustments",
  title: "Upload conversion adjustments",
  description:
    "Retracts conversions or restates their value, after a person approves it, for one ENABLED conversion action of type WEBPAGE, UPLOAD_CLICKS or SALESFORCE. Identify each conversion by its order id (required for WEBPAGE actions and for conversions uploaded with one), or by gclid plus the original conversion time; wbraid and gbraid conversions are not supported here. RESTATEMENT needs the new value; RETRACTION takes none. Enhancements are not supported by this tool. Up to 2,000 rows. Adjustments change reported conversions and Smart Bidding, so this is high impact. Google applies valid rows and rejects invalid ones individually (for example CONVERSION_NOT_FOUND, or TOO_RECENT_CONVERSION_ACTION within 4 to 6 hours of creating the action); the result lists both. Adjustments cannot be read back right away, so the result is Google's response, not a confirmation from re-reading.",
  input: z.object({
    account_id: accountId,
    conversion_action_id: idSchema.describe("The conversion action the conversions belong to (an adjustment cannot move a conversion to another action)."),
    adjustments: z.array(adjustmentRow).min(1).max(2000).describe("Up to 2,000 rows (Google's limit per request)."),
  }),
  method: "uploadConversionAdjustments",
  bodyKey: "conversionAdjustments",
  rowsField: ["conversion_adjustments", "conversionAdjustments"],
  types: ADJUSTABLE,
  what: "conversion adjustments",
  field: "conversion_adjustments",
  count: (a) => a.adjustments.length,
  checks: (a, s) => {
    if (s.conversion_action.type === "WEBPAGE") {
      const i = a.adjustments.findIndex((r) => r.order_id === undefined);
      if (i >= 0) throw new ToolError("invalid_argument", `Row ${i} (0-based) has no order_id: Google requires the order id to adjust conversions of a WEBPAGE conversion action (MISSING_ORDER_ID_FOR_WEBPAGE). Nothing was changed.`);
    }
    noRepeats(a.adjustments, (r) => `${r.order_id ?? `${r.gclid}|${parseDateTime(r.conversion_date_time!)}`}|${parseDateTime(r.adjustment_date_time)}`, "conversion and adjustment time");
  },
  rows: (a, conversionAction) =>
    a.adjustments.map((r) => ({
      conversionAction,
      adjustmentType: r.adjustment_type,
      adjustmentDateTime: r.adjustment_date_time,
      ...(r.order_id !== undefined ? { orderId: r.order_id } : { gclidDateTimePair: { gclid: r.gclid, conversionDateTime: r.conversion_date_time } }),
      ...(r.adjustment_type === "RESTATEMENT" ? { restatementValue: { adjustedValue: r.restated_value, ...(r.currency_code ? { currencyCode: r.currency_code } : {}) } } : {}),
    })),
  describe: (a, s) => {
    const ret = a.adjustments.filter((r) => r.adjustment_type === "RETRACTION").length;
    const res = a.adjustments.length - ret;
    return `Adjust ${a.adjustments.length} conversion(s) of conversion action "${s.conversion_action.name ?? s.conversion_action.id}" (${s.conversion_action.type}): ${[ret ? `retract ${ret}` : "", res ? `restate the value of ${res}` : ""].filter(Boolean).join(", ")}.`;
  },
});

export const conversionOpsTools: AnyTool[] = [uploadCallConversions, uploadConversionAdjustments, ...conversionGoalTools, ...conversionValueRuleTools];
