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
  [/^list_accounts$/, { api: "This server's connected_account table (no platform call)", feasibility: "internal", accountScope: "none", platformPermissions: [] }],
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
  [/^get_keyword_performance$/, { api: "GAQL: keyword_view with ad_group_criterion quality_info and position_estimates (v26 field reference)", feasibility: "api" }],
  [/^get_segment_performance$/, { api: "GAQL: campaign (device, hour, day_of_week segments), geographic_view (country, region, city), age_range_view, gender_view (v26 field reference)", feasibility: "api" }],
  [/^remove_negative_keywords_from_list$/, { api: "SharedCriterionService remove (sharedCriteria/{shared_set_id}~{criterion_id})", feasibility: "api" }],
  [/^detach_negative_keyword_list_from_campaign$/, { api: "CampaignSharedSetService remove (campaignSharedSets/{campaign_id}~{shared_set_id})", feasibility: "api" }],
  [/^analyze_search_terms$/, { api: "GAQL: search_term_view metrics, deterministic classification", feasibility: "derived" }],
  [/^analyze_pmax_search_terms$/, { api: "GAQL: campaign_search_term_view / campaign_search_term_insight", feasibility: "derived" }],
  [/^analyze_pmax_search_categories$/, { api: "GAQL: campaign_search_term_insight (categories)", feasibility: "derived" }],
  [/^analyze_wasted_spend$/, { api: "GAQL: campaign/ad_group/keyword/search_term metrics, deterministic thresholds", feasibility: "derived" }],
  [/^explain_performance_anomaly$/, { api: "GAQL: metrics by date/segment, deterministic period comparison", feasibility: "derived" }],
  [/^optimize_budget_allocation$/, { api: "GAQL: campaign_budget + campaign metrics, deterministic reallocation math", feasibility: "derived" }],
  [/^discover_existing_assets$/, { api: "GAQL: asset, asset_group_asset, campaign_asset, customer_asset", feasibility: "api" }],
  [/^link_existing_assets$/, { api: "GAQL: asset, customer_asset, campaign_asset, ad_group_asset; CustomerAssetService / CampaignAssetService / AdGroupAssetService (creates links only, no AssetService create)", feasibility: "api", notes: "DECISION (owner, 2026-11-11): attach existing library assets (sitelink, callout, structured snippet, call) at account, campaign or ad group level. Business name is excluded: a campaign has one, set by add_business_name_asset." }],
  [/^update_extension_asset$/, { api: "AssetService update (sitelink, callout, structured snippet, call; update mask), GAQL: asset, customer_asset, campaign_asset, ad_group_asset for where it is used", feasibility: "api", notes: "DECISION (owner, 2026-11-11): edit mutable extension assets in place. Automatically created assets are refused." }],
  [/^exclude_account_assets_from_campaign$/, { api: "CampaignService update: campaign.excluded_parent_asset_field_types", feasibility: "api" }],
  [/^get_asset_performance$/, { api: "GAQL: customer_asset, campaign_asset, ad_group_asset with metrics, segmented by segments.asset_interaction_target.interaction_on_this_asset", feasibility: "api" }],
  [/^list_recommendations$/, { api: "GAQL: recommendation (type, impact, campaign)", feasibility: "api" }],
  [/^apply_recommendations$/, { api: "RecommendationService.ApplyRecommendation", feasibility: "api" }],
  [/^dismiss_recommendations$/, { api: "RecommendationService.DismissRecommendation", feasibility: "api" }],
  [/^get_change_history$/, { api: "GAQL: change_event (who, when, what, old/new values; last 30 days) and change_status", feasibility: "api" }],
  [/^get_auction_insights$/, { api: "GAQL: customer / campaign / ad_group with metrics.auction_insight_search_* segmented by segments.auction_insight_domain (access may be restricted by Google)", feasibility: "api" }],
  [/^upload_click_conversions$/, { api: "ConversionUploadService.UploadClickConversions (gclid / gbraid / wbraid)", feasibility: "api" }],
  [/^upload_call_conversions$/, { api: "ConversionUploadService.UploadCallConversions", feasibility: "api" }],
  [/^upload_conversion_adjustments$/, { api: "ConversionAdjustmentUploadService.UploadConversionAdjustments (retraction, restatement)", feasibility: "api" }],
  [/^get_conversion_goals$/, { api: "GAQL: customer_conversion_goal, campaign_conversion_goal, conversion_goal_campaign_config", feasibility: "api" }],
  [/^update_conversion_goals$/, { api: "CustomerConversionGoalService / CampaignConversionGoalService (biddable)", feasibility: "api" }],
  [/^list_conversion_value_rules$/, { api: "GAQL: conversion_value_rule", feasibility: "api" }],
  [/^create_conversion_value_rule$/, { api: "ConversionValueRuleService create", feasibility: "api" }],
  [/^remove_conversion_value_rule$/, { api: "ConversionValueRuleService remove", feasibility: "api" }],
  [/^get_account_exclusions$/, { api: "GAQL: customer_negative_criterion", feasibility: "api" }],
  [/^add_account_exclusions$/, { api: "CustomerNegativeCriterionService create (placements, YouTube channels and videos, mobile app categories, content labels)", feasibility: "api" }],
  [/^remove_account_exclusions$/, { api: "CustomerNegativeCriterionService remove", feasibility: "api" }],
  [/^update_tracking_settings$/, { api: "CampaignService / AdGroupService update: tracking_url_template, final_url_suffix, url_custom_parameters", feasibility: "api" }],
  [/^set_auto_tagging$/, { api: "CustomerService.MutateCustomer: customer.auto_tagging_enabled", feasibility: "api" }],
  [/^set_location_bid_modifiers$/, { api: "CampaignCriterionService update: bid_modifier on LOCATION criteria", feasibility: "api" }],
  [/^get_entity_labels$/, { api: "GAQL: ad_group_label, ad_group_ad_label, ad_group_criterion_label", feasibility: "api" }],
  [/^add_entity_labels$/, { api: "AdGroupLabelService / AdGroupAdLabelService / AdGroupCriterionLabelService create", feasibility: "api" }],
  [/^remove_entity_labels$/, { api: "AdGroupLabelService / AdGroupAdLabelService / AdGroupCriterionLabelService remove", feasibility: "api" }],
  [/^list_bid_strategies$/, { api: "GAQL: bidding_strategy and accessible_bidding_strategy (portfolio strategies, including ones a manager account shares) and the campaigns using them", feasibility: "api" }],
  [/^create_bid_strategy$/, { api: "BiddingStrategyService create (portfolio)", feasibility: "api" }],
  [/^assign_bid_strategy$/, { api: "CampaignService update: campaign.bidding_strategy, or a standard scheme to detach (campaign_bidding_strategy union)", feasibility: "api" }],
  [/^remove_bid_strategy$/, { api: "BiddingStrategyService remove", feasibility: "api" }],
  [/^list_bidding_adjustments$/, { api: "GAQL: bidding_seasonality_adjustment, bidding_data_exclusion", feasibility: "api" }],
  [/^create_seasonality_adjustment$/, { api: "BiddingSeasonalityAdjustmentService create", feasibility: "api" }],
  [/^create_data_exclusion$/, { api: "BiddingDataExclusionService create", feasibility: "api" }],
  [/^remove_bidding_adjustment$/, { api: "BiddingSeasonalityAdjustmentService / BiddingDataExclusionService remove", feasibility: "api" }],
  [/^list_experiments$/, { api: "GAQL: experiment, experiment_arm", feasibility: "api" }],
  [/^create_experiment$/, { api: "ExperimentService + ExperimentArmService create (control and treatment arms, in-design campaign)", feasibility: "api" }],
  [/^schedule_experiment$/, { api: "ExperimentService.ScheduleExperiment (long-running; status read back via GAQL)", feasibility: "api" }],
  [/^end_experiment$/, { api: "ExperimentService.EndExperiment", feasibility: "api" }],
  [/^promote_experiment$/, { api: "ExperimentService.PromoteExperiment (long-running; promote_status read back via GAQL)", feasibility: "api" }],
  [/^list_user_lists$/, { api: "GAQL: user_list (type, size, membership status)", feasibility: "api" }],
  [/^create_remarketing_list$/, { api: "UserListService create (rule-based website visitors)", feasibility: "api" }],
  [/^create_customer_match_list$/, { api: "UserListService create (CRM-based)", feasibility: "api" }],
  [/^upload_customer_match_members$/, { api: "OfflineUserDataJobService create, add operations, run (SHA-256 hashed emails and phone numbers)", feasibility: "api" }],
  [/^remove_user_list$/, { api: "UserListService remove; GAQL ad_group_criterion, campaign_criterion, audience and user_list to check where the list is used", feasibility: "api" }],
  [/^add_promotion_asset$/, { api: "AssetService (PromotionAsset) + CustomerAsset / CampaignAsset / AdGroupAsset", feasibility: "api" }],
  [/^add_price_asset$/, { api: "AssetService (PriceAsset) + CustomerAsset / CampaignAsset / AdGroupAsset", feasibility: "api" }],
  [/^add_lead_form_asset$/, { api: "AssetService (LeadFormAsset) + CampaignAsset", feasibility: "api" }],
  [/^get_lead_form_submissions$/, { api: "GAQL: lead_form_submission_data", feasibility: "api" }],
  [/^add_business_message_asset$/, { api: "AssetService (BusinessMessageAsset) + CustomerAsset / CampaignAsset / AdGroupAsset", feasibility: "api" }],
  [/^get_asset_automation_settings$/, { api: "GAQL: campaign.asset_automation_settings", feasibility: "api" }],
  [/^update_asset_automation_settings$/, { api: "CampaignService update: campaign.asset_automation_settings", feasibility: "api" }],
  [/^get_automated_asset_performance$/, { api: "GAQL: campaign_aggregate_asset_view, channel_aggregate_asset_view (asset source: advertiser or automatically created)", feasibility: "api" }],
  [/^request_policy_exemption$/, { api: "AdGroupAdService / AdGroupCriterionService with policy_validation_parameter.exempt_policy_violation_keys", feasibility: "api" }],
  [/^list_account_users$/, { api: "GAQL: customer_user_access, customer_user_access_invitation", feasibility: "api" }],
  [/^update_user_access$/, { api: "CustomerUserAccessService update (access_role)", feasibility: "api" }],
  [/^remove_user_access$/, { api: "CustomerUserAccessService remove", feasibility: "api" }],
  [/^invite_user$/, { api: "CustomerUserAccessInvitationService create", feasibility: "api" }],
  [/^get_billing_info$/, { api: "GAQL: billing_setup, account_budget; InvoiceService.ListInvoices", feasibility: "api" }],
  [/^create_client_account$/, { api: "CustomerService.CreateCustomerClient (manager account)", feasibility: "api" }],
  [/^link_client_account$/, { api: "CustomerClientLinkService create (manager sends a link invitation)", feasibility: "api" }],
  [/^get_local_services_leads$/, { api: "GAQL: local_services_lead, local_services_lead_conversation", feasibility: "api" }],
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
const META_PAGES = ["ads_read", "pages_show_list"];
const META_CREATE = ["ads_management", "pages_manage_ads"];
const META_LEADS = ["ads_read", "leads_retrieval", "pages_show_list", "pages_read_engagement"];
const META_WRITE = ["ads_management"];
const META_CATALOG = ["ads_read", "business_management", "catalog_management"];
const metaApi: Rule[] = [
  [/^select_meta_campaign_type$/, { api: "Static ODAX objective table (Outcome-Driven Ad Experiences) + GET /{act}/campaigns, /adsets, /adspixels for the combinations the account already uses (v27.0)", feasibility: "derived", platformPermissions: META_READ, notes: "Meta's docs publish no objective -> optimization_goal table, so none is invented: the account's own accepted combinations are listed." }],
  [/^validate_and_prepare_meta_assets$/, { api: "Checks against Meta Media Requirements (Instagram Ads API reference); images via the SSRF-safe fetcher or GET /{act}/adimages, videos via GET /{act}/advideos (v27.0)", feasibility: "internal", platformPermissions: META_READ, notes: "Validation only: nothing is uploaded. Facebook-only placements have no documented hard limits beyond 600px width; video duration must be supplied (not a documented advideos field)." }],
  [/^get_meta_audience_insights$/, { api: "GET /{act}/insights or /{campaign_id}/insights with breakdowns age, gender, age+gender, country, region, publisher_platform, publisher_platform+platform_position, device_platform (v27.0)", feasibility: "api", platformPermissions: META_READ, notes: "DECISION (owner, 2026-11-02) applied: only the officially supported capability (delivery breakdowns of the account's own ads). Meta has no public audience-research API; region returns no off-Meta conversions." }],
  [/^get_meta_lead_form_submissions$/, { api: "GET /{form_id}/leads (fields created_time,id,ad_id,form_id,field_data; filtering time_created) with a Page access token; Page on /{act}/promote_pages, form on /{page_id}/leadgen_forms (v27.0)", feasibility: "api", platformPermissions: META_LEADS, notes: "Personal data: only requested fields returned, at most 200 leads per call, never stored or logged." }],
  [/^list_meta_pages$/, { api: "GET /{act}/promote_pages (v27.0)", feasibility: "api", platformPermissions: META_PAGES, notes: "Creating ads for a Page later also needs pages_manage_ads (promote_pages reference)." }],
  [/^list_meta_instagram_accounts$/, { api: "GET /{act}/instagram_accounts (v27.0)", feasibility: "api", platformPermissions: ["ads_read", "instagram_basic", "pages_read_engagement"] }],
  [/^list_meta_promotable_apps$/, { api: "GET /{act}/advertisable_applications (fields id,name) (v27.0)", feasibility: "api", platformPermissions: META_READ }],
  [/^discover_meta_assets$/, { api: "GET /{act}/adimages + GET /{act}/advideos (v27.0)", feasibility: "api", platformPermissions: META_READ, notes: "The image and video library, for reuse in creatives (batch 4). Pages, Instagram accounts, pixels and audiences have their own list tools." }],
  [/^list_meta_campaigns$/, { api: "GET /{act}/campaigns", feasibility: "api" }],
  [/^list_meta_ad_sets$/, { api: "GET /{act}/adsets, or GET /{campaign_id}/adsets after an ownership check (v27.0; never requests meta_moment_maker_spec)", feasibility: "api", platformPermissions: META_READ }],
  [/^list_meta_ads$/, { api: "GET /{act}/ads, or GET /{campaign_id}/ads | /{adset_id}/ads after an ownership check (fields incl. creative{id,name}, issues_info; v27.0)", feasibility: "api", platformPermissions: META_READ }],
  [/^get_meta_campaign_details$/, { api: "GET /{campaign_id} (ownership checked) + GET /{campaign_id}/adsets and /ads (effective_status counts) (v27.0)", feasibility: "api", platformPermissions: META_READ }],
  [/^get_meta_(campaign|adset)_performance$/, { api: "GET /{act}/insights or /{campaign_id}/insights (level=campaign|adset, use_unified_attribution_setting=true) (v27.0)", feasibility: "api", platformPermissions: META_READ, notes: "Synchronous reads, capped at 2,000 rows with a truncated flag. Async report runs for very large ranges are not used yet." }],
  [/^get_meta_ad_creatives$/, { api: "GET /{ad_id}/adcreatives (ad ownership checked) or /{act}/adcreatives (v27.0)", feasibility: "api", platformPermissions: META_READ }],
  [/^get_meta_app_(campaigns|adsets|creatives|summary)$/, { api: "GET /{act}/adsets filtered to promoted_object.application_id (app checked on /{act}/advertisable_applications), + /{act}/campaigns, /{act}/ads creative{...}, /{act}/insights level=adset; installs = mobile_app_install, in-app events = app_custom_event.* (v27.0)", feasibility: "api", platformPermissions: META_READ, notes: "App ad sets are found by promoted_object.application_id, not by objective. Application fields other than id and name are not read (not confirmed for advertisable_applications)." }],
  [/^list_meta_custom_audiences$/, { api: "GET /{act}/customaudiences (v27.0)", feasibility: "api", platformPermissions: META_READ }],
  [/^(browse|search)_meta_targeting$/, { api: "GET /{act}/targetingbrowse | /{act}/targetingsearch (Detailed Targeting, v27.0)", feasibility: "api", platformPermissions: META_READ }],
  [/^list_meta_catalogs$/, { api: "GET /{act}?fields=business -> /{business_id}/owned_product_catalogs + /client_product_catalogs (catalog must be one of them) (v27.0)", feasibility: "api", platformPermissions: META_CATALOG, notes: "The ad account has no documented catalog edge; catalogs are reached through its business. An account without a business has none." }],
  [/^list_meta_product_sets$/, { api: "GET /{catalog_id}/product_sets (fields id,name,filter,product_count), catalog ownership checked (v27.0)", feasibility: "api", platformPermissions: META_CATALOG }],
  [/^list_meta_products$/, { api: "GET /{catalog_id}/products (optional error_type) or /{product_set_id}/products, ownership checked (v27.0)", feasibility: "api", platformPermissions: META_CATALOG, notes: "REDUCED: no per-item review status. review_status was removed in v12.0 and channels_to_integrity_status has no documented shape; not-approved items are listed with issue=PRODUCT_NOT_APPROVED instead." }],
  [/^create_meta_product_set$/, { api: "POST /{catalog_id}/product_sets (name, one documented filter rule or {}); catalog must be one of the ad account's business catalogs (v27.0)", feasibility: "api", platformPermissions: ["business_management", "catalog_management"], notes: "Write risk (a product set does not spend). Meta error 10803 (same filter exists) is refused naming the existing set; one filter rule per set (combined rules are not used)." }],
  [/^list_meta_pixels$/, { api: "GET /{act}/adspixels (last_fired_time, is_unavailable, data_use_setting) (v27.0)", feasibility: "api", platformPermissions: META_READ }],
  [/^get_meta_pixel_stats$/, { api: "GET /{pixel_id}/stats aggregation=event_total_counts (pixel must be on /{act}/adspixels) (v27.0)", feasibility: "api", platformPermissions: META_READ, notes: "Meta serves pixel stats for up to seven days back. The AdsPixelStatsResult shape is not spelled out in the reference; it is parsed defensively." }],
  [/^list_meta_lead_forms$/, { api: "GET /{page_id}/leadgen_forms with a Page access token; Page must be on /{act}/promote_pages (v27.0)", feasibility: "api", platformPermissions: META_LEADS }],
  [/^get_meta_product_performance$/, { api: "GET /{act}/insights with breakdowns=product_id", feasibility: "api" }],
  [/^analyze_meta_ad_performance$/, { api: "GET /{act}/insights or /{campaign_id}/insights (level=ad, use_unified_attribution_setting=true), deterministic ranking and fixed-rule flags (v27.0)", feasibility: "derived", platformPermissions: META_READ }],
  [/^analyze_meta_audiences$/, { api: "GET /{act}/insights with audience breakdowns, fixed-rule flags (v27.0)", feasibility: "derived", platformPermissions: META_READ }],
  [/^analyze_meta_catalog_performance$/, { api: "GET /{act}/insights level=adset (use_unified_attribution_setting=true), restricted to ad sets whose promoted_object.product_set_id is in /{catalog}/product_sets; fixed-rule flags (v27.0)", feasibility: "derived", platformPermissions: META_CATALOG }],
  [/^get_meta_product_performance$/, { api: "GET /{act}/insights level=adset (use_unified_attribution_setting=true), restricted to ad sets whose promoted_object.product_set_id is in /{catalog}/product_sets, breakdowns=product_id (v27.0)", feasibility: "derived", platformPermissions: META_CATALOG, notes: "REDUCED: product_id is a Type 2 breakdown, so off-Meta conversions are not split by product; delivery metrics only." }],
  [/^analyze_meta_wasted_spend$/, { api: "GET /{act}/insights (level=campaign|adset|ad), fixed rule spend >= min_spend and conversions = 0 (v27.0)", feasibility: "derived", platformPermissions: META_READ }],
  [/^detect_meta_catalog_waste$/, { api: "GET /{act}/insights level=adset (use_unified_attribution_setting=true), restricted to ad sets whose promoted_object.product_set_id is in /{catalog}/product_sets (+ breakdowns=product_id) and /{catalog}/products error_type=PRODUCT_NOT_APPROVED | filter availability eq out of stock; fixed rules (v27.0)", feasibility: "derived", platformPermissions: META_CATALOG, notes: "The format of product_id breakdown values is not documented; they are matched to an item's id or retailer_id and the rest counted as unmatched." }],
  [/^compare_meta_catalog_product_sets$/, { api: "GET /{act}/insights level=adset (use_unified_attribution_setting=true), restricted to ad sets whose promoted_object.product_set_id is in /{catalog}/product_sets, summed per product set (v27.0)", feasibility: "derived", platformPermissions: META_CATALOG }],
  [/^detect_meta_creative_fatigue$/, { api: "GET /{act}/insights level=ad, two equal time_range windows, fixed-rule frequency/CTR/CPM signals (v27.0)", feasibility: "derived", platformPermissions: META_READ }],
  [/^diagnose_meta_catalog_funnel$/, { api: "GET /{act}/insights (level=account, or the catalog's ad sets) actions offsite_conversion.fb_pixel_view_content | add_to_cart | initiate_checkout | purchase (v27.0)", feasibility: "derived", platformPermissions: META_CATALOG, notes: "Pixel (website) events only; app events and on-Meta checkouts are not included." }],
  [/^explain_meta_anomaly$/, { api: "GET /{act}/insights for two time_range periods at campaign|adset|ad level; additive delta decomposition (v27.0)", feasibility: "derived", platformPermissions: META_READ }],
  [/^optimize_meta_budget$/, { api: "GET /{act}/insights + GET /{act}/campaigns|adsets budgets; share-of-spend vs share-of-conversions rules, no amounts (v27.0)", feasibility: "derived", platformPermissions: META_READ }],
  [/^optimize_meta_placements$/, { api: "GET /{act}/insights breakdowns=publisher_platform,platform_position, fixed-rule flags (v27.0)", feasibility: "derived", platformPermissions: META_READ }],
  [/^validate_catalog_readiness$/, { api: "GET /{catalog} product_count, /{catalog}/products?error_type=...&summary=total_count (PRODUCT_NOT_APPROVED, EMPTY_*), /{catalog}/external_event_sources (v27.0)", feasibility: "derived", platformPermissions: META_CATALOG, notes: "The diagnostics edge's ProductCatalogDiagnosticGroup shape is not documented, so it is not used." }],
  [/^(pause|resume)_meta_campaign$/, { api: "POST /{campaign_id} status=PAUSED|ACTIVE", feasibility: "api" }],
  [/^duplicate_meta_campaign$/, { api: "POST /{campaign_id}/copies (deep_copy, rename_options, status_option=PAUSED; returns copied_campaign_id) (v27.0)", feasibility: "api", notes: "Synchronous only: deep copies are limited to 3 ads (Meta's synchronous limit); larger ones are refused. verify() finds the copy through source_campaign_id." }],
  [/^create_meta_(image|video|carousel)_campaign$/, { api: "POST /{act}/campaigns -> /{act}/adsets -> /{act}/adcreatives (object_story_spec link_data / video_data / child_attachments) -> /{act}/ads, all PAUSED (v27.0)", feasibility: "api", platformPermissions: META_CREATE, notes: "Existing library images/videos only (no uploads); website destinations only. Not atomic: each step is sent once, a later failure reports the ids already created; verify() finds objects by their unique names." }],
  [/^create_meta_catalog_campaign$/, { api: "POST /{act}/campaigns (OUTCOME_SALES, promoted_object product_catalog_id) -> /{act}/adsets (promoted_object product_set_id) -> /{act}/adcreatives (object_story_spec.template_data + product_set_id) -> /{act}/ads, all PAUSED (v27.0)", feasibility: "api", platformPermissions: ["ads_management", "business_management", "catalog_management", "pages_manage_ads"], notes: "Goal pairs: OFFSITE_CONVERSIONS/IMPRESSIONS with PURCHASE (catalog needs a connected event source) or LINK_CLICKS/LINK_CLICKS. Commerce and home_listings catalogs only (home listings need HOUSING). Not atomic: ids created so far are reported; nothing is deleted." }],
  [/^create_meta_dco_ad$/, { api: "POST /{act}/adcreatives (asset_feed_spec) + POST /{act}/ads, in an empty ad set with is_dynamic_creative=true (v27.0)", feasibility: "api", platformPermissions: META_CREATE, notes: "One ad per dynamic creative ad set (Dynamic Creative guide)." }],
  [/^add_meta_ad$/, { api: "POST /{act}/adcreatives (optional, single image or video) + POST /{act}/ads, PAUSED (v27.0)", feasibility: "api", platformPermissions: META_CREATE }],
  [/^add_meta_catalog_ad$/, { api: "POST /{act}/adcreatives (template_data for the ad set's product set) + POST /{act}/ads, PAUSED (v27.0)", feasibility: "api", platformPermissions: ["ads_management", "business_management", "catalog_management", "pages_manage_ads"] }],
  [/^add_meta_ad_set$/, { api: "POST /{act}/adsets under an owned campaign, PAUSED (v27.0)", feasibility: "api", platformPermissions: META_CREATE }],
  [/^add_meta_catalog_ad_set$/, { api: "POST /{act}/adsets under an owned OUTCOME_SALES catalog campaign; product set must be in the campaign's catalog, PAUSED (v27.0)", feasibility: "api", platformPermissions: ["ads_management", "business_management", "catalog_management"], notes: "The campaign's catalog is read from its catalog ad sets (campaign promoted_object is not a documented readable field)." }],
  [/^update_meta_campaign$/, { api: "POST /{campaign_id}: name, status, daily_budget|lifetime_budget (campaign budget only), spend_cap (922337203685478 removes), bid_strategy=LOWEST_COST_WITHOUT_CAP (v27.0)", feasibility: "api", notes: "Campaign stop_time is read-only at campaign level; bid switches to cap strategies need adset_bid_amounts and are not offered." }],
  [/^update_meta_catalog_campaign$/, { api: "POST /{campaign_id} (name, status, budget, spend_cap); update_meta_campaign rules plus a catalog check (v27.0)", feasibility: "api", platformPermissions: ["ads_management"] }],
  [/^update_meta_ad_set$/, { api: "POST /{adset_id}: name, status, daily_budget|lifetime_budget (ad set budget only), bid_amount, bid_strategy, end_time (v27.0)", feasibility: "api", notes: "Targeting is not offered: the reference does not state whether a targeting update replaces or merges the spec. Never sends meta_moment_maker_spec." }],
  [/^update_meta_catalog_ad_set$/, { api: "POST /{adset_id} (name, status, budget, end_time); update_meta_ad_set rules plus a catalog check (v27.0)", feasibility: "api", platformPermissions: ["ads_management"], notes: "The product set cannot change: promoted_object is immutable after creation (Ad Set, Promoted Object reference)." }],
  [/^update_meta_ad$/, { api: "POST /{ad_id}: name, status (v27.0)", feasibility: "api", notes: "Creative content is immutable once an ad is created: creative changes need a new creative and ad (creation tools)." }],
  [/^update_meta_catalog_ad$/, { api: "POST /{ad_id} (name, status); update_meta_ad rules plus a catalog check (v27.0)", feasibility: "api", platformPermissions: ["ads_management"], notes: "Creative content is immutable once an ad is created: creative changes need a new creative." }],
];

