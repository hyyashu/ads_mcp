import type { InventoryTool } from "../src/inventory";

/**
 * Planning metadata for each inventory tool. This is NOT code that runs: it is the implementation plan
 * the tracking matrix is generated from.
 *
 * IMPORTANT: every `api` value was mapped from knowledge of the official APIs and has NOT yet been checked
 * against the current API version's documentation or a live test account (the docs sites were unreachable from the
 * build environment). Each mapping is verified when the tool is implemented, and any that turn out wrong are corrected here.
 *
 * Google Ads access model: developer tokens were sunset on 2026-09-09. API access levels (Test, Explorer, Basic,
 * Standard) now attach to the Google Cloud project that generated the OAuth credentials, so no developer-token
 * header is sent and the `permissions` below document the Cloud-project access level instead.
 */

export type Risk = "read" | "write" | "high_impact" | "destructive";
export type Feasibility =
  | "api" // a direct official API operation
  | "derived" // deterministic calculation over metrics fetched from the official API
  | "internal" // implemented by this server, no platform API involved
  | "needs_decision" // the name implies behaviour (e.g. stored profile) that conflicts with the data-minimization rule
  | "limitation_candidate"; // may not be achievable with the official API as named: must be resolved (implement a reduced form or document as a limitation)

export interface Mapping {
  domain: string;
  api: string;
  risk: Risk;
  feasibility: Feasibility;
  platformPermissions: string[];
  accountScope: "required" | "none";
  notes?: string;
}

const GADS = ["https://www.googleapis.com/auth/adwords"];
type Rule = [RegExp, Partial<Omit<Mapping, "risk">> & { api: string }];

// ---------------------------------------------------------------- Google Ads ----
const googleDomain: [RegExp, string][] = [
  [/pmax|asset_group|search_themes|audience_signal/, "performance_max"],
  [/demandgen/, "demand_gen"],
  [/display/, "display"],
  [/shopping|product_group|merchant/, "shopping"],
  [/app_ad|app_campaign/, "app"],
  [/youtube|video/, "video"],
  [/negative_keyword/, "negative_keywords"],
  [/keyword/, "keywords"],
  [/sitelink|callout|snippet|call_asset|business_name|extension|campaign_image|logo|asset/, "assets_extensions"],
  [/conversion/, "conversions"],
  [/label/, "labels"],
  [/bid|budget|frequency|schedule|dates|device|demographic|location|proximity|targeting|audience|placement|topic|language|reach/, "targeting_bidding_settings"],
  [/ad_group/, "ad_groups"],
  [/(^|_)ad(_|$)|ad_content|headline|description|creative/, "ads"],
  [/campaign/, "campaigns"],
  [/anomaly|wasted|optimize|benchmark|usage|performance|business_profile|infer|suggest|research|validate|help_user|select_/, "analysis_and_helpers"],
];

