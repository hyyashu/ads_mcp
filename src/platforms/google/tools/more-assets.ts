import { z } from "zod";
import type { AnyTool } from "../../../mcp/tool";
import { ToolError } from "../../../mcp/errors";
import { type Change, textChange } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { isRealDate, pick } from "../gaql";
import { type Link, type LinkContent, type LinkFieldType, type Scope, type ScopedLinks, clean, linkOp, ownerRef, readCampaignAssets, readLinks, scopeFields, scopeMsg, scopeOk, scopeOutput, scopeResult, url, where } from "./asset-writes";
import { accountId, idSchema, str, toMicros } from "./common";
import { getAssetAutomationSettings, getAutomatedAssetPerformance, getLeadFormSubmissions, updateAssetAutomationSettings } from "./more-assets-automation";
import { stateWrite, temp } from "./write-kit";

/**
 * Google Ads tools: add_promotion_asset, add_price_asset, add_lead_form_asset, get_lead_form_submissions, add_business_message_asset, get_asset_automation_settings, update_asset_automation_settings, get_automated_asset_performance.
 * Approved by the owner on 2026-11-11 (inventory/tool-registry.json); API surfaces in inventory/mapping.ts.
 *
 * Promotion, price, lead form and business message assets, checked against the v26 reference (PromotionAsset, PriceAsset,
 * PriceOffering, LeadFormAsset, LeadFormField, LeadFormCustomQuestionField, WebhookDelivery, BusinessMessageAsset and its
 * provider infos) and the asset overview guide (which levels each field type links at). Each tool creates the asset and its
 * link in one atomic GoogleAdsService.Mutate (temporary asset id), like asset-writes.ts, and confirms by re-reading the links.
 * Limits enforced here are the ones the reference states; other text limits are enforced by Google (its error is returned).
 */

// ------------------------------------------------------------------------------------------------- shared input parts
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, "not a real date");
const currency = z.string().regex(/^[A-Z]{3}$/, "three-letter ISO 4217 currency code, e.g. USD");
const money = z.object({ amount: z.number().min(0).max(1e9), currency_code: currency });
/** BCP 47 language tag (PromotionAsset/PriceAsset language_code), e.g. en, en-US, pt-BR. */
const language = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a BCP 47 language tag such as en or en-US");
const moneyBody = (m: z.infer<typeof money>) => ({ amountMicros: String(toMicros(m.amount)), currencyCode: m.currency_code });
const moneyText = (m: z.infer<typeof money>) => `${m.amount} ${m.currency_code}`;
const low = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Ops creating one asset (temporary id -1) and its link at the scope's level, plus the change set and summary. */
function createOps(ads: GoogleAdsClient, s: Scope, snap: ScopedLinks, fieldType: LinkFieldType, body: Row, label: string, kind: string): { summary: string; changes: Change[]; ops: Row[] } {
  const tmp = temp(ads, "assets", 1);
  // Neutral like add_sitelinks: a new extension does not raise spend or bids by itself.
  const change = textChange(ownerRef(ads, s, snap), fieldType.toLowerCase(), null, label);
  return {
    summary: `Add ${kind} to ${where(s, snap)}${s.level === "account" ? " (every campaign that does not exclude account-level ones)" : ""}: ${label}`,
    changes: [change],
    ops: [{ assetOperation: { create: { resourceName: tmp, ...body } } }, linkOp(ads, s, "-1", fieldType, "create")],
  };
}
/** Refuses when an asset with the same content is already linked there (enabled or paused). */
function refuseDuplicate(s: Scope, snap: ScopedLinks, key: string, kind: string) {
  const dup = snap.links.find((l) => l.key === key);
  if (dup) throw new ToolError("invalid_argument", `Nothing would change: an identical ${kind} (asset ${dup.asset_id}, ${dup.status.toLowerCase()}) is already linked to ${where(s, snap)}.`);
}
/** The new link with this content: one that was not there before. */
const created = (before: ScopedLinks, after: ScopedLinks, key: string): Link | undefined => after.links.find((l) => l.key === key && !before.links.some((b) => b.asset_id === l.asset_id));
const createdOutput = z.object({ ...scopeOutput, asset_id: z.string(), label: z.string() });