// ------------------------------------------------- Search Console, GA4, Tag Manager (2026-11-10) ----
// Scopes confirmed on each API's reference pages (docs/VERIFICATION.md, "Search Console, GA4, Tag Manager foundation").
const G = (s: string) => `https://www.googleapis.com/auth/${s}`;
const GSC_READ = [G("webmasters.readonly")];
const GSC_WRITE = [G("webmasters")];
const GA4_READ = [G("analytics.readonly")];
// The Data API (runReport, getMetadata) accepts analytics.readonly or analytics, NOT analytics.edit, so a write connection holds both.
const GA4_WRITE = [G("analytics.readonly"), G("analytics.edit")];
const GTM_READ = [G("tagmanager.readonly")];
const GTM_EDIT = [G("tagmanager.edit.containers")];
const GTM_VERSION = [G("tagmanager.edit.containerversions")];
const GTM_PUBLISH = [G("tagmanager.publish")];

const productDomain: [RegExp, string][] = [
  [/^get_property_links$/, "connections"],
  [/^(analyze_paid_organic_overlap|find_organic_keyword_gaps|audit_ad_landing_pages|compare_conversion_tracking|analyze_meta_traffic_quality|get_channel_mix|check_utm_tagging|analyze_brand_search_trend|find_converting_terms_without_content|audit_tracking_setup|analyze_paid_search_on_site)$/, "combined"],
  [/gsc|search_|sitemap|inspect_url|top_(queries|pages)/, "search_console"],
  [/gtm/, "tag_manager"],
  [/.*/, "analytics"],
];