const googleApi: Rule[] = [
  // --- explicit special cases first
  [/^get_usage_status$/, { api: "Server usage metering (usage_counter) plus API quota state", feasibility: "internal", accountScope: "none", platformPermissions: [] }],
  [/^help_user_upload$/, { api: "Server-side guidance: asset specs and the HTTPS-URL upload path", feasibility: "internal", notes: "MCP has no binary upload channel: assets must be supplied as HTTPS URLs the server fetches and validates." }],
  [/^select_google_campaign_type$/, { api: "Deterministic decision logic over documented campaign-type eligibility", feasibility: "internal", accountScope: "none", platformPermissions: [] }],
  [/^get_benchmark_context$/, { api: "GAQL: the account's own history (prior periods) plus Google's official competitive metrics where exposed (impression share, lost impression share)", feasibility: "limitation_candidate", notes: "DECISION (owner, 2026-11-02): use account history and officially available competitive metrics only; never invent industry benchmarks. Which competitive metrics the API exposes for each campaign type must be verified against current docs; anything unavailable returns an explicit unsupported result." }],
  [/^infer_business_profile$/, { api: "GAQL: asset (business name, logo), customer, campaign final URLs; deterministic extraction", feasibility: "derived", notes: "No LLM inference: extracts only what the account already contains." }],
  [/^get_business_profile$/, { api: "GAQL: asset / customer_asset (BUSINESS_NAME, LOGO) plus customer (name, currency, time zone)", feasibility: "api", notes: "DECISION (owner, 2026-11-02): read supported business assets and account information from Google Ads. Nothing is stored by this server." }],
  [/^save_business_profile$/, { api: "AssetService + CustomerAssetService (BUSINESS_NAME, LOGO)", feasibility: "api", notes: "DECISION (owner, 2026-11-02): update supported Google Ads business assets only. No arbitrary profile storage." }],
  [/^suggest_ad_content$/, { api: "GAQL: ad_group_ad_asset performance, plus character-limit validation", feasibility: "derived", notes: "No generative copy: returns the account's best-performing existing headlines/descriptions and validates limits. Generative suggestions would be invented content." }],
  [/^validate_video$/, { api: "YouTube Data API v3 videos.list (existence, privacy status, embeddable, duration) plus Google Ads video asset requirements", feasibility: "limitation_candidate", platformPermissions: ["https://www.googleapis.com/auth/adwords"], notes: "DECISION (owner, 2026-11-02): integrate the YouTube Data API. Needs a YOUTUBE_API_KEY (public video metadata) and quota; Ads-side checks are limited to the documented asset requirements. Whether Google Ads exposes a pre-flight video validation call is unverified." }],
  [/^validate_and_prepare_assets$/, { api: "Fetch + validate asset URLs against Google Ads asset specs (type, dimensions, size, ratio)", feasibility: "internal", notes: "SSRF-hardened fetch required (block private ranges, redirects, size caps)." }],
  [/^research_keywords$/, { api: "KeywordPlanIdeaService.GenerateKeywordIdeas / GenerateKeywordHistoricalMetrics (verified against docs 2026-11-02; forecasts, if added, are KeywordPlanIdeaService.GenerateKeywordForecastMetrics, v24+ shape)", feasibility: "api" }],
  [/^resolve_google_locations$/, { api: "GeoTargetConstantService.SuggestGeoTargetConstants", feasibility: "api" }],
  [/^list_google_languages$/, { api: "GAQL: language_constant", feasibility: "api" }],
  [/^search_audiences$/, { api: "GAQL: user_interest, user_list, custom_audience, combined_audience, detailed_demographic, life_event", feasibility: "api" }],
  [/^get_reach_frequency$/, { api: "GAQL: campaign metrics (unique_users, average_impression_frequency_per_user)", feasibility: "api", notes: "Reach metrics exist only for some campaign types and date ranges. ReachPlanService is forecasting, not reporting." }],
  [/^get_pmax_conversion_goals$/, { api: "GAQL: campaign_conversion_goal, customer_conversion_goal", feasibility: "api" }],
  [/^get_merchant_center_links$/, { api: "GAQL: product_link (MERCHANT_CENTER)", feasibility: "api" }],
  [/^link_merchant_center$/, { api: "ProductLinkService.CreateProductLink", feasibility: "api", notes: "The Merchant Center side may need to accept the link: the call can succeed while the link stays pending." }],
  [/^unlink_merchant_center$/, { api: "ProductLinkService.RemoveProductLink", feasibility: "api" }],
  [/^get_ad_policy_violations$/, { api: "GAQL: ad_group_ad.policy_summary", feasibility: "api" }],
  [/^get_campaign_tracking$/, { api: "GAQL: campaign (tracking_url_template, final_url_suffix, url_custom_parameters)", feasibility: "api" }],
  [/^analyze_search_terms$/, { api: "GAQL: search_term_view metrics, deterministic classification", feasibility: "derived" }],
  [/^analyze_pmax_search_terms$/, { api: "GAQL: campaign_search_term_view / campaign_search_term_insight", feasibility: "derived" }],
  [/^analyze_pmax_search_categories$/, { api: "GAQL: campaign_search_term_insight (categories)", feasibility: "derived" }],
  [/^analyze_wasted_spend$/, { api: "GAQL: campaign/ad_group/keyword/search_term metrics, deterministic thresholds", feasibility: "derived" }],
  [/^explain_performance_anomaly$/, { api: "GAQL: metrics by date/segment, deterministic period comparison", feasibility: "derived" }],
  [/^optimize_budget_allocation$/, { api: "GAQL: campaign_budget + campaign metrics, deterministic reallocation math", feasibility: "derived" }],
  [/^discover_existing_assets$/, { api: "GAQL: asset, asset_group_asset, campaign_asset, customer_asset", feasibility: "api" }],
  // --- corrections found by auditing the generic rules (must come before them)
  [/^(add|remove)_negative_keywords$/, { api: "CampaignCriterionService / AdGroupCriterionService (negative keyword criteria)", feasibility: "api" }],
  [/^add_negative_keywords_to_list$/, { api: "SharedCriterionService.MutateSharedCriteria (KEYWORD in a NEGATIVE_KEYWORDS shared set)", feasibility: "api" }],
  [/^(add|get|update|remove)_pmax_audience_signals?$/, { api: "AssetGroupSignalService (audience signals) / GAQL: asset_group_signal", feasibility: "api", notes: "Audience signals are hints for Performance Max, not hard targeting." }],
  [/^(add|remove)_app_ad_asset$/, { api: "AdGroupAdService.MutateAdGroupAds (AppAdInfo asset fields) / AssetService", feasibility: "api", notes: "App ad assets are fields on the ad itself: adding or removing one is a replace-style update of the ad. Verify exact semantics against the current API." }],
  [/^remove_display_ad$/, { api: "AdGroupAdService.MutateAdGroupAds (remove)", feasibility: "api" }],
  [/^update_demandgen_channel_controls$/, { api: "AdGroupService.MutateAdGroups (demand_gen_ad_group_settings.channel_controls)", feasibility: "api", notes: "Field location varies by API version: verify before implementing." }],
  // --- generic families
  [/^(get|list)_campaign_performance$|^get_ad_performance$|^get_placement_performance$|^get_pmax_asset_performance$/, { api: "GAQL: campaign / ad_group_ad / group_placement_view / asset_group_asset metrics", feasibility: "api" }],
  [/^(pause|resume)_campaign$|^update_campaign(_dates)?$|^bulk_update_campaign_status$/, { api: "CampaignService.MutateCampaigns", feasibility: "api" }],
  [/^(pause|resume)_ad_group$|^update_ad_group_settings$|^bulk_update_ad_group_status$/, { api: "AdGroupService.MutateAdGroups", feasibility: "api" }],
  [/^update_ad_(content|headlines|descriptions)$/, { api: "AdService.MutateAds (update responsive_search_ad by customers/{c}/ads/{ad_id}; verified against docs 2026-11-02)", feasibility: "api", notes: "MutateAds does not support TextAd, ExpandedDynamicSearchAd, GmailAd or ImageAd; automatically created assets cannot be removed through it. Headline/description character limits are not stated in the reachable docs, so plan() runs validate_only instead of hard-coding them." }],
  [/^create_ad$/, { api: "AdGroupAdService.MutateAdGroupAds (create; responsive search ad, always PAUSED)", feasibility: "api", notes: "Responsive search ads only. Counts 3-15 headlines, 2-4 descriptions confirmed in docs; limits validated by Google via validate_only." }],
  [/^(pause|resume)_ad$|^bulk_update_ad_status$|^update_ad_(content|headlines|descriptions)$|^create_ad$|^remove_ad$|^update_display_ad_creative$|^add_display_ad$|^add_demandgen_ad$|^add_shopping_product_ad$/, { api: "AdGroupAdService.MutateAdGroupAds (+ AssetService for responsive assets)", feasibility: "api", notes: "Ads cannot be edited in place on many types: updates may require create-new + remove-old." }],
  [/^add_(search|display|demandgen|shopping)_ad_group$|^add_display_ad_group$|^add_demandgen_ad_group$|^remove_(display_)?ad_group$/, { api: "AdGroupService.MutateAdGroups", feasibility: "api" }],
  [/keyword(s)?$|^add_display_keywords$|^remove_keywords$|^update_keyword$|^bulk_update_keyword_status$/, { api: "AdGroupCriterionService.MutateAdGroupCriteria (keyword)", feasibility: "api" }],
  [/negative_keyword_list|attach_negative/, { api: "SharedSetService + SharedCriterionService + CampaignSharedSetService (NEGATIVE_KEYWORDS)", feasibility: "api" }],
  [/^(add|remove)_negative_keywords$/, { api: "CampaignCriterionService / AdGroupCriterionService (negative keyword)", feasibility: "api" }],
  [/sitelink|callout|snippet|call_asset|business_name|campaign_image|logo/, { api: "AssetService + CampaignAssetService / CustomerAssetService", feasibility: "api" }],
  [/_label$|^create_label$|^list_labels$|^get_campaign_labels$/, { api: "LabelService + CampaignLabelService (GAQL: label, campaign_label)", feasibility: "api" }],
  [/conversion_action/, { api: "ConversionActionService (GAQL: conversion_action)", feasibility: "api" }],
  [/bid_strategy|device_bid_modifiers/, { api: "BiddingStrategyService / CampaignService / AdGroupBidModifierService / CampaignBidModifierService", feasibility: "api" }],
  [/frequency_caps/, { api: "CampaignService (frequency caps) / GAQL: campaign.frequency_caps", feasibility: "api", notes: "Frequency caps apply to a subset of campaign types (Display, Video, Demand Gen)." }],
  [/ad_schedule|campaign_schedule/, { api: "CampaignCriterionService (AD_SCHEDULE)", feasibility: "api" }],
  [/location_targeting|campaign_proximity|campaign_targeting/, { api: "CampaignCriterionService (LOCATION, PROXIMITY, LANGUAGE) / GAQL: campaign_criterion", feasibility: "api" }],
  [/demographics/, { api: "AdGroupCriterionService (AGE_RANGE, GENDER, PARENTAL_STATUS, INCOME_RANGE)", feasibility: "api" }],
  [/audience|placement|topics?(_|$)|criteria/, { api: "AdGroupCriterionService / CampaignCriterionService (USER_LIST, USER_INTEREST, PLACEMENT, TOPIC)", feasibility: "api" }],
  [/pmax_(asset_group|audience_signal|search_themes)|asset_group|audience_signal|search_themes/, { api: "AssetGroupService + AssetGroupAssetService + AssetGroupSignalService + AssetGroupListingGroupFilterService", feasibility: "api" }],
  [/product_group|shopping_settings/, { api: "AdGroupCriterionService (LISTING_GROUP) / CampaignService (shopping_setting)", feasibility: "api" }],
  [/^create_(search|shopping|pmax|demandgen|app|youtube)_campaign$/, { api: "CampaignBudgetService + CampaignService + AdGroupService + (type-specific) in one GoogleAdsService.Mutate batch", feasibility: "api", notes: "Created PAUSED. Must be one atomic Mutate with temporary resource names so a partial failure cannot leave orphans." }],
  [/^get_(ad_creative|campaign_dates|campaign_structure|ad_group_settings|display_ad_group_settings|demandgen_(audiences|channel_controls)|ad_group_(audiences|demographics|device_bid_modifiers)|display_(audiences|demographics|frequency_caps|keywords|placements|topics)|negative_keyword_list|pmax_(asset_groups|audience_signals|search_themes)|product_groups|asset_group_listing_filters|shopping_settings|campaign_targeting|campaign_frequency_caps)$|^list_(campaigns|call_assets|campaign_extensions|conversion_actions|pmax_asset_group_(assets|images))$/, { api: "GAQL query on the corresponding resource", feasibility: "api" }],
];