// ------------------------------------------------------------------------------------------------------- promotion
/** PromotionExtensionOccasion values (v26 enum, without UNSPECIFIED/UNKNOWN). */
const OCCASIONS = ["NEW_YEARS", "CHINESE_NEW_YEAR", "VALENTINES_DAY", "EASTER", "MOTHERS_DAY", "FATHERS_DAY", "LABOR_DAY", "BACK_TO_SCHOOL", "HALLOWEEN", "BLACK_FRIDAY", "CYBER_MONDAY", "CHRISTMAS", "BOXING_DAY", "INDEPENDENCE_DAY", "NATIONAL_DAY", "END_OF_SEASON", "WINTER_SALE", "SUMMER_SALE", "FALL_SALE", "SPRING_SALE", "RAMADAN", "EID_AL_FITR", "EID_AL_ADHA", "SINGLES_DAY", "WOMENS_DAY", "HOLI", "PARENTS_DAY", "ST_NICHOLAS_DAY", "CARNIVAL", "EPIPHANY", "ROSH_HASHANAH", "PASSOVER", "HANUKKAH", "DIWALI", "NAVRATRI", "SONGKRAN", "YEAR_END_GIFT"] as const;
const PROMO_FIELDS = ["asset.final_urls", "asset.promotion_asset.promotion_target", "asset.promotion_asset.percent_off", "asset.promotion_asset.money_amount_off.amount_micros", "asset.promotion_asset.money_amount_off.currency_code", "asset.promotion_asset.promotion_code", "asset.promotion_asset.orders_over_amount.amount_micros", "asset.promotion_asset.start_date", "asset.promotion_asset.end_date"];
interface PromoId {
  target: string;
  percent: string | null;
  money: string | null;
  currency: string | null;
  code: string | null;
  orders: string | null;
  start: string | null;
  end: string | null;
  url: string | null;
}
const promoKey = (p: PromoId) => {
  const discount = p.percent ? `${Number(p.percent) / 10_000}% off` : `${Number(p.money ?? 0) / 1e6} ${p.currency ?? ""} off`;
  const trigger = p.code ? ` with code ${p.code}` : p.orders ? ` on orders over ${Number(p.orders) / 1e6}` : "";
  return {
    key: [low(p.target), p.percent ?? "", p.money ?? "", p.currency ?? "", low(p.code), p.orders ?? "", p.start ?? "", p.end ?? "", low(p.url)].join("|"),
    label: `${discount} ${p.target}${trigger}${p.start || p.end ? ` (${p.start ?? "…"} to ${p.end ?? "…"})` : ""}`,
  };
};
const promoContent: LinkContent = {
  fields: PROMO_FIELDS,
  key: (r) =>
    promoKey({
      target: str(r, "asset.promotion_asset.promotion_target") ?? "",
      percent: str(r, "asset.promotion_asset.percent_off"),
      money: str(r, "asset.promotion_asset.money_amount_off.amount_micros"),
      currency: str(r, "asset.promotion_asset.money_amount_off.currency_code"),
      code: str(r, "asset.promotion_asset.promotion_code"),
      orders: str(r, "asset.promotion_asset.orders_over_amount.amount_micros"),
      start: str(r, "asset.promotion_asset.start_date"),
      end: str(r, "asset.promotion_asset.end_date"),
      url: ((pick(r, "asset.final_urls") as string[] | undefined) ?? [])[0] ?? null,
    }),
};
const promotionInput = z
  .object({
    account_id: accountId,
    ...scopeFields,
    promotion_target: clean(100).describe("Required. What the promotion is for, e.g. 'Running shoes' (freeform)."),
    percent_off: z.number().gt(0).max(100).optional().describe("Percent discount, e.g. 20 for 20%. Give this or money_amount_off."),
    money_amount_off: money.optional().describe("Amount off, e.g. {amount: 10, currency_code: 'USD'}. Give this or percent_off."),
    discount_modifier: z.enum(["UP_TO"]).optional().describe("UP_TO shows the discount as 'up to'."),
    occasion: z.enum(OCCASIONS).optional().describe("The occasion; the redemption window must then fall within the occasion's dates (Google checks)."),
    promotion_code: clean(100).optional().describe("A code shoppers enter. Not with orders_over_amount."),
    orders_over_amount: money.optional().describe("Minimum order value for the promotion. Not with promotion_code."),
    language_code: language.optional(),
    start_date: date.optional().describe("First day the asset may serve (YYYY-MM-DD)."),
    end_date: date.optional().describe("Last day the asset may serve (YYYY-MM-DD)."),
    redemption_start_date: date.optional(),
    redemption_end_date: date.optional(),
    final_url: url.describe("Landing page of the promotion."),
  })
  .refine(scopeOk, scopeMsg)
  .refine((v) => (v.percent_off === undefined) !== (v.money_amount_off === undefined), { message: "give exactly one of percent_off or money_amount_off" })
  .refine((v) => v.promotion_code === undefined || v.orders_over_amount === undefined, { message: "give promotion_code or orders_over_amount, not both (Google allows one promotion trigger)" })
  .refine((v) => !v.start_date || !v.end_date || v.start_date <= v.end_date, { message: "start_date must not be after end_date" })
  .refine((v) => !v.redemption_start_date || !v.redemption_end_date || v.redemption_start_date <= v.redemption_end_date, { message: "redemption_start_date must not be after redemption_end_date" })
  .refine((v) => v.money_amount_off === undefined || v.money_amount_off.amount > 0, { message: "money_amount_off must be more than 0" });