/** Each combined tool joins several products: its permissions name every scope it reads with. Checked before the per-platform rules. */
const combinedApi: Rule[] = [
  [/^get_property_links$/, { api: "This server's account_link table (no platform call)", feasibility: "internal", accountScope: "none", platformPermissions: [] }],
  [/^analyze_paid_organic_overlap$/, { api: "Google Ads search_term_view (GAQL) + GSC searchAnalytics.query (dimension query) for the linked site", feasibility: "derived", platformPermissions: [...GADS, ...GSC_READ], notes: "Candidates only, never instructions. GSC dates are Pacific Time; Ads uses the account time zone: whole days, stated in the output." }],
  [/^find_organic_keyword_gaps$/, { api: "GSC searchAnalytics.query (query) + Google Ads keyword_view (GAQL)", feasibility: "derived", platformPermissions: [...GADS, ...GSC_READ] }],
  [/^audit_ad_landing_pages$/, { api: "Google Ads ad final URLs (GAQL) and/or Meta creatives + GA4 runReport (landingPage) + GSC urlInspection.index.inspect (sampled: 2,000/day per site)", feasibility: "derived", platformPermissions: [...GADS, ...GA4_READ, ...GSC_READ], notes: "URL inspection is quota-limited, so it samples and says so." }],
  [/^compare_conversion_tracking$/, { api: "GA4 runReport (keyEvents by sessionGoogleAdsCampaignName / sessionCampaignName) + Google Ads conversions (GAQL) or Meta insights actions", feasibility: "derived", platformPermissions: [...GA4_READ, ...GADS], notes: "Reports the gap and the known reasons a gap is normal (attribution model, window, time zone); never claims one side is right." }],
  [/^analyze_meta_traffic_quality$/, { api: "Meta GET /{ad_id}?fields=url_tags,creative + GA4 runReport (sessionSource, sessionMedium, sessionCampaignName)", feasibility: "derived", platformPermissions: ["ads_read", ...GA4_READ], notes: "GA4 has no Meta dimensions: matched through UTM tags only, with a list of campaigns it could not match." }],
  [/^get_channel_mix$/, { api: "GA4 runReport (sessionDefaultChannelGroup) + spend from linked ad accounts", feasibility: "derived", platformPermissions: [...GA4_READ] }],
  [/^check_utm_tagging$/, { api: "Google Ads customer.auto_tagging_enabled + tracking templates (GAQL), Meta url_tags, GA4 runReport (sessionManual* UTM dimensions)", feasibility: "derived", platformPermissions: [...GA4_READ, ...GADS, "ads_read"] }],
  [/^analyze_brand_search_trend$/, { api: "GSC searchAnalytics.query (date, query filtered to brand terms) + spend from linked ad accounts", feasibility: "derived", platformPermissions: [...GSC_READ], notes: "A trend next to spend only: no causal claim." }],
  [/^find_converting_terms_without_content$/, { api: "Google Ads search_term_view with conversions (GAQL) + GSC searchAnalytics.query (query)", feasibility: "derived", platformPermissions: [...GADS, ...GSC_READ] }],
  [/^audit_tracking_setup$/, { api: "GTM live version (versions.live) + GA4 Admin keyEvents.list + Google Ads conversion_action (GAQL) + Meta adspixels", feasibility: "derived", platformPermissions: [...GTM_READ, ...GA4_READ, ...GADS], notes: "Recognises tags only by documented tag types and snippets." }],
  [/^analyze_paid_search_on_site$/, { api: "GA4 runReport (sessionGoogleAdsQuery with engagement and keyEvents)", feasibility: "derived", platformPermissions: [...GA4_READ] }],
];

