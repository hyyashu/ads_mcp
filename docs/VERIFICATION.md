# Verification against official documentation

Checked 2026-11-02 by fetching the pages listed below. "Confirmed" means the page text says so. "Not covered" means the
fetched page did not address it, so the point **remains unverified**. Nothing here has been tested against a live account.

## Google Ads API

| Claim in this repo | Result | Source |
|---|---|---|
| Developer tokens were sunset on 2026-09-09; access levels attach to the Cloud project that owns the OAuth credentials; a developer-token header is optional and ignored | **Confirmed**. Google may reject tokens "in a future major version". Projects without a transfer default to Test access. | api-policy/developer-token |
| `login-customer-id` is sent for manager-account access, digits only | **Confirmed** | rest/auth |
| Only `Authorization: Bearer` is otherwise required | **Confirmed** (no developer-token header mentioned) | rest/auth |
| Mutate updates use `updateMask` beside `update`, comma-separated | **Confirmed** | rest/examples |
| `GoogleAdsService.Mutate` is atomic across resource types and supports temporary negative ids | **Confirmed** | mutating/overview |
| Search pages hold 10,000 rows; `searchStream` takes no page size | **Confirmed**. Our client follows `nextPageToken`. | rest/examples |
| REST JSON uses camelCase | **Mostly confirmed**: examples are camelCase with some snake_case inconsistencies. `pick()` converts snake to camel, and the fake API in tests uses camelCase. Verify the real response casing on the first live run. | rest/examples |
| Search response body is `{results, nextPageToken}` | **Not covered** by the fetched pages (reference page not read). Unverified. | |
| `validateOnly` and `partialFailure` request fields | **Not covered**. Unverified. | |
| API versions | Latest is **v26.1** (2026-10-28). Supported: v23 to v26. Planned sunsets (tentative): v23 Feb 2027, v24 May 2027, v25 Aug 2027, v26 Nov 2027. | release-notes, sunset-dates |
| Keyword research mapping | **Corrected**: `GenerateKeywordIdeas` (`POST customers/{id}:generateKeywordIdeas`, up to 20 seed keywords, 10 geo targets, 10,000 per page) and `GenerateKeywordHistoricalMetrics` (up to 10,000 keywords) both live on `KeywordPlanIdeaService`. Forecasting is `KeywordPlanIdeaService.GenerateKeywordForecastMetrics`, **not** `KeywordPlanService`. From v24, `biddable_keywords` became `keywords`, `geo_modifiers` became `geo_target_constants`, and negative keywords, per-keyword CPC overrides and `conversion_rate` are no longer supported. v24+ returns no impressions/CTR. | keyword-planning/* |
| v25.1 error `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` | **New**: a Test-level Cloud project calling a non-test account. Map it to `platform_permission_denied` with a clear message when the first live call is made. | release-notes |
| GAQL: `campaign.status != 'REMOVED'`, `DURING` literals, single-quoted strings | Examples consistent. The complete DURING literal list and string-literal rules were **not covered**. | query/overview |

Pages that were not reachable or did not contain the detail asked for: the GAQL grammar page, the RPC reference
(`/reference/rpc`), and the REST design/json-mapping page (404). Field names in the tool mappings are therefore still from knowledge.

## Meta Marketing API

No Meta code exists yet beyond the platform OAuth flow, so there was nothing to verify against beyond that and the plan.

- **Versions**: the changelog page says Graph API v26.0 (scheduled 2026-07-29) and Marketing API **v25.0** (2026-02-18); v24.0 expires 2026-10-06. This repo's `.env.example` and tests use `v23.0`, which is stale. The page's own wording was ambiguous about dates, so confirm the current version before setting `META_API_VERSION`.
- **Campaigns**: `POST /act_{id}/campaigns`. `special_ad_categories` is the only parameter marked required (empty array or `NONE` if none). Objectives are ODAX (`OUTCOME_APP_PROMOTION`, `OUTCOME_AWARENESS`, `OUTCOME_ENGAGEMENT`, `OUTCOME_LEADS`, `OUTCOME_SALES`, `OUTCOME_TRAFFIC`). Only `ACTIVE`/`PAUSED` are valid on create. `execution_options: validate_only` exists. Update is `POST /{id}`; status may be `ACTIVE`, `PAUSED`, `DELETED`, `ARCHIVED`. **Budget units are not stated** on the page (only `spend_cap` is "subunit of currency"), so the README claim that Meta budgets are in cents is unverified here.
- **Ads**: `POST /act_{id}/ads` requires `name` and `creative`, plus `adset_id` unless `adset_spec` is given. Archived ads can only go to `DELETED`; deleted ads can only be renamed. `effective_status` values listed on the page.
- **Insights**: edge is `/{object-id}/insights`; needs `ads_read`. Date presets, async reports, attribution windows and rate limits were **not covered** by the fetched page.
- **Audiences, catalogs**: overview pages only; endpoints, required fields, terms-of-service acceptance, hashing and `catalog_management` details **not covered**. Do not build these tools from memory; fetch the reference pages first.
- **Facebook Login, get-started permissions, appsecret_proof, the Node SDK repo**: not covered (get-started page was a high-level overview; the GitHub repo returned 403).

## Model Context Protocol

| Item | Result |
|---|---|
| Current spec | The site serves revision **2026-07-28**. The installed `@modelcontextprotocol/sdk` 1.32.2 (also the latest on npm) supports protocol versions up to **2025-11-25**. |
| Authorization (confirmed) | Protected Resource Metadata (RFC 9728) MUST; token audience validation per RFC 8707 MUST; `resource` parameter in authorization and token requests; Client ID Metadata Documents SHOULD; **Dynamic Client Registration is deprecated** (MAY); RFC 9207 `iss` on authorization responses SHOULD; `WWW-Authenticate` with `resource_metadata` and `scope`; 403 `insufficient_scope` challenge. Our OAuth server advertises CIMD, DCR and `iss`; whether its 403 scope challenge matches was not checked. |
| Transport (**gap**) | The 2026-07-28 revision removes the connection-scoped `initialize` session: every request carries protocol version and client capabilities in `_meta`, Streamable HTTP mirrors metadata into HTTP headers, and servers do not send requests to clients. Clients fall back to the old handshake for older servers, so our server should keep working with current clients, but **it does not implement the new revision**. Status of the TypeScript SDK for it was not verified (GitHub README fetched only via raw URL; not read). |

## Actions taken

- README and `.env.example` updated: stale "docs unreachable" wording, API version examples, MCP note.
- `inventory/mapping.ts`: keyword research mapping corrected to the real service and v24 changes.

## Still to do before calling anything verified

1. Read the Google RPC reference for each resource a tool touches (field names, enums, required fields) when that tool is built.
2. Fetch the Meta reference pages for each endpoint when its tool is built (audiences, catalog, insights parameters, lead forms, pixels).
3. Upgrade or evaluate the MCP SDK for the 2026-07-28 revision.
4. Run everything once against a Test-level and a Basic-level Google account and a Meta test ad account.

## Defects found by checking against the docs (2026-11-02, batch 2)

- **`list_campaigns` selected `campaign.start_date` / `campaign.end_date`.** The v26 Campaign reference lists only `start_date_time` and `end_date_time` ("yyyy-MM-dd HH:mm:ss", account time zone). The old query would very likely have failed on the live API while its mocked test passed. Fixed; output fields renamed `start_date_time` / `end_date_time`. This is the practical risk of mock-only testing: a mock written from the same wrong assumption proves nothing.
- **`lit.date` accepted impossible dates** (`2027-02-30`): `Date.parse` is lenient. Fixed with a round-trip check (`isRealDate`).
- **A drift test in `google-status.test.ts` passed for the wrong reason** (the request deduplicated onto an already-executed approval). Rewritten to assert the real behaviour. `ApprovalService.decide` records an executor failure as a `failed` approval; it does not throw.
- Budget and ad group field names were checked against the CampaignBudget and AdGroup references (`amount_micros`, `explicitly_shared`, `cpc_bid_micros`, `target_cpa_micros`; `period` and ad group `type` immutable). `BudgetDeliveryMethod` enum values were not listed on the page.

## Batch 3: keywords, negative keywords, search terms (checked 2026-11-02)

Confirmed from the v26 references: `KeywordInfo.text` max 80 characters and 10 words; match types `BROAD`/`PHRASE`/`EXACT`;
`AdGroupCriterion` and `CampaignCriterion` keyword, negative and parent are immutable (so text and match type cannot be edited:
remove and re-add); resource names `adGroupCriteria/{ad_group_id}~{criterion_id}` and `campaignCriteria/{campaign_id}~{criterion_id}`;
`AdGroupCriterionOperation` is `update_mask` plus create/update/remove, where `remove` is a resource-name string;
`partial_failure` defaults to false (all-or-nothing), which the tools rely on; `AdGroupCriterionStatus` is ENABLED/PAUSED/REMOVED;
`search_term_view` excludes Performance Max data (PMax needs `campaign_search_term_view`).

Still unverified (written from knowledge, not confirmed on any fetched page):
- GAQL boolean literals `negative = TRUE` / `FALSE` (uppercase) and the filter `*_criterion.type = 'KEYWORD'`.
- GAQL field paths `ad_group_criterion.keyword.text`, `.keyword.match_type`, `.criterion_id`, `.cpc_bid_micros` and the `campaign_criterion` equivalents.
- Metrics and segments available on `search_term_view` (the page listed only four fields), and the values of `SearchTermTargetingStatus`; `targeting_status` is therefore passed through unchanged and never interpreted.
- REST paths `customers/{id}/adGroupCriteria:mutate` and `campaignCriteria:mutate` (the method pages did not show REST).
- Whether `campaign_criterion.cpc_bid_micros` is not selectable (we only select it for ad groups).
- Negative keywords at campaign level are not applicable to Performance Max campaigns through this path; not tested or documented by Google in the pages read.

## Batch 4: negative keyword lists and ad lifecycle (checked 2026-11-02)

Confirmed from the v26 references: `SharedSet.name` must be unique among active shared sets of the same type, 1 to 255 UTF-8 bytes;
`SharedSetType` includes `NEGATIVE_KEYWORDS` (and separately `ACCOUNT_LEVEL_NEGATIVE_KEYWORDS`, which these tools do not touch);
`member_count` and `reference_count` are output only; `SharedCriterion` and `CampaignSharedSet` support create and remove only
(no update); resource names `sharedSets/{id}`, `sharedCriteria/{set}~{criterion}`, `campaignSharedSets/{campaign}~{set}`;
`GoogleAdsService.Mutate` supports temporary negative ids, used to create a list with its keywords atomically;
`AdGroupAd` ad_group, ad and resource_name are immutable, status is ENABLED/PAUSED/REMOVED, `policy_summary` and `ad_strength` are
output only, resource name `adGroupAds/{ad_group_id}~{ad_id}`, and the operation is create/update/remove with `remove` taking the resource name.

Still unverified (from knowledge): GAQL resources and fields `shared_criterion.keyword.*`, `campaign_shared_set.status`,
`ad_group_ad.ad.responsive_search_ad.headlines/descriptions/path1/path2`, `shared_set.member_count/reference_count` in a SELECT, filtering
`shared_criterion` by `shared_set.id`; REST paths `sharedCriteria:mutate`, `campaignSharedSets:mutate`, `adGroupAds:mutate`; the value
`APPROVED` of the policy approval status; behaviour of `*:mutate` for a removed ad group ad (whether it stays queryable as REMOVED).
Detaching a list from a campaign is supported by the API (remove on `campaignSharedSets`) but is not in the tool inventory.

## Defect found while testing batch 4

The approval pipeline answered a duplicate request for a change that was **already executed** (inside the 10-minute dedupe window)
with `pending_approval` / "Nothing has been changed", although nothing was pending. Reproduction: pause an ad, approve, have someone
resume it, ask to pause again. Fixed in `src/mcp/pipeline.ts`: a duplicate of an executing or just-applied change now returns a `conflict`
error saying so. A regression test covers it.

## Batch 5: responsive search ad create and edit (checked 2026-11-02)

Confirmed from the Google Ads docs: a responsive search ad has 3-15 headlines and 2-4 descriptions; headlines pin only to
HEADLINE_1..3 and descriptions only to DESCRIPTION_1..2 (other positions fail with INVALID_PINNED_FIELD); `path2` can only be set
when `path1` is set; every position must be fillable; `AdService.MutateAds` updates ads by `customers/{c}/ads/{ad_id}` with an
`update_mask` and does not support TextAd, ExpandedDynamicSearchAd, GmailAd or ImageAd; automatically created assets cannot be
removed through MutateAds; `PolicyValidationParameter.ignorable_policy_topics` exists (deliberately not used: these tools never
bypass policy checks).

**Not confirmed by any reachable page: the character limits of headlines, descriptions and display paths.** They are not hard-coded.
`plan()` runs Google's own `validate_only` check on the exact request, so Google's limits and policy findings are returned when the
change is requested, before approval. Local validation is limited to what the docs state (counts, pin positions, path2 needs path1,
http(s) URLs) plus abuse bounds (300 characters) that are not Google's limits. Trade-off: planning makes one extra API call.

Still unverified (from knowledge): REST path `ads:mutate` and `adGroupAds:mutate` create semantics, the GAQL path
`ad_group_ad.ad.resource_name`, `ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'` as a filter literal, the shape of a
`validate_only` success response, and whether Google normalizes whitespace/case in ad text on read-back (we compare trimmed text).
Behaviour not covered: Display, Demand Gen, Shopping and App ad creation (separate tools); `suggest_ad_content` is deferred (see below).

## Defect found while testing batch 5

Snapshots are stored as JSONB, which does not preserve object key order. `ad-content.ts` compared whole snapshot objects with
`JSON.stringify`, so any edit that changed more than one field kind (for example final URL plus paths) always failed at approval time
with "The ad changed since this was requested." Single-field edits passed by luck. Fixed by comparing with `canonicalJson` (sorted keys).
The other tools compare arrays or individual fields, which JSONB preserves. A regression test covers it.

## Needs a decision: suggest_ad_content

Inventory risk "read", plan "GAQL: ad_group_ad_asset performance, plus character-limit validation". The server cannot honestly generate
marketing copy, and the character limits are unconfirmed. A reduced, honest form is possible: return grounded inputs (the ad group's
keywords, top converting search terms, existing copy and its asset performance labels) and rule-based coverage gaps (fewer than 15
headlines, fewer than 4 descriptions, duplicate texts), leaving copywriting to the client model. Not built until the owner agrees.