type PromotionArgs = z.infer<typeof promotionInput>;
const promoOfArgs = (a: PromotionArgs) =>
  promoKey({
    target: a.promotion_target,
    percent: a.percent_off !== undefined ? String(Math.round(a.percent_off * 10_000)) : null,
    money: a.money_amount_off ? String(toMicros(a.money_amount_off.amount)) : null,
    currency: a.money_amount_off?.currency_code ?? null,
    code: a.promotion_code ?? null,
    orders: a.orders_over_amount ? String(toMicros(a.orders_over_amount.amount)) : null,
    start: a.start_date ?? null,
    end: a.end_date ?? null,
    url: a.final_url,
  });

export const addPromotionAsset = stateWrite({
  name: "add_promotion_asset",
  title: "Add promotion asset",
  risk: "write",
  description:
    "Creates a promotion asset (for example '20% off running shoes' or '$10 off orders over $50') and links it to a campaign (default), an ad group or the whole account, after approval. Give the promotion target, exactly one of percent_off or money_amount_off, optionally an occasion, a promotion code or a minimum order amount (one trigger, not both), language, serving dates, redemption dates and the final URL. An identical promotion already linked there is refused. Created atomically and confirmed by re-reading.",
  input: promotionInput,
  output: createdOutput,
  read: (a, ads) => readLinks(ads, a, "PROMOTION", promoContent),
  build: (a, s, ads) => {
    const id = promoOfArgs(a);
    refuseDuplicate(a, s, id.key, "promotion");
    const promotionAsset: Row = {
      promotionTarget: a.promotion_target,
      ...(a.percent_off !== undefined ? { percentOff: String(Math.round(a.percent_off * 10_000)) } : { moneyAmountOff: moneyBody(a.money_amount_off!) }),
      ...(a.discount_modifier ? { discountModifier: a.discount_modifier } : {}),
      ...(a.occasion ? { occasion: a.occasion } : {}),
      ...(a.promotion_code ? { promotionCode: a.promotion_code } : {}),
      ...(a.orders_over_amount ? { ordersOverAmount: moneyBody(a.orders_over_amount) } : {}),
      ...(a.language_code ? { languageCode: a.language_code } : {}),
      ...(a.start_date ? { startDate: a.start_date } : {}),
      ...(a.end_date ? { endDate: a.end_date } : {}),
      ...(a.redemption_start_date ? { redemptionStartDate: a.redemption_start_date } : {}),
      ...(a.redemption_end_date ? { redemptionEndDate: a.redemption_end_date } : {}),
    };
    return createOps(ads, a, s, "PROMOTION", { finalUrls: [a.final_url], promotionAsset }, id.label, "a promotion");
  },
  landed: (a, before, after) => !!created(before, after, promoOfArgs(a).key),
  result: (a, after, _res, before) => {
    const l = created(before, after, promoOfArgs(a).key)!;
    return { ...scopeResult(a), asset_id: l.asset_id, label: l.label };
  },
});

// ----------------------------------------------------------------------------------------------------------- price
const PRICE_TYPES = ["BRANDS", "EVENTS", "LOCATIONS", "NEIGHBORHOODS", "PRODUCT_CATEGORIES", "PRODUCT_TIERS", "SERVICES", "SERVICE_CATEGORIES", "SERVICE_TIERS"] as const;
const PRICE_QUALIFIERS = ["FROM", "UP_TO", "AVERAGE"] as const;
const PRICE_UNITS = ["PER_HOUR", "PER_DAY", "PER_WEEK", "PER_MONTH", "PER_YEAR", "PER_NIGHT"] as const;
interface Offer {
  header: string;
  micros: string;
  currency: string;
  unit: string | null;
}
const priceKey = (type: string, qualifier: string | null, offers: Offer[]) => ({
  key: [type, qualifier ?? "", ...offers.map((o) => `${low(o.header)}=${o.micros}${o.currency}/${o.unit ?? ""}`)].join("|"),
  label: `${type.toLowerCase().replace(/_/g, " ")}${qualifier ? ` (${qualifier.toLowerCase().replace("_", " ")})` : ""}: ${offers.map((o) => `${o.header} ${Number(o.micros) / 1e6} ${o.currency}${o.unit ? ` ${o.unit.toLowerCase().replace("_", " ")}` : ""}`).join(", ")}`,
});
const priceContent: LinkContent = {
  fields: ["asset.price_asset.type", "asset.price_asset.price_qualifier", "asset.price_asset.price_offerings"],
  key: (r) => {
    const offers = ((pick(r, "asset.price_asset.price_offerings") as Row[] | undefined) ?? []).map((o) => ({ header: String(o.header ?? ""), micros: String(pick(o, "price.amount_micros") ?? "0"), currency: String(pick(o, "price.currency_code") ?? ""), unit: (o.unit as string | undefined) ?? null }));
    return priceKey(str(r, "asset.price_asset.type") ?? "", str(r, "asset.price_asset.price_qualifier"), offers);
  },
};
const offering = z.object({
  header: clean(25).describe("1 to 25 characters."),
  description: clean(25).describe("1 to 25 characters."),
  price: money,
  unit: z.enum(PRICE_UNITS).optional(),
  final_url: url,
  final_mobile_url: url.optional(),
});
const priceInput = z
  .object({
    account_id: accountId,
    ...scopeFields,
    type: z.enum(PRICE_TYPES),
    price_qualifier: z.enum(PRICE_QUALIFIERS).optional().describe("FROM, UP_TO or AVERAGE, shown before the prices."),
    language_code: language.describe("Required. BCP 47 language tag, e.g. en."),
    price_offerings: z.array(offering).min(3).max(8).describe("3 to 8 offerings (Google's limit)."),
  })
  .refine(scopeOk, scopeMsg);
