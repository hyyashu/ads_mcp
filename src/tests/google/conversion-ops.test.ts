import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

/** Conversion uploads: upload_call_conversions, upload_conversion_adjustments. */
const C = "customers/1234567890";
type Action = { id: string; name: string; status: string; type: string; category?: string; ownerCustomer?: string };
let actions: Map<string, Action>;
let conversionCustomer: string | undefined;
let uploads: { path: string; body: any }[];
let respond: (path: string, body: any) => Response;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

/** Google's answer to an upload: a result per row, empty for rows listed in partialFailureError (best-practices/partial-failures). */
const partial = (rows: any[], failed: Record<number, string>, field = "conversions", jobId?: string) => ({
  results: rows.map((r, i) => (i in failed ? {} : r)),
  ...(Object.keys(failed).length
    ? { partialFailureError: { code: 3, message: "Partial failure", details: [{ "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure", errors: Object.entries(failed).map(([i, code]) => ({ errorCode: { conversionUploadError: code }, message: `row ${i}: ${code}`, location: { fieldPathElements: [{ fieldName: field, index: Number(i) }] } })) }] } }
    : {}),
  ...(jobId ? { jobId } : {}),
});

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    if (q.includes("FROM customer ")) return J({ results: [{ customer: { id: "1234567890", conversionTrackingSetting: conversionCustomer ? { googleAdsConversionCustomer: conversionCustomer } : {} } }] });
    if (q.includes("FROM conversion_action ")) {
      const id = /conversion_action\.id = (\d+)/.exec(q)?.[1];
      const a = id ? actions.get(id) : undefined;
      return J({ results: a ? [{ conversionAction: { ownerCustomer: C, category: "PURCHASE", ...a } }] : [] });
    }
    return J({ results: [] });
  }
  if (/:upload(Click|Call)Conversions$|:uploadConversionAdjustments$/.test(path)) {
    uploads.push({ path, body });
    return respond(path, body);
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("CU", fake);
});
beforeEach(() => {
  actions = new Map([
    ["71", { id: "71", name: "Offline sales", status: "ENABLED", type: "UPLOAD_CLICKS" }],
    ["72", { id: "72", name: "Phone sales", status: "ENABLED", type: "UPLOAD_CALLS", category: "PHONE_CALL_LEAD" }],
    ["73", { id: "73", name: "Checkout", status: "ENABLED", type: "WEBPAGE" }],
    ["74", { id: "74", name: "Old import", status: "HIDDEN", type: "UPLOAD_CLICKS" }],
    ["75", { id: "75", name: "Store visits", status: "ENABLED", type: "STORE_VISITS" }],
  ]);
  conversionCustomer = C;
  uploads = [];
  respond = (p, b) => J(partial(b.conversions ?? b.conversionAdjustments, {}, "conversions", p.endsWith("uploadCallConversions") ? undefined : "4242"));
});
const approve = (id: string) => kit.approveAs(id, kit.second);
const err = async (name: string, args: Record<string, unknown>) => (await kit.run(name, args)).error;

const click = (over: Record<string, unknown> = {}) => ({ gclid: "Cj0KCQjwAAA", conversion_date_time: "2026-11-01 14:30:00-04:00", ...over });

describe("upload_call_conversions", () => {
  const call = (over: Record<string, unknown> = {}) => ({ caller_id: "+16502531234", call_start_date_time: "2026-11-01 10:00:00-08:00", conversion_date_time: "2026-11-01 12:00:00-08:00", ...over });

  it("sends call conversions with consent and partial_failure", async () => {
    const r = await kit.run("upload_call_conversions", { conversion_action_id: "72", conversions: [call({ value: 50, currency_code: "EUR" }), call({ caller_id: "+447700900123" })], ad_user_data_consent: "DENIED" });
    expect(r.approval).toMatchObject({ risk: "high_impact", change_set: { changes: [{ field: "uploaded_call_conversions", after: "2 row(s)" }] } });
    expect(r.approval!.summary).toContain('Upload 2 offline call conversion(s) to conversion action "Phone sales" (UPLOAD_CALLS); total value 50 EUR; ad user data consent DENIED.');
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(uploads[0]).toEqual({
      path: `${C}:uploadCallConversions`,
      body: {
        conversions: [
          { conversionAction: `${C}/conversionActions/72`, callerId: "+16502531234", callStartDateTime: "2026-11-01 10:00:00-08:00", conversionDateTime: "2026-11-01 12:00:00-08:00", conversionValue: 50, currencyCode: "EUR", consent: { adUserData: "DENIED" } },
          { conversionAction: `${C}/conversionActions/72`, callerId: "+447700900123", callStartDateTime: "2026-11-01 10:00:00-08:00", conversionDateTime: "2026-11-01 12:00:00-08:00", consent: { adUserData: "DENIED" } },
        ],
        partialFailure: true,
      },
    });
    expect(done.result).toMatchObject({ sent: 2, accepted: 2, failed: [], job_id: null, confirmed_by_reread: false });
  });

  it("validates caller ids, consent, times and repeated calls, and checks the action type", async () => {
    const base = { conversion_action_id: "72", ad_user_data_consent: "GRANTED" };
    expect((await err("upload_call_conversions", { ...base, conversions: [call({ caller_id: "6502531234" })] }))?.code).toBe("invalid_argument");
    expect((await err("upload_call_conversions", { conversion_action_id: "72", conversions: [call()] }))?.code).toBe("invalid_argument");
    expect((await err("upload_call_conversions", { ...base, conversions: [call({ conversion_date_time: "2026-11-01 09:00:00-08:00" })] }))?.message).toContain("after call_start_date_time");
    // The same instant written with another offset is still the same call.
    expect((await err("upload_call_conversions", { ...base, conversions: [call(), call({ call_start_date_time: "2026-11-01 18:00:00+00:00", conversion_date_time: "2026-11-01 19:00:00+00:00" })] }))?.message).toContain("same call");
    expect((await err("upload_call_conversions", { ...base, conversion_action_id: "71", conversions: [call()] }))?.message).toContain("type UPLOAD_CALLS");
    expect(uploads).toHaveLength(0);
  });
});