const productApi: Rule[] = [
  // ---- Search Console (webmasters v3 at www.googleapis.com, URL Inspection at searchconsole.googleapis.com)
  [/^list_gsc_sites$/, { api: "GET webmasters/v3/sites (siteEntry: siteUrl, permissionLevel)", feasibility: "api", platformPermissions: GSC_READ }],
  [/^(get_search_performance|get_top_queries|get_top_pages|get_search_appearance)$/, { api: "POST webmasters/v3/sites/{siteUrl}/searchAnalytics/query (rowLimit up to 25,000, startRow paging)", feasibility: "api", platformPermissions: GSC_READ }],
  [/^compare_search_periods$/, { api: "POST webmasters/v3/sites/{siteUrl}/searchAnalytics/query for two periods, deterministic diff", feasibility: "derived", platformPermissions: GSC_READ }],
  [/^inspect_url$/, { api: "POST searchconsole.googleapis.com/v1/urlInspection/index:inspect", feasibility: "api", platformPermissions: GSC_READ, notes: "600/min and 2,000/day per site." }],
  [/^list_sitemaps$/, { api: "GET webmasters/v3/sites/{siteUrl}/sitemaps", feasibility: "api", platformPermissions: GSC_READ }],
  [/^submit_sitemap$/, { api: "PUT webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}", feasibility: "api", platformPermissions: GSC_WRITE }],
  [/^delete_sitemap$/, { api: "DELETE webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}", feasibility: "api", platformPermissions: GSC_WRITE }],
  [/^add_gsc_site$/, { api: "PUT webmasters/v3/sites/{siteUrl}", feasibility: "api", platformPermissions: GSC_WRITE, notes: "Ownership must still be verified in Search Console. Acts on the connection of the named site account." }],
  [/^remove_gsc_site$/, { api: "DELETE webmasters/v3/sites/{siteUrl}", feasibility: "api", platformPermissions: GSC_WRITE }],
  // ---- GA4 (Admin API v1beta/v1alpha, Data API v1beta/v1alpha)
  [/^list_ga4_properties$/, { api: "Admin v1beta accountSummaries.list + properties.get + properties.dataStreams.list", feasibility: "api", platformPermissions: GA4_READ }],
  [/^get_ga4_metadata$/, { api: "Data v1beta properties/{id}/metadata + Admin keyEvents.list", feasibility: "api", platformPermissions: GA4_READ }],
  [/^run_ga4_report$/, { api: "Data v1beta properties:checkCompatibility then properties:runReport", feasibility: "api", platformPermissions: GA4_READ }],
  [/^run_ga4_pivot_report$/, { api: "Data v1beta properties:runPivotReport", feasibility: "api", platformPermissions: GA4_READ }],
  [/^run_ga4_funnel_report$/, { api: "Data v1alpha properties:runFunnelReport (alpha API)", feasibility: "api", platformPermissions: GA4_READ }],
  [/^get_ga4_realtime$/, { api: "Data v1beta properties:runRealtimeReport", feasibility: "api", platformPermissions: GA4_READ }],
  [/^(get_traffic_by_channel|get_campaign_traffic|get_landing_page_performance|get_google_ads_traffic_in_ga4|get_conversion_events)$/, { api: "Data v1beta properties:runReport with fixed dimensions and metrics", feasibility: "api", platformPermissions: GA4_READ }],
  [/^get_ga4_ads_links$/, { api: "Admin v1beta properties.googleAdsLinks.list", feasibility: "api", platformPermissions: GA4_READ }],
  [/^get_ga4_attribution_settings$/, { api: "Admin v1alpha properties.getAttributionSettings (alpha API)", feasibility: "api", platformPermissions: GA4_READ }],
  [/^get_ga4_change_history$/, { api: "Admin v1beta accounts:searchChangeHistoryEvents", feasibility: "api", platformPermissions: GA4_READ, notes: "Check the method's scope before building: it may need analytics.edit." }],
  [/^create_key_event$/, { api: "Admin v1beta properties.keyEvents.create", feasibility: "api", platformPermissions: GA4_WRITE }],
  [/^remove_key_event$/, { api: "Admin v1beta properties.keyEvents.delete", feasibility: "api", platformPermissions: GA4_WRITE }],
  [/^create_custom_dimension$/, { api: "Admin v1beta properties.customDimensions.create", feasibility: "api", platformPermissions: GA4_WRITE }],
  [/^create_ga4_audience$/, { api: "Admin v1alpha properties.audiences.create (alpha API)", feasibility: "api", platformPermissions: GA4_WRITE }],
  // ---- Tag Manager (tagmanager v2)
  [/^list_gtm_containers$/, { api: "GET tagmanager/v2/accounts + accounts/{a}/containers", feasibility: "api", platformPermissions: GTM_READ }],
  [/^get_gtm_live_version$/, { api: "GET tagmanager/v2/{container}/versions:live", feasibility: "api", platformPermissions: GTM_READ }],
  [/^list_gtm_(tags|triggers|variables)$/, { api: "GET tagmanager/v2/{workspace}/tags | triggers | variables", feasibility: "api", platformPermissions: GTM_READ }],
  [/^get_gtm_workspace_status$/, { api: "GET tagmanager/v2/{workspace}/status", feasibility: "api", platformPermissions: GTM_READ }],
  [/^audit_gtm_container$/, { api: "GET tagmanager/v2/{container}/versions:live, fixed documented rules", feasibility: "derived", platformPermissions: GTM_READ }],
  [/^(create|update)_gtm_tag$/, { api: "POST {workspace}/tags | PUT {tag} (in the server's own JackOfAds workspace)", feasibility: "api", platformPermissions: GTM_EDIT }],
  [/^create_gtm_trigger$/, { api: "POST {workspace}/triggers (in the server's own JackOfAds workspace)", feasibility: "api", platformPermissions: GTM_EDIT }],
  [/^create_gtm_version$/, { api: "POST {workspace}:create_version", feasibility: "api", platformPermissions: GTM_VERSION }],
  [/^publish_gtm_version$/, { api: "POST {version}:publish", feasibility: "api", platformPermissions: GTM_PUBLISH, notes: "The only tool that changes the live site; the approval shows a diff against the live version." }],
];