type PriceArgs = z.infer<typeof priceInput>;
const priceOfArgs = (a: PriceArgs) => priceKey(a.type, a.price_qualifier ?? null, a.price_offerings.map((o) => ({ header: o.header, micros: String(toMicros(o.price.amount)), currency: o.price.currency_code, unit: o.unit ?? null })));

export const addPriceAsset = stateWrite({
  name: "add_price_asset",
  title: "Add price asset",
  risk: "write",
  description:
    "Creates a price asset (a list of 3 to 8 priced offerings, each with a header and description of 1 to 25 characters, a price with currency, an optional unit such as per month, and a final URL) and links it to a campaign (default), an ad group or the whole account, after approval. Give the type (for example SERVICES or PRODUCT_TIERS), an optional price qualifier (FROM, UP_TO, AVERAGE) and the language. An identical price asset already linked there is refused. Created atomically and confirmed by re-reading.",
  input: priceInput,
  output: createdOutput,
  read: (a, ads) => readLinks(ads, a, "PRICE", priceContent),
  build: (a, s, ads) => {
    const id = priceOfArgs(a);
    refuseDuplicate(a, s, id.key, "price asset");
    const priceAsset: Row = {
      type: a.type,
      ...(a.price_qualifier ? { priceQualifier: a.price_qualifier } : {}),
      languageCode: a.language_code,
      priceOfferings: a.price_offerings.map((o) => ({ header: o.header, description: o.description, price: moneyBody(o.price), ...(o.unit ? { unit: o.unit } : {}), finalUrl: o.final_url, ...(o.final_mobile_url ? { finalMobileUrl: o.final_mobile_url } : {}) })),
    };
    return createOps(ads, a, s, "PRICE", { priceAsset }, id.label, "a price asset");
  },
  landed: (a, before, after) => !!created(before, after, priceOfArgs(a).key),
  result: (a, after, _res, before) => {
    const l = created(before, after, priceOfArgs(a).key)!;
    return { ...scopeResult(a), asset_id: l.asset_id, label: l.label };
  },
});

