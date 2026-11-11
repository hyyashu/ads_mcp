import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { googleHarness, type GoogleHarness } from "../support/harness";

/**
 * In-memory assets, links at account / campaign / ad group level, campaigns with asset automation settings, lead form
 * submissions and aggregate asset views. googleAds:mutate applies asset, link and campaign operations atomically.
 */
const C = "customers/1234567890";
type Asset = Record<string, any> & { id: string };
let assets: Map<string, Asset>;
let links: { campaign?: string; adGroup?: string; asset: string; fieldType: string; status: string }[];
let campaigns: Record<string, any>[];
let leads: Record<string, any>[];
let aggregate: { campaign: Record<string, any>[]; channel: Record<string, any>[] };
let queries: string[];
let nextId = 1000;
let mutates: any[][];
let dropWrites = false;
let googleError: { status: number; body: unknown } | null = null;
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    queries.push(q);
    if (q.includes("FROM campaign ")) {
      const one = /campaign\.id = (\d+)/.exec(q)?.[1];
      const ids = /campaign\.id IN \(([^)]*)\)/.exec(q)?.[1]?.split(",").map((x) => x.trim());
      const hits = campaigns.filter((c) => (!one || c.id === one) && (!ids || ids.includes(c.id)) && (!q.includes("campaign.status != 'REMOVED'") || c.status !== "REMOVED"));
      return J({ results: hits.map((c) => ({ campaign: q.includes("asset_automation_settings") ? c : { id: c.id, name: c.name, status: c.status } })) });
    }
    if (q.includes("FROM ad_group ")) return J({ results: q.includes("ad_group.id = 21") ? [{ adGroup: { id: "21", name: "Shoes", status: "ENABLED" } }] : [] });
    const level = /FROM (campaign_asset|ad_group_asset|customer_asset)\b/.exec(q)?.[1];
    if (level) {
      const ft = /_asset\.field_type = '([A-Z_]+)'/.exec(q)?.[1];
      const owner = /_asset\.(?:campaign|ad_group) = '([^']+)'/.exec(q)?.[1];
      const at = (l: (typeof links)[number]) => (level === "campaign_asset" ? !!l.campaign : level === "ad_group_asset" ? !!l.adGroup : !l.campaign && !l.adGroup);
      const hits = links.filter((l) => at(l) && l.status !== "REMOVED" && (!ft || l.fieldType === ft) && (!owner || l.campaign === owner || l.adGroup === owner));
      return J({ results: hits.map((l) => ({ ...(level === "campaign_asset" ? { campaignAsset: { status: l.status } } : level === "ad_group_asset" ? { adGroupAsset: { status: l.status } } : { customerAsset: { status: l.status } }), asset: assets.get(l.asset) })) });
    }
    if (q.includes("FROM lead_form_submission_data")) return J({ results: leads.map((l) => ({ leadFormSubmissionData: l })) });
    if (q.includes("FROM campaign_aggregate_asset_view")) return J({ results: aggregate.campaign });
    if (q.includes("FROM channel_aggregate_asset_view")) return J({ results: aggregate.channel });
    return J({ results: [] });
  }
  if (path.endsWith("googleAds:mutate")) {
    mutates.push(body.mutateOperations);
    if (googleError) return J(googleError.body, googleError.status);
    if (dropWrites) return J({ mutateOperationResponses: [] });
    const tempMap = new Map<string, string>();
    for (const op of body.mutateOperations) {
      if (op.assetOperation?.create) {
        const id = String(nextId++);
        const { resourceName, ...rest } = op.assetOperation.create;
        tempMap.set(resourceName, id);
        assets.set(id, { id, ...rest });
      } else if (op.campaignAssetOperation?.create || op.adGroupAssetOperation?.create || op.customerAssetOperation?.create) {
        const c = op.campaignAssetOperation?.create ?? op.adGroupAssetOperation?.create ?? op.customerAssetOperation.create;
        links.push({ ...(c.campaign ? { campaign: c.campaign } : {}), ...(c.adGroup ? { adGroup: c.adGroup } : {}), asset: tempMap.get(c.asset) ?? c.asset.split("/").pop(), fieldType: c.fieldType, status: "ENABLED" });
      } else if (op.campaignOperation?.update) {
        const u = op.campaignOperation.update;
        const camp = campaigns.find((x) => `${C}/campaigns/${x.id}` === u.resourceName)!;
        expect(op.campaignOperation.updateMask).toBe("asset_automation_settings");
        camp.assetAutomationSettings = u.assetAutomationSettings;
      }
    }
    return J({ mutateOperationResponses: body.mutateOperations.map(() => ({})) });
  }
  return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `no handler ${path}` } }, 400);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("MA", fake);
});
beforeEach(() => {
  assets = new Map();
  links = [];
  campaigns = [
    { id: "11", name: "Brand", status: "ENABLED", advertisingChannelType: "SEARCH", assetAutomationSettings: [] },
    {
      id: "12",
      name: "PMax",
      status: "ENABLED",
      advertisingChannelType: "PERFORMANCE_MAX",
      assetAutomationSettings: [
        { assetAutomationType: "GENERATE_IMAGE_ENHANCEMENT", assetAutomationStatus: "OPTED_IN" },
        { assetAutomationType: "AUTOMATED_VIDEO_CRAWL", assetAutomationStatus: "OPTED_IN", automatedVideoCrawlSetting: { automatedVideoCrawlInfos: [{ url: "https://shop.example", sourcePlatform: "LANDING_PAGE", enabled: true }] } },
      ],
    },
    { id: "13", name: "Old", status: "REMOVED", advertisingChannelType: "SEARCH", assetAutomationSettings: [] },
    { id: "14", name: "Display", status: "PAUSED", advertisingChannelType: "DISPLAY", assetAutomationSettings: [] },
  ];
  leads = [];
  aggregate = { campaign: [], channel: [] };
  queries = [];
  mutates = [];
  dropWrites = false;
  googleError = null;
});
const approve = (id: string, by = kit.owner) => kit.approveAs(id, by);
const err = async (name: string, args: Record<string, unknown>) => (await kit.run(name, args)).error;