/** Design section 6: tiers that differ from the action type's default (Delete = destructive, other changes = write). */
// create/update_gtm_tag are high_impact (owner-approved 2026-11-10, stricter than design section 6): a custom HTML tag is code
// that will run on the customer's website once published, so a second person approves even the draft.
const productRisk: Record<string, Risk> = { create_key_event: "high_impact", create_gtm_tag: "high_impact", update_gtm_tag: "high_impact", publish_gtm_version: "destructive" };
const PRODUCTS = new Set(["google_search_console", "google_analytics", "google_tag_manager"]);

const googleHighImpact = /^create_(search|shopping|pmax|demandgen|app|youtube)_campaign$|^resume_(campaign|ad_group|ad)$|^update_campaign$|^update_bid_strategy$|^bulk_update_|^replace_demandgen_audiences$|^(create|update)_conversion_action$|^link_merchant_center$|^set_campaign_ad_schedule$|^set_.*device_bid_modifiers$|^update_campaign_dates$|^apply_recommendations$|^upload_(click|call)_conversions$|^upload_conversion_adjustments$|^update_conversion_goals$|^create_conversion_value_rule$|^add_account_exclusions$|^set_auto_tagging$|^set_location_bid_modifiers$|^assign_bid_strategy$|^create_(seasonality_adjustment|data_exclusion|experiment)$|^(schedule|end|promote)_experiment$|^upload_customer_match_members$|^request_policy_exemption$|^update_user_access$|^invite_user$|^(create|link)_client_account$/;
const metaHighImpact = /^create_meta_.*_campaign$|^duplicate_meta_campaign$|^resume_meta_campaign$|^update_meta_(campaign|catalog_campaign|ad_set|catalog_ad_set|ad|catalog_ad)$|^add_meta_(ad_set|catalog_ad_set|ad|catalog_ad)$|^create_meta_dco_ad$/;

function firstMatch<T>(rules: [RegExp, T][], name: string, fallback: T): T {
  for (const [re, v] of rules) if (re.test(name)) return v;
  return fallback;
}

export function mapTool(t: InventoryTool): Mapping {
  const combined = combinedApi.find(([re]) => re.test(t.name))?.[1];
  if (PRODUCTS.has(t.platform) || combined) {
    const rule = combined ?? productApi.find(([re]) => re.test(t.name))?.[1];
    const risk: Risk = !t.modifies_data ? "read" : (productRisk[t.name] ?? (t.action_type === "Delete" ? "destructive" : "write"));
    return {
      domain: firstMatch(productDomain, t.name, "other"),
      api: rule?.api ?? "UNMAPPED: needs API mapping",
      risk,
      feasibility: rule?.feasibility ?? "api",
      platformPermissions: rule?.platformPermissions ?? [],
      accountScope: rule?.accountScope ?? "required",
      ...(rule?.notes ? { notes: rule.notes } : {}),
    };
  }
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