// ------------------------------------------------------------------------------------------------------- lead form
const LEAD_CTA = ["LEARN_MORE", "GET_QUOTE", "APPLY_NOW", "SIGN_UP", "CONTACT_US", "SUBSCRIBE", "DOWNLOAD", "BOOK_NOW", "GET_OFFER", "REGISTER", "GET_INFO", "REQUEST_DEMO", "JOIN_NOW", "GET_STARTED"] as const;
const POST_SUBMIT_CTA = ["VISIT_SITE", "DOWNLOAD", "LEARN_MORE", "SHOP_NOW"] as const;
/** LeadFormFieldUserInputType values (v26 enum, without UNSPECIFIED/UNKNOWN). */
export const LEAD_INPUT_TYPES = [
  "FULL_NAME", "EMAIL", "PHONE_NUMBER", "POSTAL_CODE", "STREET_ADDRESS", "CITY", "REGION", "COUNTRY", "WORK_EMAIL", "COMPANY_NAME", "WORK_PHONE", "JOB_TITLE",
  "GOVERNMENT_ISSUED_ID_CPF_BR", "GOVERNMENT_ISSUED_ID_DNI_AR", "GOVERNMENT_ISSUED_ID_DNI_PE", "GOVERNMENT_ISSUED_ID_RUT_CL", "GOVERNMENT_ISSUED_ID_CC_CO", "GOVERNMENT_ISSUED_ID_CI_EC", "GOVERNMENT_ISSUED_ID_RFC_MX",
  "FIRST_NAME", "LAST_NAME", "VEHICLE_MODEL", "VEHICLE_TYPE", "PREFERRED_DEALERSHIP", "VEHICLE_PURCHASE_TIMELINE", "VEHICLE_OWNERSHIP", "VEHICLE_PAYMENT_TYPE", "VEHICLE_CONDITION", "COMPANY_SIZE", "ANNUAL_SALES", "YEARS_IN_BUSINESS", "JOB_DEPARTMENT", "JOB_ROLE",
  "OVER_18_AGE", "OVER_19_AGE", "OVER_20_AGE", "OVER_21_AGE", "OVER_22_AGE", "OVER_23_AGE", "OVER_24_AGE", "OVER_25_AGE", "OVER_26_AGE", "OVER_27_AGE", "OVER_28_AGE", "OVER_29_AGE", "OVER_30_AGE", "OVER_31_AGE", "OVER_32_AGE", "OVER_33_AGE", "OVER_34_AGE", "OVER_35_AGE", "OVER_36_AGE", "OVER_37_AGE", "OVER_38_AGE", "OVER_39_AGE", "OVER_40_AGE", "OVER_41_AGE", "OVER_42_AGE", "OVER_43_AGE", "OVER_44_AGE", "OVER_45_AGE", "OVER_46_AGE", "OVER_47_AGE", "OVER_48_AGE", "OVER_49_AGE", "OVER_50_AGE", "OVER_51_AGE", "OVER_52_AGE", "OVER_53_AGE", "OVER_54_AGE", "OVER_55_AGE", "OVER_56_AGE", "OVER_57_AGE", "OVER_58_AGE", "OVER_59_AGE", "OVER_60_AGE", "OVER_61_AGE", "OVER_62_AGE", "OVER_63_AGE", "OVER_64_AGE", "OVER_65_AGE",
  "EDUCATION_PROGRAM", "EDUCATION_COURSE", "PRODUCT", "SERVICE", "OFFER", "CATEGORY", "PREFERRED_CONTACT_METHOD", "PREFERRED_LOCATION", "PREFERRED_CONTACT_TIME", "PURCHASE_TIMELINE", "YEARS_OF_EXPERIENCE", "JOB_INDUSTRY", "LEVEL_OF_EDUCATION", "PROPERTY_TYPE", "REALTOR_HELP_GOAL", "PROPERTY_COMMUNITY", "PRICE_RANGE", "NUMBER_OF_BEDROOMS", "FURNISHED_PROPERTY", "PETS_ALLOWED_PROPERTY", "NEXT_PLANNED_PURCHASE", "EVENT_SIGNUP_INTEREST", "PREFERRED_SHOPPING_PLACES", "FAVORITE_BRAND", "TRANSPORTATION_COMMERCIAL_LICENSE_TYPE", "EVENT_BOOKING_INTEREST", "DESTINATION_COUNTRY", "DESTINATION_CITY", "DEPARTURE_COUNTRY", "DEPARTURE_CITY", "DEPARTURE_DATE", "RETURN_DATE", "NUMBER_OF_TRAVELERS", "TRAVEL_BUDGET", "TRAVEL_ACCOMMODATION",
] as const;
/**
 * Contact details; every other input type is a pre-vetted qualifying question. LeadFormField: answer choices "can be set only
 * for pre-vetted question fields"; AssetError LEAD_FORM_LEGACY_QUALIFYING_QUESTIONS_DISALLOWED: those questions "cannot be in
 * the same Lead Form as custom questions".
 */
