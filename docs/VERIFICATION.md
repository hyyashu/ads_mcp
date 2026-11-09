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

### Checked directly on developers.facebook.com, 2026-11-04 (M5)

- **Version**: v26.0 is the latest (introduced 2026-07-29, Graph and Marketing API tables); v25.0 still available. The
  server uses `META_API_VERSION=v26.0`. The earlier note below that v25.0 was latest is superseded.
- **Errors**: `{error: {message, type, code, error_subcode, error_user_title, error_user_msg, fbtrace_id}}`. 190 / 102 /
  OAuthException without subcode = token invalid; 1 and 2 = temporary; 10 and 200-299 = permission.
- **Throttling codes**: 4 (app), 17 (user), 32 (pages), 613 (custom), 80000-80014 (business use case, "too many calls
  from this ad-account").
- **Usage headers**: `X-Business-Use-Case-Usage` (per business object; `estimated_time_to_regain_access` in minutes),
  `X-Ad-Account-Usage` (`acc_id_util_pct`, `reset_time_duration` in seconds), `X-App-Usage` (percentages).
- **Money**: amounts are in the currency's minor unit given by its offset. Offset 1: CLP, COP, CRC, HUF, IDR, ISK, JPY,
  KRW, PYG, TWD, VND; every other listed currency (66 total) has offset 100. This settles the "cents" question: cents
  for USD, but whole yen for JPY.
- **Official Node SDK**: `facebook-nodejs-business-sdk` 24.0.1 on npm targets v24 and passes the token as a query
  parameter, so it is not used; the server has its own thin client pinned to the configured version.
- **Not found** in the pages checked: an idempotency key for Marketing API writes.

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
| Current spec | The site serves revision **2026-07-28**. The server uses SDK v2 (`@modelcontextprotocol/server` 2.4, `@modelcontextprotocol/node` 2.1), which implements it. |
| Authorization (confirmed) | Protected Resource Metadata (RFC 9728) MUST; token audience validation per RFC 8707 MUST; `resource` parameter in authorization and token requests; Client ID Metadata Documents SHOULD; **Dynamic Client Registration is deprecated** (MAY); RFC 9207 `iss` on authorization responses SHOULD; `WWW-Authenticate` with `resource_metadata` and `scope`; 403 `insufficient_scope` challenge. Our OAuth server advertises CIMD, DCR and `iss`; whether its 403 scope challenge matches was not checked. |
| Transport | 2026-07-28 (per-request `_meta` envelope, no `initialize` session) is served natively by `createMcpHandler`; 2025-era clients get the SDK's stateless fallback from the same per-request server factory. Verified 2026-11-05 by `src/tests/mcp/protocol.test.ts` ("protocol revisions"): a client pinned to 2026-07-28, an auto-negotiating client and a legacy client all list and call tools. Before this, SDK v1 answered ChatGPT's 2026-07-28 request with 400 "Unsupported protocol version". |

## Actions taken

- README and `.env.example` updated: stale "docs unreachable" wording, API version examples, MCP note.
- `inventory/mapping.ts`: keyword research mapping corrected to the real service and v24 changes.

## Still to do before calling anything verified

1. Read the Google RPC reference for each resource a tool touches (field names, enums, required fields) when that tool is built.
2. Fetch the Meta reference pages for each endpoint when its tool is built (audiences, catalog, insights parameters, lead forms, pixels).
3. ~~Upgrade or evaluate the MCP SDK for the 2026-07-28 revision.~~ Done: SDK v2 (see the MCP table above).
4. Run everything once against a Test-level and a Basic-level Google account and a Meta test ad account.

## Defects found by checking against the docs (2026-11-02, batch 2)

- **`list_campaigns` selected `campaign.start_date` / `campaign.end_date`.** The v26 Campaign reference lists only `start_date_time` and `end_date_time` ("yyyy-MM-dd HH:mm:ss", account time zone). The old query would very likely have failed on the live API while its mocked test passed. Fixed; output fields renamed `start_date_time` / `end_date_time`. This is the practical risk of mock-only testing: a mock written from the same wrong assumption proves nothing.
- **`lit.date` accepted impossible dates** (`2027-02-30`): `Date.parse` is lenient. Fixed with a round-trip check (`isRealDate`).
- **A drift test in `src/tests/google/status.test.ts` passed for the wrong reason** (the request deduplicated onto an already-executed approval). Rewritten to assert the real behaviour. `ApprovalService.decide` records an executor failure as a `failed` approval; it does not throw.
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

## Architecture review and safety fixes (Opus review, then verified in code, 2026-11-02)

An independent review of the codebase flagged the items below. Each was confirmed in the code before it was fixed, and each fix has a
regression test that fails without it.

- **Failures before any change was sent were recorded as `unknown_outcome`**, which blocks re-requesting until reconciliation. The Google client now counts the
  changes it attempted to send (`mutationsSent`); the executor marks any error raised while that count is zero as definite (`ToolError.opts.definite`), so a transient
  error while re-checking at approval time is a clean `failed`. After a send, errors stay `unknown_outcome`. (`validate_only` requests do not count.)
- **Input errors surfaced as `internal`.** `GaqlError` (caller-supplied values) and the date-order check are now `invalid_argument`; mistakes in our own query structure stay
  `internal`. Impossible calendar dates (for example 2026-02-30) are rejected by the input schema.
- **A stale pending request was returned to the agent unchanged.** A duplicate of a live pending request is now deduplicated only if it was planned against the same state
  (canonical snapshot); otherwise the old request is marked expired (`result.superseded`) and replaced, so the approver sees the current plan.
- **Reconciliation could starve.** `reconcileUnknown` now skips rows that used up their checks and checks never-checked, then least-recently-checked rows first.
- **Risk tiers are cross-checked**: a test asserts every implemented tool's tier equals the inventory plan (a mis-tiered `resume_*` could otherwise be self-approved).

The four items the review left open were closed on 2026-11-10:

- **R8, totals over the returned rows only.** The Google campaign and ad performance reports already read every matching row for their
  totals (`totals_scope`). The remaining cases are fixed: PMax search category shares are now of every category, not only the
  returned ones (all rows are read, the top `limit` shown, `truncated` added). The PMax search term costs and the Meta app and catalog
  totals now say in their schema which rows they cover. Regression test: `src/tests/regressions/row-caps.test.ts`.
- **R6, silent fixed-size caps.** Fixed at the source. `GoogleAdsClient.query` and `MetaAdsClient.list` now fail with `unsupported`
  (`details.reason = "row_cap"`, "Nothing was changed") when a read matches more rows than its cap, unless the caller passes
  `partial` because it shows a page and reports `truncated` itself. Fixed GAQL `LIMIT`s on lists that must be complete (duplicate
  checks before writes, negative list members and attached campaigns, label links, ad groups, frequency caps, shopping settings, PMax
  asset groups, the language list) were removed, because a LIMIT hides the overflow from the client. Paged reads that had no
  `truncated` flag got one (`get_campaign_dates`, `get_ad_group_settings`, `list_conversion_actions`, `list_labels`,
  `list_negative_keyword_lists`, `get_campaign_tracking`, `search_audiences`, `analyze_pmax_search_categories`), and the change history
  in `explain_performance_anomaly` notes when it lists only the latest 200 changes. Regression tests in `row-caps.test.ts`.
- **R7, several API calls per write.** Kept by design: plan, re-check at approval time, execute and read back are what make approvals
  and conflict detection safe. Documented in the README.
- **R9, simultaneous identical requests.** Already fixed in code (`onConflictDoNothing` on the idempotency key, then the winner is read
  back). It had no test; `src/tests/core/reliability.test.ts` now simulates the race through the `afterExistingRead` seam and checks
  that the second request gets the first one back.

The review's line counts and savings estimates were not checked.

## Meta fields still unconfirmed (checked again 2026-11-10 with Meta's docs search)

- **Confirmed:** campaign copies (`POST /{campaign}/copies`) copy at most 3 child ads in a synchronous call and 51 in an asynchronous
  one. `duplicate_meta_campaign` already refuses above 3 and never starts asynchronous copies.
- **Partly confirmed:** insights `filtering` exists (dot notation, e.g. `ad.impressions` with `GREATER_THAN`, and `IN` recommended),
  but `campaign.id` / `adset.id` with `IN` appears only on the Marketing Mix Modeling page (asynchronous CSV exports). The tools keep
  filtering by choosing the endpoint (`/{campaign_id}/insights`) or locally.
- **Still unconfirmed, so not used:** `omni_*` action types (only `catalog_segment_value_omni_purchase_roas` and
  `converted_promoted_product_omni_*` fields are documented); the fields of `AdsPixelStatsResult` (the stats page confirms
  `aggregation=event_total_counts`, the seven-day window and a `data` list of `AdsPixelStatsResult`, not its fields, so
  `get_meta_pixel_stats` still reads both shapes seen); video `length` on ad videos; whether a targeting update replaces or merges
  (targeting edits are not offered); and an objective-to-optimization-goal table.