describe("upload_conversion_adjustments", () => {
  it("retracts by order id and restates by gclid and conversion time", async () => {
    const r = await kit.run("upload_conversion_adjustments", {
      conversion_action_id: "71",
      adjustments: [
        { adjustment_type: "RETRACTION", order_id: "A-1", adjustment_date_time: "2026-11-05 10:00:00+00:00" },
        { adjustment_type: "RESTATEMENT", gclid: "Cj0KCQjwAAA", conversion_date_time: "2026-11-01 14:30:00-04:00", adjustment_date_time: "2026-11-05 10:00:00+00:00", restated_value: 70, currency_code: "USD" },
      ],
    });
    expect(r.approval).toMatchObject({ risk: "high_impact", change_set: { changes: [{ field: "conversion_adjustments", after: "2 row(s)" }] } });
    expect(r.approval!.summary).toContain('Adjust 2 conversion(s) of conversion action "Offline sales" (UPLOAD_CLICKS): retract 1, restate the value of 1.');
    respond = (_p, b) => J(partial(b.conversionAdjustments.map((x: any) => ({ conversionAction: x.conversionAction, adjustmentType: x.adjustmentType })), { 0: "CONVERSION_NOT_FOUND" }, "conversion_adjustments", "77"));
    const done = await approve(r.approval!.approval_id);
    expect(uploads[0]).toEqual({
      path: `${C}:uploadConversionAdjustments`,
      body: {
        conversionAdjustments: [
          { conversionAction: `${C}/conversionActions/71`, adjustmentType: "RETRACTION", adjustmentDateTime: "2026-11-05 10:00:00+00:00", orderId: "A-1" },
          { conversionAction: `${C}/conversionActions/71`, adjustmentType: "RESTATEMENT", adjustmentDateTime: "2026-11-05 10:00:00+00:00", gclidDateTimePair: { gclid: "Cj0KCQjwAAA", conversionDateTime: "2026-11-01 14:30:00-04:00" }, restatementValue: { adjustedValue: 70, currencyCode: "USD" } },
        ],
        partialFailure: true,
      },
    });
    expect(done.result).toMatchObject({ job_id: "77", sent: 2, accepted: 1, failed: [{ index: 0, error_code: "conversionUploadError.CONVERSION_NOT_FOUND" }] });
  });

  it("validates identification, values and times, requires order ids for WEBPAGE actions, and checks the action type", async () => {
    const at = "2026-11-05 10:00:00+00:00";
    const bad = [
      { adjustment_type: "RETRACTION", adjustment_date_time: at },
      { adjustment_type: "RETRACTION", order_id: "A", gclid: "G", conversion_date_time: "2026-11-01 14:30:00-04:00", adjustment_date_time: at },
      { adjustment_type: "RETRACTION", gclid: "G", adjustment_date_time: at },
      { adjustment_type: "RESTATEMENT", order_id: "A", adjustment_date_time: at },
      { adjustment_type: "RETRACTION", order_id: "A", adjustment_date_time: at, restated_value: 5 },
      { adjustment_type: "ENHANCEMENT", order_id: "A", adjustment_date_time: at },
      { adjustment_type: "RETRACTION", gclid: "G", conversion_date_time: "2026-11-06 14:30:00-04:00", adjustment_date_time: at },
    ];
    for (const row of bad) expect((await err("upload_conversion_adjustments", { conversion_action_id: "71", adjustments: [row] }))?.code).toBe("invalid_argument");
    expect((await err("upload_conversion_adjustments", { conversion_action_id: "73", adjustments: [{ adjustment_type: "RETRACTION", gclid: "G", conversion_date_time: "2026-11-01 14:30:00-04:00", adjustment_date_time: at }] }))?.message).toContain("MISSING_ORDER_ID_FOR_WEBPAGE");
    expect((await err("upload_conversion_adjustments", { conversion_action_id: "71", adjustments: [{ adjustment_type: "RETRACTION", order_id: "A", adjustment_date_time: at }, { adjustment_type: "RETRACTION", order_id: "A", adjustment_date_time: at }] }))?.message).toContain("same conversion");
    expect((await err("upload_conversion_adjustments", { conversion_action_id: "72", adjustments: [{ adjustment_type: "RETRACTION", order_id: "A", adjustment_date_time: at }] }))?.message).toContain("SALESFORCE or UPLOAD_CLICKS or WEBPAGE");
    expect((await err("upload_conversion_adjustments", { conversion_action_id: "75", adjustments: [{ adjustment_type: "RETRACTION", order_id: "A", adjustment_date_time: at }] }))?.code).toBe("invalid_argument");
    // A WEBPAGE action with order ids is accepted.
    const ok = await kit.run("upload_conversion_adjustments", { conversion_action_id: "73", adjustments: [{ adjustment_type: "RESTATEMENT", order_id: "W-9", adjustment_date_time: at, restated_value: 0 }] });
    expect(ok.approval?.risk).toBe("high_impact");
    expect(uploads).toHaveLength(0);
  });
});