const CONTACT_TYPES = new Set<string>(["FULL_NAME", "FIRST_NAME", "LAST_NAME", "EMAIL", "WORK_EMAIL", "PHONE_NUMBER", "WORK_PHONE", "POSTAL_CODE", "STREET_ADDRESS", "CITY", "REGION", "COUNTRY", "COMPANY_NAME", "JOB_TITLE", ...LEAD_INPUT_TYPES.filter((t) => t.startsWith("GOVERNMENT_ISSUED_ID_"))]);
/** LeadFormSingleChoiceAnswers: minimum 2, maximum 12 answers. */
const answers = z.array(clean(100)).min(2).max(12);
const leadContent: LinkContent = {
  fields: ["asset.lead_form_asset.business_name", "asset.lead_form_asset.headline", "asset.lead_form_asset.description"],
  key: (r) => leadKey(str(r, "asset.lead_form_asset.headline") ?? "", str(r, "asset.lead_form_asset.business_name") ?? "", str(r, "asset.lead_form_asset.description") ?? ""),
};
const leadKey = (headline: string, business: string, description: string) => ({ key: [low(headline), low(business), low(description)].join("|"), label: `"${headline}" by ${business}` });
const leadInput = z
  .object({
    account_id: accountId,
    campaign_id: idSchema.describe("Lead forms link to campaigns only."),
    business_name: clean(100).describe("Required. The business being advertised."),
    headline: clean(100).describe("Required. Headline of the expanded form."),
    description: clean(500).describe("Required. What the form asks for or offers."),
    privacy_policy_url: url.describe("Required. How the collected data is handled."),
    call_to_action_type: z.enum(LEAD_CTA).describe("Required. Button text that opens the form."),
    call_to_action_description: clean(100).describe("Required. What people get when they open the form."),
    final_url: url.describe("The asset's final URL (Google's lead form example sets one)."),
    fields: z
      .array(z.object({ input_type: z.enum(LEAD_INPUT_TYPES), single_choice_answers: answers.optional().describe("2 to 12 answers; only for pre-vetted questions (for example PREFERRED_CONTACT_TIME), not for contact details.") }))
      .min(1)
      .max(LEAD_INPUT_TYPES.length)
      .describe("The form's fields in order, e.g. FULL_NAME, EMAIL, PHONE_NUMBER."),
    custom_questions: z
      .array(z.object({ question: clean(300), single_choice_answers: answers.optional() }))
      .max(5)
      .optional()
      .describe("Up to 5 custom qualifying questions (Google's limit); free text unless answers are given."),
    post_submit_headline: clean(100).optional(),
    post_submit_description: clean(500).optional(),
    post_submit_call_to_action_type: z.enum(POST_SUBMIT_CTA).optional(),
    webhook: z
      .object({
        url: url.refine((u) => /^https:\/\//i.test(u), "the webhook must use https"),
        google_key: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters").describe("Secret Google includes in each webhook call so your endpoint can check it (google_secret)."),
      })
      .optional()
      .describe("Optional: also deliver leads to this https endpoint (one webhook per form, Google's limit)."),
  })
  .refine((v) => new Set(v.fields.map((f) => f.input_type)).size === v.fields.length, { message: "each field input_type at most once" })
  .refine((v) => v.fields.every((f) => !f.single_choice_answers || !CONTACT_TYPES.has(f.input_type)), { message: "answer choices are only for pre-vetted questions, not for contact details such as EMAIL" })
  .refine((v) => !v.custom_questions?.length || v.fields.every((f) => CONTACT_TYPES.has(f.input_type)), { message: "pre-vetted questions (for example PREFERRED_CONTACT_TIME) cannot be in the same lead form as custom questions (Google's LEAD_FORM_LEGACY_QUALIFYING_QUESTIONS_DISALLOWED)" });
/** Payload schema version used by Google's own lead form example (add_lead_form_asset, v24 samples). */
const WEBHOOK_SCHEMA_VERSION = "3";

export const addLeadFormAsset = stateWrite({
  name: "add_lead_form_asset",
  title: "Add lead form asset",
  risk: "write",
  description:
    "Creates a lead form asset and links it to a campaign (lead forms link at campaign level only), after approval. Give the business name, headline, description, privacy policy URL, call to action type and description, final URL and the fields in order (for example FULL_NAME, EMAIL, PHONE_NUMBER; pre-vetted questions may have 2 to 12 answer choices), optionally up to 5 custom questions (not together with pre-vetted questions), a post-submit headline, description and call to action, and an https webhook (url and google_key) to receive leads. Lead forms need the account to have accepted Google's lead form terms in the Google Ads web interface and an eligible account and campaign (Search or Performance Max); if not, Google's error is returned and nothing is created. Leads are read with get_lead_form_submissions. An identical form already on the campaign is refused. Created atomically and confirmed by re-reading.",
  input: leadInput,
  output: z.object({ campaign_id: z.string(), asset_id: z.string(), label: z.string() }),
  read: (a, ads) => readCampaignAssets(ads, a.campaign_id, "LEAD_FORM", leadContent),
  build: (a, s, ads) => {
    const scope: Scope = { level: "campaign", campaign_id: a.campaign_id };
    const id = leadKey(a.headline, a.business_name, a.description);
    refuseDuplicate(scope, s, id.key, "lead form");
    const leadFormAsset: Row = {
      businessName: a.business_name,
      headline: a.headline,
      description: a.description,
      privacyPolicyUrl: a.privacy_policy_url,
      callToActionType: a.call_to_action_type,
      callToActionDescription: a.call_to_action_description,
      fields: a.fields.map((f) => ({ inputType: f.input_type, ...(f.single_choice_answers ? { singleChoiceAnswers: { answers: f.single_choice_answers } } : {}) })),
      ...(a.custom_questions?.length ? { customQuestionFields: a.custom_questions.map((q) => ({ customQuestionText: q.question, ...(q.single_choice_answers ? { singleChoiceAnswers: { answers: q.single_choice_answers } } : {}) })) } : {}),
      ...(a.post_submit_headline ? { postSubmitHeadline: a.post_submit_headline } : {}),
      ...(a.post_submit_description ? { postSubmitDescription: a.post_submit_description } : {}),
      ...(a.post_submit_call_to_action_type ? { postSubmitCallToActionType: a.post_submit_call_to_action_type } : {}),
      ...(a.webhook ? { deliveryMethods: [{ webhook: { advertiserWebhookUrl: a.webhook.url, googleSecret: a.webhook.google_key, payloadSchemaVersion: WEBHOOK_SCHEMA_VERSION } }] } : {}),
    };
    const b = createOps(ads, scope, s, "LEAD_FORM", { finalUrls: [a.final_url], leadFormAsset }, id.label, "a lead form");
    // The webhook secret never goes into the summary or the change set; the URL does, so the approver sees where leads go.
    const extra = `${a.fields.length} field(s): ${a.fields.map((f) => f.input_type).join(", ")}${a.custom_questions?.length ? `; ${a.custom_questions.length} custom question(s)` : ""}${a.webhook ? `; leads also sent to ${a.webhook.url}` : ""}`;
    return { ...b, summary: `${b.summary} (${extra})` };
  },
  landed: (a, before, after) => !!created(before, after, leadKey(a.headline, a.business_name, a.description).key),
  result: (a, after, _res, before) => {
    const l = created(before, after, leadKey(a.headline, a.business_name, a.description).key)!;
    return { campaign_id: a.campaign_id, asset_id: l.asset_id, label: l.label };
  },
});

// ------------------------------------------------------------------------------------------------ business message
const PROVIDERS = ["WHATSAPP", "FACEBOOK_MESSENGER", "ZALO", "LINE", "SMS"] as const;
const BM_CTA = ["APPLY_NOW", "BOOK_NOW", "CONTACT_US", "GET_INFO", "GET_OFFER", "GET_QUOTE", "GET_STARTED", "LEARN_MORE"] as const;
const country = z.string().regex(/^[A-Za-z]{2}$/, "two-letter country code, e.g. US (sent upper case)");
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{5,25}$/, "a phone number");
const BM_FIELDS = [
  "asset.business_message_asset.message_provider",
  "asset.business_message_asset.starter_message",
  "asset.business_message_asset.whatsapp_info.country_code",
  "asset.business_message_asset.whatsapp_info.phone_number",
  "asset.business_message_asset.sms_info.country_code",
  "asset.business_message_asset.sms_info.phone_number",
  "asset.business_message_asset.facebook_messenger_info.page_name",
  "asset.business_message_asset.line_info.line_id",
  "asset.business_message_asset.zalo_info.oa_id",
  "asset.business_message_asset.zalo_info.custom_name",
];
/** Identity: provider | account on that provider | starter message. The provider comes first so the one-active-per-provider rule can read it. */
const bmKey = (provider: string, account: string, starter: string) => ({ key: `${provider}|${low(account).replace(/[^\p{L}\p{N}@+_.]/gu, "")}|${low(starter)}`, label: `${provider} ${account}: "${starter}"` });
const bmAccount = (provider: string, get: (f: string) => string | null): string => {
  if (provider === "WHATSAPP" || provider === "SMS") {
    const p = provider === "WHATSAPP" ? "whatsapp_info" : "sms_info";
    return `${(get(`${p}.country_code`) ?? "").toUpperCase()} ${get(`${p}.phone_number`) ?? ""}`;
  }
  if (provider === "FACEBOOK_MESSENGER") return get("facebook_messenger_info.page_name") ?? "";
  if (provider === "LINE") return get("line_info.line_id") ?? "";
  return get("zalo_info.oa_id") ?? get("zalo_info.custom_name") ?? "";
};
const bmContent: LinkContent = {
  fields: BM_FIELDS,
  key: (r) => {
    const provider = str(r, "asset.business_message_asset.message_provider") ?? "";
    return bmKey(provider, bmAccount(provider, (f) => str(r, `asset.business_message_asset.${f}`)), str(r, "asset.business_message_asset.starter_message") ?? "");
  },
};
const bmInput = z
  .object({
    account_id: accountId,
    ...scopeFields,
    message_provider: z.enum(PROVIDERS),
    whatsapp: z.object({ country_code: country, phone_number: phone }).optional().describe("Required for WHATSAPP."),
    sms: z.object({ country_code: country, phone_number: phone }).optional().describe("Required for SMS."),
    facebook_messenger: z.object({ page_name: clean(100) }).optional().describe("Required for FACEBOOK_MESSENGER."),
    line: z.object({ line_id: z.string().trim().regex(/^@[^\s\u0000-\u001f\u007f]{1,99}$/, "a LINE id starting with @") }).optional().describe("Required for LINE."),
    zalo: z
      .object({ oa_id: z.string().regex(/^\d{1,20}$/).optional(), custom_name: clean(100).optional() })
      .refine((z_) => (z_.oa_id === undefined) !== (z_.custom_name === undefined), "give oa_id or custom_name")
      .optional()
      .describe("Required for ZALO: the official account id or custom name."),
    starter_message: clean(200).describe("Required. Welcome message that prompts the person to start the conversation."),
    call_to_action: z.object({ selection: z.enum(BM_CTA), description: clean(100).describe("e.g. 'Message us for a quote'") }),
  })
  .refine(scopeOk, scopeMsg)
  .refine(
    (v) => {
      const given = (["whatsapp", "sms", "facebook_messenger", "line", "zalo"] as const).filter((k) => v[k] !== undefined);
      const want = { WHATSAPP: "whatsapp", SMS: "sms", FACEBOOK_MESSENGER: "facebook_messenger", LINE: "line", ZALO: "zalo" }[v.message_provider];
      return given.length === 1 && given[0] === want;
    },
    { message: "give exactly the provider details that match message_provider (whatsapp, sms, facebook_messenger, line or zalo)" },
  );