// ----------------------------------------------------------------- Meta Ads ----
const metaDomain: [RegExp, string][] = [
  [/catalog|product/, "catalogs_products"],
  [/pixel|lead_form/, "pixels_leads"],
  [/audience|targeting/, "audiences_targeting"],
  [/app_|promotable_apps/, "app_promotion"],
  [/creative|dco|carousel|image|video/, "creatives"],
  [/_ad_set|adset/, "ad_sets"],
  [/(^|_)ads?$|meta_ad$/, "ads"],
  [/campaign/, "campaigns"],
  [/performance|anomaly|waste|fatigue|budget|placements|analyze|diagnose|detect|optimize|validate|discover|select/, "analysis_and_helpers"],
  [/page|instagram/, "assets"],
];

const META_READ = ["ads_read"];
const META_WRITE = ["ads_management"];
const metaApi: Rule[] = [
  [/^select_meta_campaign_type$/, { api: "Deterministic decision logic over documented objectives (ODAX)", feasibility: "internal", accountScope: "none", platformPermissions: [] }],
  [/^validate_and_prepare_meta_assets$/, { api: "Fetch + validate asset URLs against Meta creative specs (format, dimensions, ratio, size)", feasibility: "internal", notes: "SSRF-hardened fetch required. Validation only: uploads belong to the creation tools." }],
  [/^get_meta_audience_insights$/, { api: "No dedicated public Audience Insights API confirmed. Candidates: /{act}/reachestimate, /{act}/delivery_estimate, /{act}/targetingsuggestions, insights breakdowns", feasibility: "limitation_candidate", notes: "DECISION (owner, 2026-11-02): implement only officially supported capabilities; return explicit unsupported errors for the rest and document the limitation. Which endpoints are supported must be verified against current Marketing API docs." }],
  [/^get_meta_lead_form_submissions$/, { api: "GET /{form_id}/leads", feasibility: "api", platformPermissions: ["leads_retrieval", "pages_show_list", "pages_read_engagement"], notes: "Returns personal data (names, emails, phones). Needs a Page access token. Never stored; excluded from audit; consider masking by default." }],
  [/^list_meta_pages$/, { api: "GET /me/accounts or /{act}/promote_pages", feasibility: "api", platformPermissions: ["pages_show_list", "business_management"] }],
  [/^list_meta_instagram_accounts$/, { api: "GET /{act}/instagram_accounts", feasibility: "api", platformPermissions: ["ads_read", "instagram_basic"] }],
  [/^list_meta_promotable_apps$/, { api: "GET /{act}/advertisable_applications", feasibility: "api" }],
  [/^discover_meta_assets$/, { api: "Aggregates pages, Instagram accounts, pixels, catalogs, custom audiences via their list endpoints", feasibility: "api" }],
  [/^list_meta_campaigns$/, { api: "GET /{act}/campaigns", feasibility: "api" }],
  [/^list_meta_ad_sets$/, { api: "GET /{act}/adsets", feasibility: "api" }],
  [/^list_meta_ads$/, { api: "GET /{act}/ads", feasibility: "api" }],
  [/^get_meta_campaign_details$/, { api: "GET /{campaign_id}?fields=...", feasibility: "api" }],
  [/^get_meta_(campaign|adset)_performance$/, { api: "GET /{act}/insights (level=campaign|adset)", feasibility: "api", notes: "Large ranges need async report runs; respect rate limits (BUC)." }],
  [/^get_meta_ad_creatives$/, { api: "GET /{ad_id}/adcreatives or /{act}/adcreatives", feasibility: "api" }],
  [/^get_meta_app_(campaigns|adsets|creatives|summary)$/, { api: "Campaign/ad set/creative reads filtered to app-promotion objectives, plus insights", feasibility: "api" }],
  [/^list_meta_custom_audiences$/, { api: "GET /{act}/customaudiences", feasibility: "api" }],
  [/^get_meta_audience_insights$/, { api: "see above", feasibility: "limitation_candidate" }],
  [/^(browse|search)_meta_targeting$/, { api: "GET /{act}/targetingbrowse | /{act}/targetingsearch | /search?type=adTargetingCategory", feasibility: "api" }],
  [/^list_meta_catalogs$/, { api: "GET /{business_id}/owned_product_catalogs or /{act}/product_catalogs", feasibility: "api", platformPermissions: ["catalog_management", "ads_read"] }],
  [/^list_meta_product_sets$/, { api: "GET /{catalog_id}/product_sets", feasibility: "api", platformPermissions: ["catalog_management"] }],
  [/^list_meta_products$/, { api: "GET /{catalog_id}/products", feasibility: "api", platformPermissions: ["catalog_management"] }],
  [/^create_meta_product_set$/, { api: "POST /{catalog_id}/product_sets", feasibility: "api", platformPermissions: ["catalog_management"] }],
  [/^list_meta_pixels$/, { api: "GET /{act}/adspixels", feasibility: "api" }],
  [/^get_meta_pixel_stats$/, { api: "GET /{pixel_id}/stats", feasibility: "api" }],
  [/^list_meta_lead_forms$/, { api: "GET /{page_id}/leadgen_forms", feasibility: "api", platformPermissions: ["leads_retrieval", "pages_show_list"] }],
  [/^get_meta_product_performance$/, { api: "GET /{act}/insights with breakdowns=product_id", feasibility: "api" }],
  [/^analyze_meta_ad_performance$/, { api: "GET /{act}/insights (level=ad), deterministic ranking", feasibility: "derived" }],
  [/^analyze_meta_audiences$/, { api: "GET /{act}/customaudiences (size, delivery status) + insights breakdowns (age, gender)", feasibility: "derived" }],
  [/^analyze_meta_catalog_performance$|^get_meta_product_performance$/, { api: "GET /{act}/insights with product breakdowns, deterministic ranking", feasibility: "derived" }],
  [/^analyze_meta_wasted_spend$|^detect_meta_catalog_waste$/, { api: "GET /{act}/insights, deterministic thresholds", feasibility: "derived" }],
  [/^compare_meta_catalog_product_sets$/, { api: "GET /{act}/insights per product set, deterministic comparison", feasibility: "derived" }],
  [/^detect_meta_creative_fatigue$/, { api: "GET /{act}/insights level=ad (frequency, CTR trend over time)", feasibility: "derived" }],
  [/^diagnose_meta_catalog_funnel$/, { api: "GET /{act}/insights (view content, add to cart, purchase actions) + /{catalog}/diagnostics", feasibility: "derived" }],
  [/^explain_meta_anomaly$/, { api: "GET /{act}/insights time series + breakdowns, deterministic period comparison", feasibility: "derived" }],
  [/^optimize_meta_budget$/, { api: "GET /{act}/insights + campaign/ad set budgets, deterministic reallocation math", feasibility: "derived" }],
  [/^optimize_meta_placements$/, { api: "GET /{act}/insights breakdowns=publisher_platform,platform_position", feasibility: "derived" }],
  [/^validate_catalog_readiness$/, { api: "GET /{catalog}/diagnostics + product feed field checks", feasibility: "derived", platformPermissions: ["catalog_management"] }],
  [/^(pause|resume)_meta_campaign$/, { api: "POST /{campaign_id} status=PAUSED|ACTIVE", feasibility: "api" }],
  [/^duplicate_meta_campaign$/, { api: "POST /{campaign_id}/copies", feasibility: "api", notes: "Large copies are asynchronous. Copies must be created PAUSED." }],
  [/^create_meta_(image|video|carousel|catalog)_campaign$/, { api: "POST /{act}/campaigns, /adsets, /adcreatives (+ /adimages or /advideos uploads), /ads", feasibility: "api", notes: "Multi-step and NOT atomic on Meta: partial failure handling and cleanup are required. Everything is created PAUSED." }],
  [/^create_meta_dco_ad$/, { api: "POST /{act}/adcreatives (asset_feed_spec) + POST /{act}/ads", feasibility: "api", notes: "Dynamic creative requires an ad set with dynamic creative enabled." }],
  [/^add_meta_(ad|catalog_ad)$/, { api: "POST /{act}/adcreatives + POST /{act}/ads", feasibility: "api" }],
  [/^add_meta_(ad_set|catalog_ad_set)$/, { api: "POST /{act}/adsets", feasibility: "api" }],
  [/^update_meta_(campaign|catalog_campaign)$/, { api: "POST /{campaign_id}", feasibility: "api" }],
  [/^update_meta_(ad_set|catalog_ad_set)$/, { api: "POST /{adset_id}", feasibility: "api" }],
  [/^update_meta_(ad|catalog_ad)$/, { api: "POST /{ad_id}", feasibility: "api", notes: "Creative content is immutable once an ad is created: creative changes need a new creative." }],
];