// ------------------------------------------------------------------------------------------------------- promotion
const promo = { campaign_id: "11", promotion_target: "Running shoes", percent_off: 20, promotion_code: "SAVE20", occasion: "BLACK_FRIDAY", language_code: "en", start_date: "2026-11-20", end_date: "2026-11-30", redemption_start_date: "2026-11-27", redemption_end_date: "2026-11-30", final_url: "https://shop.example/sale" };

describe("add_promotion_asset", () => {
  it("creates the asset and campaign link atomically, with the documented promotion fields, and confirms", async () => {
    const r = await kit.run("add_promotion_asset", promo);
    expect(r.approval).toMatchObject({ risk: "write", summary: expect.stringContaining('campaign "Brand": 20% off Running shoes with code SAVE20 (2026-11-20 to 2026-11-30)') });
    expect(r.approval?.change_set?.changes).toEqual([expect.objectContaining({ resource: "campaign", id: "11", field: "promotion", before: null, effect: "neutral" })]);
    expect(mutates).toHaveLength(0);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      {
        assetOperation: {
          create: {
            resourceName: `${C}/assets/-1`,
            finalUrls: ["https://shop.example/sale"],
            promotionAsset: { promotionTarget: "Running shoes", percentOff: "200000", occasion: "BLACK_FRIDAY", promotionCode: "SAVE20", languageCode: "en", startDate: "2026-11-20", endDate: "2026-11-30", redemptionStartDate: "2026-11-27", redemptionEndDate: "2026-11-30" },
          },
        },
      },
      { campaignAssetOperation: { create: { asset: `${C}/assets/-1`, campaign: `${C}/campaigns/11`, fieldType: "PROMOTION" } } },
    ]);
    expect(done.result).toEqual({ level: "campaign", campaign_id: "11", ad_group_id: null, asset_id: expect.stringMatching(/^\d+$/), label: "20% off Running shoes with code SAVE20 (2026-11-20 to 2026-11-30)" });
    // The same promotion again is a no-op.
    expect((await err("add_promotion_asset", promo))?.message).toContain("Nothing would change: an identical promotion");
  });

  it("links at account level with a money discount and a minimum order", async () => {
    const r = await kit.run("add_promotion_asset", { level: "account", promotion_target: "Everything", money_amount_off: { amount: 10, currency_code: "USD" }, orders_over_amount: { amount: 50, currency_code: "USD" }, discount_modifier: "UP_TO", final_url: "https://shop.example" });
    expect(r.approval?.summary).toContain("the account");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      { assetOperation: { create: { resourceName: `${C}/assets/-1`, finalUrls: ["https://shop.example"], promotionAsset: { promotionTarget: "Everything", moneyAmountOff: { amountMicros: "10000000", currencyCode: "USD" }, discountModifier: "UP_TO", ordersOverAmount: { amountMicros: "50000000", currencyCode: "USD" } } } } },
      { customerAssetOperation: { create: { asset: `${C}/assets/-1`, fieldType: "PROMOTION" } } },
    ]);
    expect(done.result).toMatchObject({ level: "account", campaign_id: null, label: "10 USD off Everything on orders over 50" });
  });

  it("validates the discount, the trigger, dates, occasion and level; refuses unknown and removed owners", async () => {
    const base = { campaign_id: "11", promotion_target: "Shoes", final_url: "https://shop.example" };
    for (const bad of [
      { ...base },
      { ...base, percent_off: 10, money_amount_off: { amount: 5, currency_code: "USD" } },
      { ...base, percent_off: 0 },
      { ...base, percent_off: 101 },
      { ...base, money_amount_off: { amount: 0, currency_code: "USD" } },
      { ...base, money_amount_off: { amount: 5, currency_code: "usd" } },
      { ...base, percent_off: 10, promotion_code: "X", orders_over_amount: { amount: 5, currency_code: "USD" } },
      { ...base, percent_off: 10, start_date: "2026-12-02", end_date: "2026-12-01" },
      { ...base, percent_off: 10, redemption_start_date: "2026-12-02", redemption_end_date: "2026-12-01" },
      { ...base, percent_off: 10, start_date: "2026-02-30" },
      { ...base, percent_off: 10, occasion: "BIRTHDAY" },
      { ...base, percent_off: 10, language_code: "English" },
      { ...base, percent_off: 10, final_url: "javascript:alert(1)" },
      { ...base, percent_off: 10, level: "account" },
      { ...base, percent_off: 10, level: "ad_group" },
    ]) expect((await err("add_promotion_asset", bad))?.code, JSON.stringify(bad)).toBe("invalid_argument");
    expect((await err("add_promotion_asset", { ...base, percent_off: 10, campaign_id: "99" }))?.code).toBe("not_found");
    expect((await err("add_promotion_asset", { ...base, percent_off: 10, campaign_id: "13" }))?.message).toContain("removed");
    expect((await err("add_promotion_asset", { promotion_target: "Shoes", percent_off: 10, final_url: "https://shop.example", level: "ad_group", ad_group_id: "99" }))?.code).toBe("not_found");
    expect(mutates).toHaveLength(0);
  });

  it("drift before approval applies nothing; an unconfirmed write is unknown_outcome", async () => {
    const r = await kit.run("add_promotion_asset", { ...promo, promotion_target: "Sandals" });
    assets.set("700", { id: "700", promotionAsset: { promotionTarget: "Other" } });
    links.push({ campaign: `${C}/campaigns/11`, asset: "700", fieldType: "PROMOTION", status: "ENABLED" });
    expect((await approve(r.approval!.approval_id)).status).toBe("failed");
    expect(mutates).toHaveLength(0);
    const r2 = await kit.run("add_promotion_asset", { ...promo, promotion_target: "Boots" });
    dropWrites = true;
    expect((await approve(r2.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});

// ----------------------------------------------------------------------------------------------------------- price
const offer = (header: string, amount: number) => ({ header, description: `${header} plan`, price: { amount, currency_code: "EUR" }, unit: "PER_MONTH", final_url: `https://shop.example/${header.toLowerCase()}` });
const price = { level: "ad_group", ad_group_id: "21", type: "SERVICE_TIERS", price_qualifier: "FROM", language_code: "de", price_offerings: [offer("Basic", 9.99), offer("Plus", 19.99), offer("Pro", 29)] };

describe("add_price_asset", () => {
  it("creates 3 to 8 offerings at ad group level with the documented shape", async () => {
    const r = await kit.run("add_price_asset", price);
    expect(r.approval?.summary).toContain('ad group "Shoes": service tiers (from): Basic 9.99 EUR per month');
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      {
        assetOperation: {
          create: {
            resourceName: `${C}/assets/-1`,
            priceAsset: {
              type: "SERVICE_TIERS",
              priceQualifier: "FROM",
              languageCode: "de",
              priceOfferings: [
                { header: "Basic", description: "Basic plan", price: { amountMicros: "9990000", currencyCode: "EUR" }, unit: "PER_MONTH", finalUrl: "https://shop.example/basic" },
                { header: "Plus", description: "Plus plan", price: { amountMicros: "19990000", currencyCode: "EUR" }, unit: "PER_MONTH", finalUrl: "https://shop.example/plus" },
                { header: "Pro", description: "Pro plan", price: { amountMicros: "29000000", currencyCode: "EUR" }, unit: "PER_MONTH", finalUrl: "https://shop.example/pro" },
              ],
            },
          },
        },
      },
      { adGroupAssetOperation: { create: { asset: `${C}/assets/-1`, adGroup: `${C}/adGroups/21`, fieldType: "PRICE" } } },
    ]);
    expect(done.result).toMatchObject({ level: "ad_group", ad_group_id: "21", campaign_id: null });
    expect((await err("add_price_asset", price))?.message).toContain("Nothing would change");
  });

  it("enforces the documented limits", async () => {
    for (const bad of [
      { ...price, price_offerings: price.price_offerings.slice(0, 2) },
      { ...price, price_offerings: Array.from({ length: 9 }, (_, i) => offer(`T${i}`, i + 1)) },
      { ...price, price_offerings: [offer("x".repeat(26), 1), offer("B", 2), offer("C", 3)] },
      { ...price, price_offerings: [{ ...offer("A", 1), description: "y".repeat(26) }, offer("B", 2), offer("C", 3)] },
      { ...price, language_code: undefined },
      { ...price, type: "HOTELS" },
      { ...price, price_offerings: [{ ...offer("A", 1), unit: "PER_MINUTE" }, offer("B", 2), offer("C", 3)] },
    ]) expect((await err("add_price_asset", bad))?.code, JSON.stringify(bad).slice(0, 80)).toBe("invalid_argument");
    expect(mutates).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------------- lead form
const lead = {
  campaign_id: "11",
  business_name: "Acme Cruises",
  headline: "Trip to Jupiter",
  description: "Our latest trip to Jupiter is open for booking.",
  privacy_policy_url: "https://shop.example/privacy",
  call_to_action_type: "BOOK_NOW",
  call_to_action_description: "Latest trip to Jupiter!",
  final_url: "https://shop.example/jupiter",
  fields: [{ input_type: "FULL_NAME" }, { input_type: "EMAIL" }, { input_type: "PHONE_NUMBER" }],
  custom_questions: [{ question: "How many travellers?", single_choice_answers: ["1", "2", "3+"] }],
  post_submit_headline: "Thanks!",
  post_submit_description: "We will call you shortly.",
  post_submit_call_to_action_type: "VISIT_SITE",
  webhook: { url: "https://hooks.example/leads", google_key: "s3cret-key" },
};

describe("add_lead_form_asset", () => {
  it("creates the lead form and its campaign link; the webhook secret stays out of the approval text", async () => {
    const r = await kit.run("add_lead_form_asset", lead);
    expect(r.approval?.summary).toContain('campaign "Brand": "Trip to Jupiter" by Acme Cruises (3 field(s): FULL_NAME, EMAIL, PHONE_NUMBER; 1 custom question(s); leads also sent to https://hooks.example/leads)');
    expect(JSON.stringify(r.approval?.summary)).not.toContain("s3cret");
    expect(JSON.stringify(r.approval?.change_set)).not.toContain("s3cret");
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      {
        assetOperation: {
          create: {
            resourceName: `${C}/assets/-1`,
            finalUrls: ["https://shop.example/jupiter"],
            leadFormAsset: {
              businessName: "Acme Cruises",
              headline: "Trip to Jupiter",
              description: "Our latest trip to Jupiter is open for booking.",
              privacyPolicyUrl: "https://shop.example/privacy",
              callToActionType: "BOOK_NOW",
              callToActionDescription: "Latest trip to Jupiter!",
              fields: [{ inputType: "FULL_NAME" }, { inputType: "EMAIL" }, { inputType: "PHONE_NUMBER" }],
              customQuestionFields: [{ customQuestionText: "How many travellers?", singleChoiceAnswers: { answers: ["1", "2", "3+"] } }],
              postSubmitHeadline: "Thanks!",
              postSubmitDescription: "We will call you shortly.",
              postSubmitCallToActionType: "VISIT_SITE",
              deliveryMethods: [{ webhook: { advertiserWebhookUrl: "https://hooks.example/leads", googleSecret: "s3cret-key", payloadSchemaVersion: "3" } }],
            },
          },
        },
      },
      { campaignAssetOperation: { create: { asset: `${C}/assets/-1`, campaign: `${C}/campaigns/11`, fieldType: "LEAD_FORM" } } },
    ]);
    expect(done.result).toEqual({ campaign_id: "11", asset_id: expect.stringMatching(/^\d+$/), label: '"Trip to Jupiter" by Acme Cruises' });
    expect((await err("add_lead_form_asset", lead))?.message).toContain("Nothing would change: an identical lead form");
  });

  it("validates fields, answers, custom questions and the webhook", async () => {
    const { webhook: _w, custom_questions: _q, ...minimal } = lead;
    for (const bad of [
      { ...minimal, fields: [] },
      { ...minimal, fields: [{ input_type: "EMAIL" }, { input_type: "EMAIL" }] },
      { ...minimal, fields: [{ input_type: "SHOE_SIZE" }] },
      { ...minimal, fields: [{ input_type: "PREFERRED_CONTACT_TIME", single_choice_answers: ["Only"] }] },
      { ...minimal, fields: [{ input_type: "PREFERRED_CONTACT_TIME", single_choice_answers: Array.from({ length: 13 }, (_, i) => `a${i}`) }] },
      { ...minimal, custom_questions: Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}?` })) },
      { ...minimal, fields: [{ input_type: "EMAIL", single_choice_answers: ["a", "b"] }] },
      { ...minimal, fields: [{ input_type: "EMAIL" }, { input_type: "PREFERRED_CONTACT_TIME" }], custom_questions: [{ question: "Budget?" }] },
      { ...minimal, webhook: { url: "http://hooks.example/leads", google_key: "k" } },
      { ...minimal, webhook: { url: "https://hooks.example/leads", google_key: "" } },
      { ...minimal, call_to_action_type: "BUY_NOW" },
      { ...minimal, privacy_policy_url: "not a url" },
      { ...minimal, campaign_id: undefined },
    ]) expect((await err("add_lead_form_asset", bad))?.code, JSON.stringify(bad).slice(0, 120)).toBe("invalid_argument");
    expect((await err("add_lead_form_asset", { ...minimal, campaign_id: "99" }))?.code).toBe("not_found");
    expect(mutates).toHaveLength(0);
  });

  it("a minimal form sends only what was given; pre-vetted questions carry their answer choices", async () => {
    const { webhook: _w, custom_questions: _q, post_submit_headline: _h, post_submit_description: _d, post_submit_call_to_action_type: _c, ...minimal } = lead;
    const r = await kit.run("add_lead_form_asset", { ...minimal, fields: [{ input_type: "EMAIL" }, { input_type: "PREFERRED_CONTACT_TIME", single_choice_answers: ["Before 9 AM", "Anytime", "After 5 PM"] }] });
    expect((await approve(r.approval!.approval_id)).status).toBe("executed");
    const sent = mutates[0]![0].assetOperation.create.leadFormAsset;
    expect(Object.keys(sent).sort()).toEqual(["businessName", "callToActionDescription", "callToActionType", "description", "fields", "headline", "privacyPolicyUrl"]);
    expect(sent.fields).toEqual([{ inputType: "EMAIL" }, { inputType: "PREFERRED_CONTACT_TIME", singleChoiceAnswers: { answers: ["Before 9 AM", "Anytime", "After 5 PM"] } }]);
  });

  it("returns Google's error (for example lead form terms not accepted) and creates nothing", async () => {
    const r = await kit.run("add_lead_form_asset", { ...lead, headline: "Trip to Saturn" });
    googleError = { status: 400, body: { error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument.", details: [{ "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure", errors: [{ errorCode: { assetError: "LEAD_FORM_MISSING_AGREEMENT" }, message: "Lead forms require that the Terms of Service have been agreed to before mutates can be executed." }] }] } } };
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect(done.result).toEqual({ error: { code: "invalid_argument", message: "Lead forms require that the Terms of Service have been agreed to before mutates can be executed." } });
    expect(links).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------ lead form submissions
describe("get_lead_form_submissions", () => {
  beforeEach(() => {
    leads = [
      { id: "L1", submissionDateTime: "2026-11-02 09:00:00-08:00", campaign: `${C}/campaigns/11`, adGroup: `${C}/adGroups/21`, adGroupAd: `${C}/adGroupAds/21~555`, asset: `${C}/assets/800`, gclid: "g1", leadFormSubmissionFields: [{ fieldType: "FULL_NAME", fieldValue: "Ada Lovelace" }, { fieldType: "EMAIL", fieldValue: "ada@example.com" }], customLeadFormSubmissionFields: [{ questionText: "How many travellers?", fieldValue: "2" }] },
      { id: "L2", submissionDateTime: "2026-11-05 10:00:00-08:00", campaign: `${C}/campaigns/11`, asset: `${C}/assets/800`, leadFormSubmissionFields: [{ fieldType: "EMAIL", fieldValue: "bob@example.com" }] },
    ];
  });

  it("is labelled as personal data and returns submissions newest first with their answers", async () => {
    expect(kit.deps.registry.get("get_lead_form_submissions")!.description).toMatch(/^PERSONAL DATA\./);
    const r = await kit.run("get_lead_form_submissions", { start_date: "2026-11-01", end_date: "2026-11-07", campaign_ids: ["11"], asset_id: "800" });
    expect(r.error).toBeUndefined();
    const d = r.data as any;
    expect(d.submissions.map((s: any) => s.id)).toEqual(["L2", "L1"]);
    expect(d.submissions[1]).toEqual({ id: "L1", submitted_at: "2026-11-02 09:00:00-08:00", campaign_id: "11", ad_group_id: "21", ad_id: "555", asset_id: "800", gclid: "g1", fields: [{ field_type: "FULL_NAME", value: "Ada Lovelace" }, { field_type: "EMAIL", value: "ada@example.com" }], custom_fields: [{ question: "How many travellers?", value: "2" }] });
    expect(d.submissions[0]).toMatchObject({ ad_group_id: null, ad_id: null, gclid: null });
    const q = queries.at(-1)!;
    expect(q).toContain("lead_form_submission_data.submission_date_time >= '2026-11-01 00:00:00'");
    expect(q).toContain("lead_form_submission_data.submission_date_time <= '2026-11-07 23:59:59'");
    expect(q).toContain(`lead_form_submission_data.campaign IN ('${C}/campaigns/11')`);
    expect(q).toContain(`lead_form_submission_data.asset = '${C}/assets/800'`);
  });

  it("keeps only the requested answer types, caps the rows, and checks the dates", async () => {
    const d = (await kit.run("get_lead_form_submissions", { start_date: "2026-11-01", end_date: "2026-11-07", field_types: ["EMAIL"], limit: 1 })).data as any;
    expect(d).toMatchObject({ returned: 1, truncated: true });
    expect(d.submissions[0]).toMatchObject({ id: "L2", fields: [{ field_type: "EMAIL", value: "bob@example.com" }], custom_fields: [] });
    expect((await err("get_lead_form_submissions", { start_date: "2026-11-07", end_date: "2026-11-01" }))?.code).toBe("invalid_argument");
    expect((await err("get_lead_form_submissions", { start_date: "2026-11-01" }))?.code).toBe("invalid_argument");
    expect((await err("get_lead_form_submissions", { start_date: "2026-11-01", end_date: "2026-11-07", field_types: ["email'); DROP"] }))?.code).toBe("invalid_argument");
  });
});

// ------------------------------------------------------------------------------------------------ business message
const bm = { campaign_id: "11", message_provider: "WHATSAPP", whatsapp: { country_code: "us", phone_number: "(123)456-7890" }, starter_message: "Hi! How can we help?", call_to_action: { selection: "GET_QUOTE", description: "Message us for a quote" } };

describe("add_business_message_asset", () => {
  it("creates a WhatsApp asset with its required fields and links it", async () => {
    const r = await kit.run("add_business_message_asset", bm);
    expect(r.approval?.summary).toContain('campaign "Brand": WHATSAPP US (123)456-7890: "Hi! How can we help?"');
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      { assetOperation: { create: { resourceName: `${C}/assets/-1`, businessMessageAsset: { messageProvider: "WHATSAPP", whatsappInfo: { countryCode: "US", phoneNumber: "(123)456-7890" }, starterMessage: "Hi! How can we help?", callToAction: { callToActionSelection: "GET_QUOTE", callToActionDescription: "Message us for a quote" } } } } },
      { campaignAssetOperation: { create: { asset: `${C}/assets/-1`, campaign: `${C}/campaigns/11`, fieldType: "BUSINESS_MESSAGE" } } },
    ]);
    expect(done.result).toMatchObject({ level: "campaign", campaign_id: "11", label: 'WHATSAPP US (123)456-7890: "Hi! How can we help?"' });
    expect((await err("add_business_message_asset", bm))?.message).toContain("Nothing would change");
  });

  it("refuses a second active asset for the same provider at the same level, but not for another provider or a paused one", async () => {
    assets.set("900", { id: "900", businessMessageAsset: { messageProvider: "WHATSAPP", whatsappInfo: { countryCode: "US", phoneNumber: "5550000" }, starterMessage: "Hello" } });
    assets.set("901", { id: "901", businessMessageAsset: { messageProvider: "FACEBOOK_MESSENGER", facebookMessengerInfo: { pageName: "Acme" }, starterMessage: "Hey" } });
    links.push({ campaign: `${C}/campaigns/11`, asset: "900", fieldType: "BUSINESS_MESSAGE", status: "ENABLED" }, { campaign: `${C}/campaigns/11`, asset: "901", fieldType: "BUSINESS_MESSAGE", status: "ENABLED" });
    expect((await err("add_business_message_asset", bm))?.message).toMatch(/already has an active WHATSAPP business message asset \(asset 900.*only one active/);
    // Another level is a separate limit.
    expect((await kit.run("add_business_message_asset", { ...bm, campaign_id: undefined, level: "account" })).approval).toBeDefined();
    links[0]!.status = "PAUSED";
    const r = await kit.run("add_business_message_asset", { ...bm, starter_message: "Hello again" });
    expect((await approve(r.approval!.approval_id)).status).toBe("executed");
  });

  it("sends the provider-specific details for the other providers", async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ message_provider: "SMS", sms: { country_code: "GB", phone_number: "+44 20 7946 0000" } }, { smsInfo: { countryCode: "GB", phoneNumber: "+44 20 7946 0000" } }],
      [{ message_provider: "FACEBOOK_MESSENGER", facebook_messenger: { page_name: "Acme" } }, { facebookMessengerInfo: { pageName: "Acme" } }],
      [{ message_provider: "LINE", line: { line_id: "@acme" } }, { lineInfo: { lineId: "@acme" } }],
      [{ message_provider: "ZALO", zalo: { oa_id: "123456" } }, { zaloInfo: { oaId: "123456" } }],
    ];
    for (const [i, [args, info]] of cases.entries()) {
      const r = await kit.run("add_business_message_asset", { campaign_id: "11", starter_message: "Hi", call_to_action: { selection: "CONTACT_US", description: "Chat with us" }, ...args });
      expect((await approve(r.approval!.approval_id)).status).toBe("executed");
      expect(mutates[i]![0].assetOperation.create.businessMessageAsset).toEqual({ messageProvider: args.message_provider, ...info, starterMessage: "Hi", callToAction: { callToActionSelection: "CONTACT_US", callToActionDescription: "Chat with us" } });
    }
  });

  it("validates provider details", async () => {
    for (const bad of [
      { ...bm, whatsapp: undefined },
      { ...bm, sms: { country_code: "US", phone_number: "1234567" } },
      { ...bm, whatsapp: undefined, sms: { country_code: "US", phone_number: "1234567" } },
      { ...bm, message_provider: "LINE", whatsapp: undefined, line: { line_id: "acme" } },
      { ...bm, message_provider: "ZALO", whatsapp: undefined, zalo: { oa_id: "1", custom_name: "Acme" } },
      { ...bm, whatsapp: { country_code: "USA", phone_number: "123" } },
      { ...bm, message_provider: "TELEGRAM" },
      { ...bm, call_to_action: { selection: "BUY", description: "x" } },
      { ...bm, starter_message: "" },
    ]) expect((await err("add_business_message_asset", bad))?.code, JSON.stringify(bad).slice(0, 120)).toBe("invalid_argument");
    expect(mutates).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------- automation settings
describe("get_asset_automation_settings", () => {
  it("lists explicit settings and the supported types left at Google's defaults", async () => {
    const d = (await kit.run("get_asset_automation_settings", {})).data as any;
    expect(d.campaigns.map((c: any) => c.campaign_id)).toEqual(["11", "12", "14"]);
    const pmax = d.campaigns.find((c: any) => c.campaign_id === "12");
    expect(pmax.settings).toEqual([
      { type: "AUTOMATED_VIDEO_CRAWL", status: "OPTED_IN", video_crawl_sources: [{ url: "https://shop.example", source_platform: "LANDING_PAGE", enabled: true }] },
      { type: "GENERATE_IMAGE_ENHANCEMENT", status: "OPTED_IN" },
    ]);
    expect(pmax.unset_supported_types.map((t: any) => t.type)).toEqual(["TEXT_ASSET_AUTOMATION", "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION", "GENERATE_ENHANCED_YOUTUBE_VIDEOS", "GENERATE_IMAGE_EXTRACTION"]);
    expect(d.campaigns.find((c: any) => c.campaign_id === "11").unset_supported_types).toEqual([
      { type: "TEXT_ASSET_AUTOMATION", default: "opted in for Performance Max, opted out for Search" },
      { type: "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION", default: "opted in for Performance Max, opted out for Search" },
    ]);
    expect(d.campaigns.find((c: any) => c.campaign_id === "14").unset_supported_types).toEqual([]);
    expect(queries.at(-1)).toContain("campaign.status != 'REMOVED'");
  });

  it("filters by campaign and reports unknown ones", async () => {
    const d = (await kit.run("get_asset_automation_settings", { campaign_ids: ["11", "99"] })).data as any;
    expect(d).toMatchObject({ returned: 1, not_found: ["99"] });
    expect(queries.at(-1)).toContain("campaign.id IN (11, 99)");
    expect((await err("get_asset_automation_settings", { campaign_ids: ["99"] }))?.code).toBe("not_found");
  });
});

describe("update_asset_automation_settings", () => {
  it("is high impact, changes only the requested types and sends every other setting back unchanged", async () => {
    const r = await kit.run("update_asset_automation_settings", { campaign_id: "12", settings: [{ type: "GENERATE_IMAGE_ENHANCEMENT", status: "OPTED_OUT" }, { type: "TEXT_ASSET_AUTOMATION", status: "OPTED_IN" }] });
    expect(r.approval).toMatchObject({ risk: "high_impact", summary: 'Campaign "PMax" (PERFORMANCE_MAX): GENERATE_IMAGE_ENHANCEMENT OPTED_IN -> OPTED_OUT; TEXT_ASSET_AUTOMATION default -> OPTED_IN' });
    expect(r.approval?.change_set?.changes).toEqual([
      expect.objectContaining({ resource: "campaign", id: "12", field: "asset_automation.generate_image_enhancement", before: "OPTED_IN", after: "OPTED_OUT", effect: "pause" }),
      expect.objectContaining({ field: "asset_automation.text_asset_automation", before: null, after: "OPTED_IN", effect: "enable" }),
    ]);
    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(mutates[0]).toEqual([
      {
        campaignOperation: {
          update: {
            resourceName: `${C}/campaigns/12`,
            assetAutomationSettings: [
              { assetAutomationType: "AUTOMATED_VIDEO_CRAWL", assetAutomationStatus: "OPTED_IN", automatedVideoCrawlSetting: { automatedVideoCrawlInfos: [{ url: "https://shop.example", sourcePlatform: "LANDING_PAGE", enabled: true }] } },
              { assetAutomationType: "GENERATE_IMAGE_ENHANCEMENT", assetAutomationStatus: "OPTED_OUT" },
              { assetAutomationType: "TEXT_ASSET_AUTOMATION", assetAutomationStatus: "OPTED_IN" },
            ],
          },
          updateMask: "asset_automation_settings",
        },
      },
    ]);
    expect((done.result as any).settings.map((s: any) => [s.type, s.status])).toEqual([
      ["AUTOMATED_VIDEO_CRAWL", "OPTED_IN"],
      ["GENERATE_IMAGE_ENHANCEMENT", "OPTED_OUT"],
      ["TEXT_ASSET_AUTOMATION", "OPTED_IN"],
    ]);
    expect((await err("update_asset_automation_settings", { campaign_id: "12", settings: [{ type: "TEXT_ASSET_AUTOMATION", status: "OPTED_IN" }] }))?.message).toContain("Nothing would change");
  });

  it("opting out only is a normal write", async () => {
    const r = await kit.run("update_asset_automation_settings", { campaign_id: "12", settings: [{ type: "GENERATE_IMAGE_ENHANCEMENT", status: "OPTED_OUT" }] });
    expect(r.approval?.risk).toBe("write");
    expect((await approve(r.approval!.approval_id)).status).toBe("executed");
  });

  it("refuses types the campaign type does not support, removed and unknown campaigns", async () => {
    expect((await err("update_asset_automation_settings", { campaign_id: "11", settings: [{ type: "GENERATE_IMAGE_ENHANCEMENT", status: "OPTED_OUT" }] }))?.message).toContain("GENERATE_IMAGE_ENHANCEMENT is only for PERFORMANCE_MAX campaigns");
    expect((await err("update_asset_automation_settings", { campaign_id: "14", settings: [{ type: "TEXT_ASSET_AUTOMATION", status: "OPTED_IN" }] }))?.message).toContain("DISPLAY campaign");
    expect((await err("update_asset_automation_settings", { campaign_id: "13", settings: [{ type: "TEXT_ASSET_AUTOMATION", status: "OPTED_IN" }] }))?.message).toContain("removed");
    expect((await err("update_asset_automation_settings", { campaign_id: "99", settings: [{ type: "TEXT_ASSET_AUTOMATION", status: "OPTED_IN" }] }))?.code).toBe("not_found");
    expect((await err("update_asset_automation_settings", { campaign_id: "12", settings: [{ type: "GENERATE_LANDING_PAGE_PREVIEW", status: "OPTED_IN" }] }))?.code).toBe("invalid_argument");
    expect((await err("update_asset_automation_settings", { campaign_id: "12", settings: [{ type: "TEXT_ASSET_AUTOMATION", status: "OPTED_IN" }, { type: "TEXT_ASSET_AUTOMATION", status: "OPTED_OUT" }] }))?.code).toBe("invalid_argument");
    expect(mutates).toHaveLength(0);
  });

  it("keeps final URL expansion consistent with text automation, and needs the video rights confirmation", async () => {
    expect((await err("update_asset_automation_settings", { campaign_id: "11", settings: [{ type: "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION", status: "OPTED_IN" }, { type: "TEXT_ASSET_AUTOMATION", status: "OPTED_OUT" }] }))?.message).toContain("cannot be OPTED_IN while TEXT_ASSET_AUTOMATION is OPTED_OUT");
    campaigns[1]!.assetAutomationSettings = [{ assetAutomationType: "AUTOMATED_VIDEO_CRAWL", assetAutomationStatus: "OPTED_OUT" }];
    expect((await err("update_asset_automation_settings", { campaign_id: "12", settings: [{ type: "AUTOMATED_VIDEO_CRAWL", status: "OPTED_IN" }] }))?.message).toContain("confirm_video_rights");
    const r = await kit.run("update_asset_automation_settings", { campaign_id: "12", settings: [{ type: "AUTOMATED_VIDEO_CRAWL", status: "OPTED_IN" }], confirm_video_rights: true });
    expect((await approve(r.approval!.approval_id, kit.second)).status).toBe("executed");
    expect(mutates[0]![0].campaignOperation.update.assetAutomationSettings).toEqual([{ assetAutomationType: "AUTOMATED_VIDEO_CRAWL", assetAutomationStatus: "OPTED_IN" }]);
  });

  it("drift before approval applies nothing; an unconfirmed write is unknown_outcome", async () => {
    const r = await kit.run("update_asset_automation_settings", { campaign_id: "11", settings: [{ type: "TEXT_ASSET_AUTOMATION", status: "OPTED_IN" }] });
    campaigns[0]!.assetAutomationSettings = [{ assetAutomationType: "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION", assetAutomationStatus: "OPTED_OUT" }];
    expect((await approve(r.approval!.approval_id, kit.second)).status).toBe("failed");
    expect(mutates).toHaveLength(0);
    const r2 = await kit.run("update_asset_automation_settings", { campaign_id: "11", settings: [{ type: "TEXT_ASSET_AUTOMATION", status: "OPTED_IN" }] });
    dropWrites = true;
    expect((await approve(r2.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");
  });
});

// ---------------------------------------------------------------------------------- automated asset performance
describe("get_automated_asset_performance", () => {
  const met = (impressions: number, clicks: number, cost: number, conversions = 0) => ({ metrics: { impressions: String(impressions), clicks: String(clicks), costMicros: String(cost * 1e6), conversions, conversionsValue: 0 } });
  beforeEach(() => {
    aggregate.campaign = [
      { campaign: { id: "11", name: "Brand" }, campaignAggregateAssetView: { fieldType: "HEADLINE", assetSource: "AUTOMATICALLY_CREATED" }, asset: { id: "900", type: "TEXT", textAsset: { text: "Shop now" } }, ...met(500, 20, 10, 1) },
      { campaign: { id: "11", name: "Brand" }, campaignAggregateAssetView: { fieldType: "HEADLINE", assetSource: "ADVERTISER" }, asset: { id: "901", type: "TEXT", textAsset: { text: "Acme shoes" } }, ...met(800, 30, 15, 2) },
    ];
    aggregate.channel = [{ channelAggregateAssetView: { advertisingChannelType: "SEARCH", fieldType: "HEADLINE", assetSource: "AUTOMATICALLY_CREATED" }, asset: { id: "900", type: "TEXT", textAsset: { text: "Shop now" } }, ...met(700, 25, 12) }];
  });

  it("reports per campaign and per channel with the asset source", async () => {
    const d = (await kit.run("get_automated_asset_performance", { date_range: "LAST_7_DAYS" })).data as any;
    expect(d.rows).toHaveLength(3);
    expect(d.rows[0]).toMatchObject({ view: "campaign", campaign_id: "11", campaign_name: "Brand", channel_type: null, asset_id: "901", source: "ADVERTISER", field_type: "HEADLINE", content: { text: "Acme shoes" }, performance: { impressions: 800, clicks: 30, cost: 15, conversions: 2 } });
    expect(d.rows[1]).toMatchObject({ view: "channel", campaign_id: null, channel_type: "SEARCH", asset_id: "900", source: "AUTOMATICALLY_CREATED", asset_type: "TEXT" });
    expect(d.period).toBe("LAST_7_DAYS");
    expect(queries.some((q) => q.includes("FROM campaign_aggregate_asset_view") && q.includes("segments.date DURING LAST_7_DAYS"))).toBe(true);
    expect(queries.some((q) => q.includes("FROM channel_aggregate_asset_view"))).toBe(true);
  });

  it("filters by source, field type and campaign; one view only when asked", async () => {
    const d = (await kit.run("get_automated_asset_performance", { view: "campaign", source: "AUTOMATICALLY_CREATED", field_types: ["HEADLINE", "DESCRIPTION"], campaign_ids: ["11"], start_date: "2026-10-01", end_date: "2026-10-31", limit: 1 })).data as any;
    expect(d).toMatchObject({ period: "2026-10-01..2026-10-31", truncated: true });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("campaign_aggregate_asset_view.asset_source = 'AUTOMATICALLY_CREATED'");
    expect(queries[0]).toContain("campaign_aggregate_asset_view.field_type IN ('HEADLINE', 'DESCRIPTION')");
    expect(queries[0]).toContain(`campaign_aggregate_asset_view.campaign IN ('${C}/campaigns/11')`);
    expect(queries[0]).toContain("segments.date BETWEEN '2026-10-01' AND '2026-10-31'");
    expect((await err("get_automated_asset_performance", { start_date: "2026-10-01" }))?.code).toBe("invalid_argument");
    expect((await err("get_automated_asset_performance", { source: "GOOGLE" }))?.code).toBe("invalid_argument");
  });
});