type BmArgs = z.infer<typeof bmInput>;
const bmOfArgs = (a: BmArgs) => {
  const account = a.whatsapp ? `${a.whatsapp.country_code.toUpperCase()} ${a.whatsapp.phone_number}` : a.sms ? `${a.sms.country_code.toUpperCase()} ${a.sms.phone_number}` : a.facebook_messenger ? a.facebook_messenger.page_name : a.line ? a.line.line_id : (a.zalo?.oa_id ?? a.zalo?.custom_name ?? "");
  return bmKey(a.message_provider, account, a.starter_message);
};

export const addBusinessMessageAsset = stateWrite({
  name: "add_business_message_asset",
  title: "Add business message asset",
  risk: "write",
  description:
    "Creates a business message (click-to-message) asset and links it to a campaign (default), an ad group or the whole account, after approval: people tap it to message the business on WhatsApp (country code and phone number), Facebook Messenger (page name), Zalo (official account id or custom name), LINE (id starting with @) or SMS (country code and phone number). Give the provider and its details, a starter (welcome) message and a call to action (selection and description). Google allows only one active business message asset per provider at each level, so a level that already has an enabled one for that provider is refused (remove that link first). The feature is allowlisted by Google: without access Google's error is returned and nothing is created. Created atomically and confirmed by re-reading.",
  input: bmInput,
  output: createdOutput,
  read: (a, ads) => readLinks(ads, a, "BUSINESS_MESSAGE", bmContent),
  build: (a, s, ads) => {
    const id = bmOfArgs(a);
    refuseDuplicate(a, s, id.key, "business message asset");
    const active = s.links.find((l) => l.status === "ENABLED" && l.key.split("|")[0] === a.message_provider);
    if (active) throw new ToolError("invalid_argument", `${where(a, s)} already has an active ${a.message_provider} business message asset (asset ${active.asset_id}: ${active.label}). Google allows only one active business message asset per provider at each level; remove that link first.`);
    const info: Row =
      a.message_provider === "WHATSAPP"
        ? { whatsappInfo: { countryCode: a.whatsapp!.country_code.toUpperCase(), phoneNumber: a.whatsapp!.phone_number } }
        : a.message_provider === "SMS"
          ? { smsInfo: { countryCode: a.sms!.country_code.toUpperCase(), phoneNumber: a.sms!.phone_number } }
          : a.message_provider === "FACEBOOK_MESSENGER"
            ? { facebookMessengerInfo: { pageName: a.facebook_messenger!.page_name } }
            : a.message_provider === "LINE"
              ? { lineInfo: { lineId: a.line!.line_id } }
              : { zaloInfo: a.zalo!.oa_id ? { oaId: a.zalo!.oa_id } : { customName: a.zalo!.custom_name } };
    const businessMessageAsset: Row = { messageProvider: a.message_provider, ...info, starterMessage: a.starter_message, callToAction: { callToActionSelection: a.call_to_action.selection, callToActionDescription: a.call_to_action.description } };
    return createOps(ads, a, s, "BUSINESS_MESSAGE", { businessMessageAsset }, id.label, "a business message asset");
  },
  landed: (a, before, after) => !!created(before, after, bmOfArgs(a).key),
  result: (a, after, _res, before) => {
    const l = created(before, after, bmOfArgs(a).key)!;
    return { ...scopeResult(a), asset_id: l.asset_id, label: l.label };
  },
});

export const moreAssetTools: AnyTool[] = [addPromotionAsset, addPriceAsset, addLeadFormAsset, getLeadFormSubmissions, addBusinessMessageAsset, getAssetAutomationSettings, updateAssetAutomationSettings, getAutomatedAssetPerformance] as AnyTool[];