const googleHighImpact = /^create_(search|shopping|pmax|demandgen|app|youtube)_campaign$|^resume_(campaign|ad_group|ad)$|^update_campaign$|^update_bid_strategy$|^bulk_update_|^replace_demandgen_audiences$|^(create|update)_conversion_action$|^link_merchant_center$|^set_campaign_ad_schedule$|^set_.*device_bid_modifiers$|^update_campaign_dates$/;
const metaHighImpact = /^create_meta_.*_campaign$|^duplicate_meta_campaign$|^resume_meta_campaign$|^update_meta_(campaign|catalog_campaign|ad_set|catalog_ad_set)$|^add_meta_(ad_set|catalog_ad_set)$/;

function firstMatch<T>(rules: [RegExp, T][], name: string, fallback: T): T {
  for (const [re, v] of rules) if (re.test(name)) return v;
  return fallback;
}

export function mapTool(t: InventoryTool): Mapping {
  const google = t.platform === "google_ads";
  const domain = firstMatch(google ? googleDomain : metaDomain, t.name, "other");

  const rule = (google ? googleApi : metaApi).find(([re]) => re.test(t.name))?.[1];
  const api = rule?.api ?? "UNMAPPED: needs API mapping";
  const feasibility: Feasibility = rule?.feasibility ?? "api";

  let risk: Risk = "read";
  if (t.action_type === "Delete") risk = "destructive";
  else if (t.action_type === "Create" || t.action_type === "Update") risk = (google ? googleHighImpact : metaHighImpact).test(t.name) ? "high_impact" : "write";

  const defaultPerms = google ? GADS : t.modifies_data ? META_WRITE : META_READ;
  return {
    domain,
    api,
    risk,
    feasibility,
    platformPermissions: rule?.platformPermissions ?? defaultPerms,
    accountScope: rule?.accountScope ?? "required",
    ...(rule?.notes ? { notes: rule.notes } : {}),
  };
}
