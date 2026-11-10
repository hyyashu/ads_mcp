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

## Search Console, GA4, Tag Manager foundation (2026-11-10)

Checked on developers.google.com on 2026-11-10 (WebFetch of each page). Used by the Connect flows, the shared transport
(`src/platforms/gapi/`) and the per-product clients. Channel builders add their own methods' facts below this section.

**OAuth scopes (each method page's "Authorization scopes")**
- Search Console `sites.list`: `webmasters.readonly` or `webmasters`
  (https://developers.google.com/webmaster-tools/v1/sites/list). `urlInspection.index.inspect`: `webmasters` or `webmasters.readonly`
  (https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect). `sitemaps.submit`: `webmasters` only
  (https://developers.google.com/webmaster-tools/v1/sitemaps/submit). So read = `webmasters.readonly`, write = `webmasters` (covers reads).
- GA4 Admin `accountSummaries.list` and `properties.get`: `analytics.readonly` or `analytics.edit`
  (https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list,
  https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties/get). `properties.keyEvents.create`: `analytics.edit`
  (https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties.keyEvents/create).
  **Data API `runReport` and `getMetadata`: `analytics.readonly` or `analytics` — NOT `analytics.edit`**
  (https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport,
  https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/getMetadata). Therefore a GA4 write connection
  asks for `analytics.readonly` **and** `analytics.edit` (the contract listed `analytics.edit` alone, which could not run reports).
- Tag Manager `accounts.list`: `tagmanager.edit.containers`, `tagmanager.manage.accounts` or `tagmanager.readonly`
  (https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts/list). `accounts.containers.list`:
  `tagmanager.edit.containers` or `tagmanager.readonly` (https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers/list).
  `workspaces.tags.create`: `tagmanager.edit.containers` (https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces.tags/create).
  `workspaces.create_version`: `tagmanager.edit.containerversions` (https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.workspaces/create_version).
  `versions.publish`: `tagmanager.publish` only (https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers.versions/publish).
  Read = `tagmanager.readonly`; write = `tagmanager.readonly tagmanager.edit.containers tagmanager.edit.containerversions tagmanager.publish`.
- All prefixed `https://www.googleapis.com/auth/`. The token endpoint's `scope` field lists the scopes actually granted (users may grant
  fewer); the callback checks every scope of the chosen access level against it
  (https://developers.google.com/identity/protocols/oauth2/web-server). Revocation: POST `https://oauth2.googleapis.com/revoke` with `token`.

**Discovery endpoints and fields**
- `GET https://www.googleapis.com/webmasters/v3/sites` → `siteEntry[]` of Sites resources: `siteUrl` (URL-prefix or Domain property) and
  `permissionLevel` ∈ `siteFullUser | siteOwner | siteRestrictedUser | siteUnverifiedUser` (https://developers.google.com/webmaster-tools/v1/sites).
  No paging is documented. `siteUnverifiedUser` sites are skipped (no data access).
- `GET https://analyticsadmin.googleapis.com/v1beta/accountSummaries`: `pageSize` default 50, max 200; `pageToken`; response
  `accountSummaries[]` (`name`, `account`, `displayName`, `propertySummaries[]` with `property` = `properties/{id}`, `displayName`,
  `propertyType`, `parent`) and `nextPageToken`.
- `GET https://analyticsadmin.googleapis.com/v1beta/{name=properties/*}` → Property with `name`, `displayName`, `timeZone` ("Reporting Time Zone,
  used as the day boundary for reports"), `currencyCode` ("The currency type used in reports involving monetary values"), `propertyType`, `parent`
  (https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties). Stored as `currency_code` / `time_zone`.
- `GET https://tagmanager.googleapis.com/tagmanager/v2/accounts` (`pageToken`, `includeGoogleTags`) → `account[]`, `nextPageToken`; Account fields
  `path, accountId, name, shareData, fingerprint, tagManagerUrl, features` (https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts).
- `GET https://tagmanager.googleapis.com/tagmanager/v2/{parent=accounts/*}/containers` (`pageToken`) → `container[]`, `nextPageToken`; Container
  fields `path, accountId, containerId, name, domainName, publicId, tagIds, features, notes, usageContext, fingerprint, tagManagerUrl,
  taggingServerUrls` (https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2/accounts.containers).

**Hosts used** (the transport's allow-list): `www.googleapis.com` (webmasters v3), `searchconsole.googleapis.com` (URL Inspection v1),
`analyticsadmin.googleapis.com`, `analyticsdata.googleapis.com`, `tagmanager.googleapis.com` — each from the request URLs on the pages above.

**Error mapping: partly unconfirmed.** None of the pages above document the error reasons for quota. Search Console's usage-limits page says
only that "the quota exceeded error is the same for all quota exceeded events" (https://developers.google.com/webmaster-tools/limits) without
naming a status or reason. The mapping therefore treats 429, `RESOURCE_EXHAUSTED`, and a 403 whose `errors[].reason` or ErrorInfo `reason`
mentions quota or rate limit (`quotaExceeded`, `rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`, `RATE_LIMIT_EXCEEDED`) as
`quota_exceeded`; any other 403 is `platform_permission_denied`. The GA4 `429 RESOURCE_EXHAUSTED` token-quota case is from the design's checked
facts. Confirm the exact Search Console and URL Inspection quota responses on the first live run.

**Not confirmed (do not depend on them):** the internal fields of `sites` entries beyond `siteUrl` / `permissionLevel`; whether
`webmasters/v3/sites` pages (assumed not, as documented); how Google reports the URL Inspection daily limit.

## Search Console tools (2026-11-10)

The 12 Search Console tools (`src/platforms/gsc/`, tests in `src/tests/gsc/`). Facts from the GSC plan's table
(`docs/superpowers/plans/2026-11-10-gsc-plan.md` §1, pages fetched 2026-11-10); the searchAnalytics.query page and the
search-appearance help page were fetched again while building (WebFetch, 2026-11-10). `WT` = `https://developers.google.com/webmaster-tools`.
Status: docs-checked, tested against a fake API, **not run against a real property**.

**searchAnalytics.query** (`WT/v1/searchanalytics/query`, re-checked): `POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query`,
`siteUrl` percent-encoded as one path segment. `startDate`/`endDate` required, `YYYY-MM-DD`, Pacific Time, inclusive.
`dimensions`: `country`, `device`, `page`, `query`, `searchAppearance`, `date`, `hour`. `type`: `web` (default), `image`, `video`, `news`,
`discover`, `googleNews`. `dimensionFilterGroups[].groupType` `and` only; filter `dimension` `country` (ISO 3166-1 alpha-3), `device`
(`DESKTOP`, `MOBILE`, `TABLET`), `page`, `query`, `searchAppearance`; `operator` `equals` (default), `notEquals`, `contains`, `notContains`,
`includingRegex`, `excludingRegex` (RE2); `expression` at most 4,096 characters. `aggregationType` `auto` (default), `byPage`, `byProperty`,
`byNewsShowcasePanel`: "If you group or filter by page, you cannot aggregate by property"; `byProperty` "Not supported for type=discover or
type=googleNews"; `byNewsShowcasePanel` needs a `NEWS_SHOWCASE` searchAppearance filter and type discover or googleNews, and no page grouping
or filter. `rowLimit` 1–25,000 (default 1,000); `startRow` zero-based, non-negative; page with `startRow` until a response has no rows
(`WT/v1/how-tos/all-your-data`). `dataState` `final` (default), `all` (fresh data), `hourly_all` ("should be used when grouping by the HOUR API
dimension"). Response `rows[] {keys, clicks, impressions, ctr, position}`, `responseAggregationType`, and `metadata.first_incomplete_date`
(`YYYY-MM-DD`) / `metadata.first_incomplete_hour` (`YYYY-MM-DDThh:mm:ss±hh:mm`). Rows sorted by clicks descending (by date when grouped by
date). At most 50,000 rows per day per site per search type; grouping by page or query can drop rows; anonymized queries are left out of rows
but counted in totals unless a filter is set; Discover has no queries or positions; searchAppearance "cannot be a column alongside other
dimensions" (query it alone, then filter by each value); data typically available after 2–3 days (find the latest day with a date query over
the past 10 days); 16 months of data kept.

**How the tools use it.** Every rule above is checked before any request (`validateQuery`, `checkDates`): searchAppearance alone, `hour` only
with `hourly_all` (the docs say "should"; enforced), no query dimension or filter for Discover or Google News, the `byProperty` and `byNewsShowcasePanel`
rules, start ≤ end ≤ today (Pacific Time), start ≥ today − 16 months. Named periods end on the latest day with final data (a 10-day date
query); if it finds none they end 3 days ago and say so. With `data_state` `all` or `hourly_all` a named period ends on today (Pacific Time,
`end_basis: today_fresh_data`) with no probe, so the fresh days the caller asked for are included. `compare_search_periods` refuses
`last_365_days` and `last_16_months` with the default previous period (two such periods do not fit in 16 months) and asks for explicit
`previous_start_date`/`previous_end_date`; `get_top_queries` offers neither Discover nor Google News. The client pages with `startRow`, asking for one row past the cap, and either refuses
with `row_cap` or (for tools that show a page) returns `truncated`; it never asks for more than 50,000 rows. Totals come from a second query
with no dimensions and the same filters, so they are Google's totals, never a sum of the rows shown.

**Search appearance values and names** (Search Console Help, https://support.google.com/webmasters/answer/17011259, re-checked):
`AMP_TOP_STORIES` AMP articles, `AMP_BLUE_LINK` AMP non-rich results, `AMP_IMAGE_RESULT` AMP on image result, `FORUMS` Discussion forums,
`EDU_Q_AND_A` Education Q&As, `JOB_DETAILS` Job details, `JOB_LISTING` Job listings, `MATH_SOLVERS` Math solvers, `ACTION` Media Actions,
`MERCHANT_LISTINGS` Merchant listings, `PRACTICE_PROBLEMS` Practice problems, `PRODUCT_SNIPPETS` Product snippets, `TPF_QA` Q&A rich results,
`RECIPE_FEATURE` Recipe galleries, `RECIPE_RICH_SNIPPET` Recipe rich results, `REVIEW_SNIPPET` Review snippet, `SUBSCRIBED_CONTENT` Subscribed
content, `TRANSLATED_RESULT` Translated results, `VIDEO` Videos, `AMP_STORY` Web Stories; deprecated: `SEARCH_APPEARANCE_ANDROID_APP`,
`EVENTS_DETAILS`, `EVENTS_LISTING`, `TPF_FAQ`, `PAGE_EXPERIENCE`, `TPF_HOWTO`, `LEARNING_VIDEOS`, `ORGANIC_SHOPPING`, `SPECIAL_ANNOUNCEMENT`,
`WEBLITE`. "Grouping by Search appearance will aggregate table data by page rather than by property." "All dates are in Pacific Time Zone (PT)."
Unknown values are passed through with `label: null`.

**Sites** (`WT/v1/sites`, `/sites/list`, `/sites/get`, `/sites/add`, `/sites/delete`): list `GET .../webmasters/v3/sites` → `siteEntry[]`
(no paging documented); get/add/delete `GET`/`PUT`/`DELETE .../sites/{siteUrl}`; add and delete take no request body and return an empty body;
delete "removes a site from the set of the user's Search Console sites". `permissionLevel` ∈ `siteOwner`, `siteFullUser`,
`siteRestrictedUser`, `siteUnverifiedUser`. URL-prefix properties need a trailing `/` (`WT/v1/urlInspection.index/inspect`).
Restricted users cannot submit sitemaps (Search Console Help, https://support.google.com/webmasters/answer/7687615).

**Sitemaps** (`WT/v1/sitemaps`, `/list`, `/get`, `/submit`, `/delete`): list `GET .../sites/{siteUrl}/sitemaps` (optional `sitemapIndex`) →
`sitemap[]` (no paging documented); get/submit/delete `GET`/`PUT`/`DELETE .../sitemaps/{feedpath}`, submit and delete with no body. WmxSitemap
fields `path`, `lastSubmitted`, `isPending`, `isSitemapsIndex`, `type` (`atomFeed`, `notSitemap`, `patternSitemap`, `rssFeed`, `sitemap`,
`urlList`), `lastDownloaded`, `warnings`, `errors`, `contents[] {type, submitted}`; `contents[].indexed` is deprecated and never read.

**URL Inspection** (`WT/v1/urlInspection.index/inspect`, `.../UrlInspectionResult`): `POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`,
body `inspectionUrl` (must be under `siteUrl`), `siteUrl`, optional `languageCode` (BCP-47, default en-US); it reports the indexed version, not a
live test. Result fields `inspectionResultLink`, `indexStatusResult` (`sitemap`, `referringUrls`, `verdict`, `coverageState`, `robotsTxtState`,
`indexingState`, `lastCrawlTime`, `pageFetchState`, `googleCanonical`, `userCanonical`, `crawledAs`), `ampResult`, `richResultsResult`
(`detectedItems[] {richResultType, items[] {name, issues[] {issueMessage, severity}}}`, `verdict`); `mobileUsabilityResult` is deprecated and
never read. Enum values explained by the tool: Verdict `PASS`, `PARTIAL`, `FAIL`, `NEUTRAL`; RobotsTxtState `ALLOWED`, `DISALLOWED`;
IndexingState `INDEXING_ALLOWED`, `BLOCKED_BY_META_TAG`, `BLOCKED_BY_HTTP_HEADER`, `BLOCKED_BY_ROBOTS_TXT`; PageFetchState `SUCCESSFUL`,
`SOFT_404`, `BLOCKED_ROBOTS_TXT`, `NOT_FOUND`, `ACCESS_DENIED`, `SERVER_ERROR`, `REDIRECT_ERROR`, `ACCESS_FORBIDDEN`, `BLOCKED_4XX`,
`INTERNAL_CRAWL_ERROR`, `INVALID_URL`; AmpIndexingState `AMP_INDEXING_ALLOWED`, `BLOCKED_DUE_TO_NOINDEX`, `BLOCKED_DUE_TO_EXPIRED_UNAVAILABLE_AFTER`.
Unknown values are passed through and called unrecognised.

**Scopes**: reads `webmasters.readonly` or `webmasters`; `sites.add`, `sites.delete`, `sitemaps.submit`, `sitemaps.delete` need `webmasters`
(each method page). **Quotas** (`WT/limits`): Search Analytics 1,200 queries/min per site and per user, plus a cost-based load quota (wait
15 minutes on short-term overage); URL Inspection 2,000/day and 600/min per site; other resources 20 QPS / 200 QPM per user. Error reasons
(`WT/v1/errors`): 403 `quotaExceeded`, `rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`, `limitExceeded`,
`concurrentLimitExceeded`, `servingLimitExceeded` are quota (the foundation maps all of them to `quota_exceeded`, tested in
`src/tests/gsc/client.test.ts`); `forbidden`, `insufficientPermissions` are permission.

**Google News** (Search Console Help, https://support.google.com/webmasters/answer/10083653, the Google News performance report): the
report has no query dimension and no position metric. **From the Help page, confirm live** (the API reference does not say it): the tools
treat `googleNews` like Discover (query dimension, query filter and query breakdown refused before any call; the no-query/no-position note is
added).

**Property membership** (`withinProperty`, used by `inspect_url` and `submit_sitemap`): a URL-prefix property matches by prefix after both
URLs are normalised by the WHATWG URL parser (host lower-cased, `.`/`..` and `%2e%2e` segments resolved), so
`https://example.com/blog/../admin` is not inside `https://example.com/blog/`.

**Write flow.** Each write plans read-only (property membership, the user's permission level, live state), stores a snapshot of only what a
person changes (never `isPending`, `lastDownloaded` or counts, which Google changes by itself), sends one body-less request after approval,
reads the result back (a failed read-back, including a 403 or 429 on that GET, is `unknown_outcome`) and verifies from live state. Risk: `submit_sitemap`, `add_gsc_site` write
(change set with a neutral effect, never automated); `delete_sitemap`, `remove_gsc_site` destructive (second approver).

**Inferred, not confirmed (safe choice taken):** `feedpath` is percent-encoded like `siteUrl` (only `siteUrl` has a documented example);
a sitemap outside the property is refused (docs do not say it must be inside); `sites.add` on an existing property is refused in planning
(docs do not say what Google does); a freshly added property is expected to read back as `siteUnverifiedUser`; what `sites.delete` does to
an owner's verification, other users and data is not documented (the summary says so); whether deleting a sitemap stops Google reading its
URLs is not documented (the summary says so); which permission levels may delete sitemaps (restricted and unverified users are refused);
`long` fields (`errors`, `warnings`, `submitted`) are read from numbers or numeric strings; the format of `hour` keys is undocumented (passed
through as given); a short page is not taken as the end (paging continues until an empty page); that the Search Console API also rejects
queries for `googleNews` (blocked from the Help page, see above); the URL Inspection quota error's status and whether day and minute limits can be
told apart (the message names both). Confirm these on the first live run.

## Tag Manager tools (2026-11-10)

The 12 Tag Manager tools (`src/platforms/gtm/`). Facts from the plan's table (`docs/superpowers/plans/2026-11-10-gtm-plan.md` §1),
checked on developers.google.com on 2026-11-10; `create_version`, `versions.publish` and `tags.update` were fetched again while
building (same date). `R` = `https://developers.google.com/tag-platform/tag-manager/api/reference/rest/v2`; requests go to
`https://tagmanager.googleapis.com/tagmanager/v2`. Tested against a fake API only (`src/tests/gtm/`), not a live container.

**Methods used (method, path, scope)**
- `accounts.containers.list` `GET {account}/containers` (`pageToken`, items `container`); `containers.get` `GET {container}`;
  read scope `tagmanager.readonly` (R/accounts.containers/list, /get). Container fields used: `path, containerId, name, publicId,
  domainName[], usageContext[]` (enum `web, android, ios, androidSdk5, iosSdk5, amp, server`), `tagIds[]` ("All Tag IDs that refer
  to this Container") (R/accounts.containers).
- `workspaces.list` `GET {container}/workspaces` (`pageToken`, items `workspace`); `workspaces.create` `POST {container}/workspaces`,
  scope `tagmanager.edit.containers`; `workspaces.getStatus` `GET {workspace}/status` → `workspaceChange: Entity[]`,
  `mergeConflict: MergeConflict[]` (R/accounts.containers.workspaces/list, /create, /getStatus). Entity: `changeStatus`
  (`none, added, deleted, updated`) plus one of `tag, trigger, variable, folder, client, transformation, zone, customTemplate,
  builtInVariable, gtagConfig` (R/Entity). MergeConflict: `entityInWorkspace`, `entityInBaseVersion` (absent: "the workspace
  entity is deleted from the base version") (R/MergeConflict).
- `workspaces.create_version` `POST {workspace}:create_version`, body VersionOptions `{ name, notes }`; response
  `containerVersion`, `syncStatus` ("Whether version creation failed when syncing the workspace to the latest container version"),
  `compilerError`, `newWorkspacePath` ("Auto generated workspace path created as a result of version creation"); scope
  `tagmanager.edit.containerversions`; the method "deletes the workspace" (R/accounts.containers.workspaces/create_version).
- `tags.list` / `tags.get` / `tags.create` (`POST {workspace}/tags`) / `tags.update` (`PUT {tag}`, body the whole Tag, query
  `fingerprint`: "When provided, this fingerprint must match the fingerprint of the tag in storage."), create/update scope
  `tagmanager.edit.containers` (R/accounts.containers.workspaces.tags/*).
- `triggers.list` / `get` / `create` (`POST {workspace}/triggers`, scope `edit.containers`); `variables.list`;
  `built_in_variables.list` ("Lists all the enabled Built-In Variables", items `builtInVariable`).
- `versions.live` `GET {container}/versions:live` ("the live (i.e. published) container version"); `versions.get`;
  `version_headers.latest` `GET {container}/version_headers:latest`; `versions.publish` `POST {version}:publish`, empty body,
  query `fingerprint` ("must match the fingerprint of the container version in storage"), response `{ containerVersion,
  compilerError }`, scope `tagmanager.publish` only (R/accounts.containers.versions/live, /get, /publish,
  R/accounts.containers.version_headers/latest).
- No list method takes a page size: only `pageToken` / `nextPageToken`.
- Quota: "0.25 queries per second (QPS) per project", "25 requests per 100 seconds", "10,000 requests per project per day"; over
  quota is HTTP 403 (https://developers.google.com/tag-platform/tag-manager/api/v2/limits-quotas). Enforced by the foundation's
  server-wide limiter (`beforeCall`), per request sent: reads are retried up to 3 times by the transport, so the limiter runs
  before every attempt (`SendRequest.beforeAttempt` in `src/platforms/core/http-core.ts`), not once per call.
- "When performing destructive operations using the API there will be no warnings, no confirmations, and no undo."
  (https://developers.google.com/tag-platform/tag-manager/api/v2/devguide) — publish is `destructive` and shows the full diff:
  added / removed tags, triggers and variables with every setting and parameter (one row each), changed ones field by field, coarse
  kinds (folders, templates, clients, zones, Google tag configs, transformations) with their settings as JSON. Code is never cut:
  custom HTML (`html` / key `html`), Custom JavaScript variables (`jsm` / key `javascript`) and template `templateData` each get
  their own row, in full; publish is refused when any of them is over 20,000 characters or the diff is over 300 rows. Other values
  are cut at 2,000 characters. Hosts named in code are listed as a best-effort aid ("hosts found: …" / "no host recognised"),
  never as a claim that the code contacts no host.

**Resource fields used**
- Tag: `tagId, name, type, parameter[], firingTriggerId[]` ("A tag will fire when any of the listed triggers are true and all of
  its blockingTriggerIds (if any specified) are false"), `blockingTriggerId[]`, `paused`, `liveOnly`, `tagFiringOption`
  (`unlimited, oncePerEvent, oncePerLoad`), `consentSettings { consentStatus: notSet | notNeeded | needed, consentType }`
  (consentType "must be of type LIST where each list item is of type STRING"), `scheduleStartMs`, `scheduleEndMs`,
  `setupTag[].tagName`, `teardownTag[].tagName`, `notes`, `fingerprint`, `monitoringMetadata` (R/accounts.containers.workspaces.tags).
- Parameter: `type` (`template, integer, boolean, list, map, triggerReference, tagReference`), `key`, `value`, `list`, `map`
  (R/Parameter). Callers may only set `template`, `boolean` ("true"/"false") and `integer` (base 10) values.
- Trigger: `triggerId, name, type, filter[]` ("fire iff all Conditions are true"), `customEventFilter[]`, `autoEventFilter[]`,
  `waitForTags`, `checkValidation`, `waitForTagsTimeout` ("Only valid for Form Submission and Link Click triggers"), `parameter[]`,
  `notes`. EventType values offered: `pageview, domReady, windowLoaded, customEvent, click, linkClick, formSubmission,
  historyChange` (R/accounts.containers.workspaces.triggers).
- Condition: `{ type, parameter[] }` with `arg0` (left operand, "must be a reference to a variable"), `arg1`, booleans `negate`
  and `ignore_case`; ConditionType offered: `equals, contains, startsWith, endsWith, matchRegex, greater, greaterOrEquals, less,
  lessOrEquals, cssSelector` (`urlMatches` left out: its operands are not documented) (R/Condition).
- Variable `variableId, name, type, parameter[], formatValue, notes`; BuiltInVariable `{ type, name }` with `name` "to be used to
  refer to the built-in variable" (types used: `event`) (R/accounts.containers.workspaces.variables, R/accounts.containers.versions).
- ContainerVersion `containerVersionId, name, description, deleted, fingerprint, tag[], trigger[], variable[], builtInVariable[],
  folder[], customTemplate[], client[], zone[], gtagConfig[], transformation[]`; CustomTemplate `templateId, name, templateData,
  galleryReference { owner, repository, version, isModified }`; GtagConfig `gtagConfigId, type, parameter[]` (R/accounts.containers.versions,
  R/accounts.containers.workspaces.templates, R/accounts.containers.workspaces.gtag_config).
- Workspaces per container: standard accounts "can add up to 2 additional workspaces" beside the Default Workspace
  (https://support.google.com/tagmanager/answer/7059647).

**Archived (Google removed these pages; read from the Wayback Machine copy of the official page)**
- Tag dictionary (https://web.archive.org/web/20250123113525/https://developers.google.com/tag-platform/tag-manager/api/v2/tag-dictionary-reference):
  type codes `html` (Custom HTML, parameter `html`), `img`, `awct` (Google Ads Conversion Tracking, keys `googleConversionId`,
  `googleConversionLabel`, listed only under Mobile Tags), `sp` (Google Ads Remarketing), `flc`/`fls`, `ga`, listeners
  `lcl, fsl, cl, tl, jel, hl`. Used only for `type_label`, Custom HTML creation (`html` / key `html`) and audit recognition.
- Parameter reference (https://web.archive.org/web/20250122235607/https://developers.google.com/tag-platform/tag-manager/api/v2/parameter-reference):
  template values may hold variable references like `foo{{bar}}`.

**Recognition outside the API reference**
- Destination IDs: Measurement ID `G-12345`, Google Ads conversion ID `AW-98765` (https://support.google.com/tagmanager/answer/12324787).
- Meta pixel base code: loader `connect.facebook.net/en_US/fbevents.js`, `fbq('init', '{pixel-id}')`, `fbq('track', 'PageView')`
  (https://developers.facebook.com/docs/meta-pixel/get-started).
- GA4 / Google tag type codes (`googtag`, `gaawc`, `gaawe`) are on **no** official page: GA4 is recognised by Measurement ID only, and
  GA4 / Google Ads tags are created only by copying an existing tag of the customer's container (`like_existing`).

**Not confirmed (handled defensively)**
- The status of a fingerprint mismatch (412 assumed; mapped to a definite `conflict` by the foundation). What `versions:live` and
  `version_headers:latest` return for a container without one (404 assumed → treated as none). Whether a new workspace starts from the
  latest version (execute re-reads the new workspace and refuses on any difference before sending). Whether workspace entity
  fingerprints equal the version's (drift is compared on content without location and fingerprint). Enum spelling on the wire
  (lower camel sent, read case-insensitively). Whether `publish` with `compilerError` leaves live unchanged (confirmed by reading live
  back). Name length limits and name uniqueness (the server refuses case-insensitive clashes itself). The id of built-in triggers
  such as All Pages (never invented; ids already on a tag are kept). Id fields of folders, clients, zones and transformations
  (the publish diff matches them by name). The Custom JavaScript variable's type `jsm` and code key `javascript` (Google's variable
  dictionary page is gone and its archive could not be fetched on 2026-11-10; these are the codes Tag Manager's own exports use): a
  `jsm` variable whose code sits under another key still has every parameter listed, cut at 2,000 characters.

## GA4 tools (2026-11-10)

Checked on developers.google.com on 2026-11-10 (WebFetch of each page; the plan's facts table, with the change-history,
realtime and audience pages fetched again while building). Base URLs: Data `https://developers.google.com/analytics/devguides/reporting/data/v1/` (D),
Admin `https://developers.google.com/analytics/devguides/config/admin/v1/rest/` (A). Used by `src/platforms/ga4/`. Nothing here has been tested
against a live property; mocked-API tests only.

| Claim | Result | Source |
|---|---|---|
| runReport endpoint | `POST https://analyticsdata.googleapis.com/v1beta/{property=properties/*}:runReport` | D `rest/v1beta/properties/runReport` |
| runReport body | `dimensions, metrics, dateRanges, dimensionFilter, metricFilter, offset, limit, metricAggregations, orderBys, currencyCode, cohortSpec, keepEmptyRows, returnPropertyQuota, comparisons` | same |
| `limit` / `offset` | limit default 10,000, max 250,000, positive; offset from 0. This server sends at most 10,000 per request (`HARD_ROW_CAP`) | same |
| `keepEmptyRows` | default false: rows whose metrics are all 0 are omitted | same |
| Filters | dimensionFilter cannot use metrics; metricFilter applies after aggregation and cannot use dimensions | same |
| Data API scopes | runReport, runPivotReport, runRealtimeReport, runFunnelReport, getMetadata, checkCompatibility: `analytics.readonly` or `analytics` (not `analytics.edit`) | each method page |
| Response | `dimensionHeaders, metricHeaders, rows, totals, maximums, minimums, rowCount, metadata, propertyQuota, kind`; `rowCount` = all rows of the result, independent of limit/offset | D `rest/v1beta/RunReportResponse` |
| Row values | `rows[].dimensionValues[].value`, `rows[].metricValues[].value` (strings; type from MetricHeader) | D `rest/v1beta/Row` |
| ResponseMetaData | `dataLossFromOtherRow, schemaRestrictionResponse, currencyCode, timeZone, emptyReason, subjectToThresholding, samplingMetadatas[]{samplesReadCount, samplingSpaceSize}` | D `rest/v1beta/ResponseMetaData` |
| Several date ranges | a `dateRange` column is added (`date_range_0`, `date_range_1`); custom range names may not start with `date_range_` or `RESERVED_` | D `basics`, D `rest/v1beta/DateRange` |
| DateRange formats | `YYYY-MM-DD`, `NdaysAgo`, `yesterday`, `today`; inclusive; relative forms evaluated in the property's reporting time zone | D `rest/v1beta/DateRange` |
| Per-request limits | up to 9 dimensions and 10 metrics | D `rest/v1beta/Dimension`, `.../Metric` |
| FilterExpression | one of `andGroup`, `orGroup` (`{expressions}`), `notExpression`, `filter`; Filter = `fieldName` + `stringFilter{matchType, value, caseSensitive}` / `inListFilter{values, caseSensitive}` / `numericFilter{operation, value}` / `betweenFilter{fromValue, toValue}` / `emptyFilter{}` | D `rest/v1beta/FilterExpression` |
| Enums | matchType `EXACT, BEGINS_WITH, ENDS_WITH, CONTAINS, FULL_REGEXP, PARTIAL_REGEXP`; numeric `EQUAL, LESS_THAN, LESS_THAN_OR_EQUAL, GREATER_THAN, GREATER_THAN_OR_EQUAL`; NumericValue `{int64Value}` or `{doubleValue}`; MetricAggregation `TOTAL, MINIMUM, MAXIMUM, COUNT` | same; D `rest/v1beta/MetricAggregation` |
| OrderBy | `{desc, metric{metricName}}` or `{desc, dimension{dimensionName, orderType}}`, orderType `ALPHANUMERIC, CASE_INSENSITIVE_ALPHANUMERIC, NUMERIC`; metricName must be a metric of the request | D `rest/v1beta/OrderBy` |
| getMetadata | `GET .../v1beta/{name=properties/*/metadata}` → `dimensions[], metrics[]`; MetricMetadata `apiName, uiName, description, deprecatedApiNames[], type, expression, customDefinition, blockedReasons[] (NO_REVENUE_METRICS, NO_COST_METRICS), category` | D `rest/v1beta/properties/getMetadata`, `MetricMetadata` |
| checkCompatibility | `POST .../v1beta/{property}:checkCompatibility`, body `dimensions, metrics, dimensionFilter, metricFilter, compatibilityFilter`; response `dimensionCompatibilities[]{dimensionMetadata, compatibility}`, `metricCompatibilities[]{metricMetadata, compatibility}`, `COMPATIBLE`/`INCOMPATIBLE` | D `rest/v1beta/properties/checkCompatibility` |
| runPivotReport | `POST .../v1beta/{property}:runPivotReport`; Pivot `fieldNames, orderBys, offset, limit, metricAggregations`; product of pivot limits ≤ 250,000; response `pivotHeaders[]{pivotDimensionHeaders, rowCount}, dimensionHeaders, metricHeaders, rows, aggregates, metadata, propertyQuota` | D `rest/v1beta/properties/runPivotReport`, `Pivot`, `RunPivotReportResponse` |
| runRealtimeReport | body `dimensions, metrics, dimensionFilter, metricFilter, limit, metricAggregations, orderBys, returnPropertyQuota, minuteRanges`; **no offset**; max 2 minuteRanges; Standard start/endMinutesAgo ≤ 29, 360 ≤ 59; default last 30 minutes; response has no `metadata` (re-fetched while building) | D `rest/v1beta/properties/runRealtimeReport` |
| Realtime schema | dims `appVersion, audienceId, audienceName, audienceResourceName, city, cityId, country, countryId, deviceCategory, eventName, minutesAgo, platform, streamId, streamName, unifiedScreenName, customUser:*`; metrics `activeUsers, eventCount, keyEvents, screenPageViews`. **No source/medium/campaign or page path** | D `realtime-api-schema` |
| runFunnelReport (v1alpha) | `POST https://analyticsdata.googleapis.com/v1alpha/{property}:runFunnelReport`; body `dateRanges, funnel, funnelBreakdown (limit default 5, max 15), funnelNextAction, funnelVisualizationType (STANDARD_FUNNEL, TRENDED_FUNNEL), segments, limit, dimensionFilter, returnPropertyQuota`; FunnelStep `name, isDirectlyFollowedBy, withinDurationFromPriorStep ("3.5s"), filterExpression{funnelEventFilter{eventName}}`; response `funnelTable{dimensionHeaders, metricHeaders, rows, metadata{samplingMetadatas}}`, table metrics `activeUsers, funnelStepCompletionRate, funnelStepAbandonments, funnelStepAbandonmentRate`; alpha, breaking changes possible | D `rest/v1alpha/properties/runFunnelReport`, D `funnels` |
| Quotas | Standard: 200,000 tokens/property/day, 40,000/property/hour, 14,000/project/property/hour, 10 concurrent; 360 ten times more; any bucket at 0 → `429 RESOURCE_EXHAUSTED`; daily reset midnight Pacific. PropertyQuota `tokensPerDay, tokensPerHour, concurrentRequests, serverErrorsPerProjectPerHour, potentiallyThresholdedRequestsPerHour, tokensPerProjectPerHour` each `{consumed, remaining}` | D `quotas`, D `rest/v1beta/PropertyQuota` |
| Schema names used | dims `date, eventName, sessionSource, sessionMedium, sessionCampaignName, sessionDefaultChannelGroup, sessionPrimaryChannelGroup, sessionManualSource, sessionManualMedium, sessionManualCampaignName, sessionManualAdContent, sessionManualTerm, sessionGoogleAdsCampaignId, sessionGoogleAdsCampaignName, sessionGoogleAdsAdGroupId, sessionGoogleAdsAdGroupName, sessionGoogleAdsKeyword, sessionGoogleAdsQuery, sessionGoogleAdsCustomerId, landingPage, landingPagePlusQueryString`; metrics `sessions, engagedSessions, engagementRate, bounceRate, averageSessionDuration, totalUsers, newUsers, eventCount, keyEvents, sessionKeyEventRate, totalRevenue, advertiserAdCost, advertiserAdClicks, returnOnAdSpend`; colon forms `customEvent:, customUser:, customItem:, sessionKeyEventRate:<event>` (`keyEvents:<event>` is NOT listed) | D `api-schema` |
| Meanings | `landingPage` = path of the session's first pageview; `sessionManualCampaignName` from `utm_campaign`; `sessionCampaignName` includes Google Ads, manual and other campaigns; marking a key event affects reports from creation on, not history | D `api-schema` |
| accountSummaries.list | `GET .../v1beta/accountSummaries`, pageSize default 50, max 200; `{name, account, displayName, propertySummaries[]{property, displayName, propertyType, parent}}`; readonly or edit | A `v1beta/accountSummaries/list` |
| properties.get | fields `name, propertyType, createTime, updateTime, parent, displayName, industryCategory, timeZone, currencyCode, serviceLevel (GOOGLE_ANALYTICS_STANDARD, GOOGLE_ANALYTICS_360), deleteTime, expireTime, account` | A `v1beta/properties` |
| dataStreams.list | pageSize max 200; `name, type (WEB_DATA_STREAM, ANDROID_APP_DATA_STREAM, IOS_APP_DATA_STREAM), displayName, webStreamData{measurementId, firebaseAppId, defaultUri}, androidAppStreamData{firebaseAppId, packageName}, iosAppStreamData{firebaseAppId, bundleId}` | A `v1beta/properties.dataStreams` |
| KeyEvent | `name, eventName (immutable), createTime, deletable, custom, countingMethod (required: ONCE_PER_EVENT, ONCE_PER_SESSION), defaultValue{numericValue, currencyCode}`; list pageSize max 200 (readonly or edit); create POST (edit); delete DELETE, empty body and response (edit) | A `v1beta/properties.keyEvents` and its methods |
| googleAdsLinks.list | pageSize max 200; `name` (link id, not the customer id), `customerId, canManageClients, adsPersonalizationEnabled, createTime, updateTime, creatorEmailAddress` (creator email not returned by our tool) | A `v1beta/properties.googleAdsLinks` |
| CustomDimension | `parameterName` (required, immutable; ≤ 24 chars user-scoped, ≤ 40 event-scoped; letters, digits, underscore, starts with a letter), `displayName` (required, ≤ 82, letters/digits/space/underscore, starts with a letter), `description` (≤ 150), `scope` (EVENT, USER, ITEM; immutable), `disallowAdsPersonalization` (user-scoped only); create needs `analytics.edit` | A `v1beta/properties.customDimensions` |
| Standard property limits | 30 key events, 100 audiences, 25 user-scoped and 50 event-scoped custom dimensions (enforced only for GOOGLE_ANALYTICS_STANDARD) | https://support.google.com/analytics/answer/12229528 (Google Help, not developers.google.com) |
| Audience (v1alpha) | `displayName` and `description` required; `membershipDurationDays` required, immutable, ≤ 540; `exclusionDurationMode` EXCLUDE_TEMPORARILY / EXCLUDE_PERMANENTLY; `filterClauses[]` required, immutable, ANDed; clause `clauseType` INCLUDE/EXCLUDE + `simpleFilter{scope, filterExpression}`; scope `AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS` (and within same event / session); top level must be `andGroup`, which holds only `orGroup`s, which hold no groups; `eventFilter{eventName}` (re-fetched while building) | A `v1alpha/properties.audiences` |
| audiences.create / list | `POST/GET https://analyticsadmin.googleapis.com/v1alpha/{parent=properties/*}/audiences`; create needs `analytics.edit` | A `v1alpha/properties.audiences/create`, `/list` |
| AttributionSettings (v1alpha) | `GET .../v1alpha/{name=properties/*/attributionSettings}`; `acquisitionConversionEventLookbackWindow` (`ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_7_DAYS`, `_30_DAYS`), `otherConversionEventLookbackWindow` (`OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS`, `_60_DAYS`, `_90_DAYS`), `reportingAttributionModel` (`PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN`, `PAID_AND_ORGANIC_CHANNELS_LAST_CLICK`, `GOOGLE_PAID_CHANNELS_LAST_CLICK`), `adsWebConversionDataExportScope` (`NOT_SELECTED_YET`, `PAID_AND_ORGANIC_CHANNELS`, `GOOGLE_PAID_CHANNELS`) | A `v1alpha/AttributionSettings` |
| searchChangeHistoryEvents | `POST https://analyticsadmin.googleapis.com/v1beta/{account=accounts/*}:searchChangeHistoryEvents`; body `property, resourceType[], action[], actorEmail[], earliestChangeTime, latestChangeTime, pageSize (default 50, max 200), pageToken`; response `changeHistoryEvents[]{id, changeTime, actorType, userActorEmail, changesFiltered, changes[]{resource, action, resourceBeforeChange, resourceAfterChange}}, nextPageToken`; **scope `analytics.edit` only** (re-fetched while building) | A `v1beta/accounts/searchChangeHistoryEvents` |
| Change history enums (v1beta) | resource types `ACCOUNT, PROPERTY, FIREBASE_LINK, GOOGLE_ADS_LINK, GOOGLE_SIGNALS_SETTINGS, CONVERSION_EVENT, MEASUREMENT_PROTOCOL_SECRET, CUSTOM_DIMENSION, CUSTOM_METRIC, DATA_RETENTION_SETTINGS, DISPLAY_VIDEO_360_ADVERTISER_LINK, DISPLAY_VIDEO_360_ADVERTISER_LINK_PROPOSAL, DATA_STREAM, ATTRIBUTION_SETTINGS`; actions `CREATED, UPDATED, DELETED` | same |
| ChangeHistoryResource (v1beta) | a union with exactly `account, property, firebaseLink, googleAdsLink, conversionEvent, measurementProtocolSecret, dataRetentionSettings, dataStream`; no `customDimension`, `attributionSettings` or other member, so changes to those resources carry only `resource` and `action`. `get_ga4_change_history` reads only these keys (anything else is ignored, `resource_kind` null) and removes every `*EmailAddress` key from resource bodies (e.g. the Google Ads link's output-only `creatorEmailAddress`, approved decision 10); `userActorEmail` is kept (review fix, 2026-11-10) | A `v1beta/accounts/searchChangeHistoryEvents#ChangeHistoryResource` |
| Funnel breakdown totals (v1alpha) | with `funnelBreakdown`, each step's total comes back "in a separate row having RESERVED_TOTAL as a breakdown dimension value"; only the first `limit` breakdown values are returned. `run_ga4_funnel_report` puts those rows in `step_totals[]`, never in `steps[]`, and adds a data-quality note when `breakdown_limit` values came back (breakdown rows may not sum to the total) (review fix, 2026-11-10) | D `funnels` |

**Not confirmed (not relied on; check on the first live run):**
- Whether `totals` cover all rows or only the returned page (knowledge: all rows). Tools label them "GA4's totals".
- Maximum number of `dateRanges` (knowledge: 4); tools send at most 2.
- Maximum funnel steps (not stated); `run_ga4_funnel_report` caps at 10 (our choice). `funnelStepName` value format: passed through.
- Event-name rules for `KeyEvent.eventName` (knowledge: ≤ 40 chars, starts with a letter): our regex is conservative, Google decides beyond it.
- `parameterName` length for ITEM scope (not stated): 40 allowed, Google decides.
- Whether custom-dimension or audience display names must be unique (not stated): tools refuse duplicates anyway (read-back needs a unique key).
- The error for creating a key event that already exists (not stated; an `ALREADY_EXISTS` maps to `conflict`). Tools refuse duplicates in plan.
- Quota cost of getMetadata and checkCompatibility (not stated).
- The stored format of `sessionGoogleAdsCustomerId` (with or without hyphens): filtered with digits only, and the empty-result note says so.
- Whether `customDimensions.list` includes archived dimensions (not stated).

## Combined tools (2026-11-10)

The 11 combined tools (`src/platforms/cross/`, plan `docs/superpowers/plans/2026-11-10-cross-plan.md`). They reuse the GSC,
GA4, GTM, Google Ads and Meta helpers, whose facts are recorded in the sections above. Only the fields below were new; each was
checked on the official page on 2026-11-10 (WebFetch). Every GAQL query the tools send is also checked against the v26 schema
and field-selection rules by the test guard (`src/tests/support/schema-guard.ts`). Tested against fakes only, not live accounts.

| Field / fact | Result | Source |
|---|---|---|
| `metrics.conversions` | "The number of conversions. This only includes conversion actions which include_in_conversions_metric attribute is set to true." | developers.google.com/google-ads/api/reference/rpc/v26/Metrics |
| `metrics.conversions_by_conversion_date` | Same set of actions; "When this column is selected with date, the values in date column means the conversion date." Used by compare_conversion_tracking to date conversions like GA4 (event date) | same |
| `metrics.all_conversions` | "includes all conversions regardless of the value of include_in_conversions_metric" (not used; recorded for the gap reasons) | same |
| Conversions reported on the click date | "Imported conversions are reflected in reports for the impression date of the original click", not the conversion date (offline-import page; the click-date wording in the gap reasons rests on this and on the conversions_by_conversion_date note) | developers.google.com/google-ads/api/docs/conversions/upload-clicks |
| `conversion_action.tag_snippets` | TagSnippet fields `type`, `page_format`, `global_site_tag`, `event_snippet` ("The event snippet that works with the site tag to track actions that should be counted as conversions"). The page gives **no example of `send_to`**: the `AW-<id>/<label>` form read from the snippet is Google's gtag convention, not stated on this page | developers.google.com/google-ads/api/reference/rpc/v26/TagSnippet |
| `customer.conversion_tracking_setting.conversion_tracking_id`, `.cross_account_conversion_tracking_id` | "The conversion tracking id used for this account" (does not indicate whether tracking is used); cross-account id "overrides conversion_tracking_id" when set | developers.google.com/google-ads/api/reference/rpc/v26/ConversionTrackingSetting (served the Customer field list) |
| `customer.auto_tagging_enabled`, `customer.tracking_url_template`, `customer.final_url_suffix`, `campaign.tracking_url_template`, `campaign.final_url_suffix`, `ad_group_ad.ad.final_urls` | Already used by other tools; selectable on these resources per the v26 schema index | inventory/google-ads-v26-schema.json |
| Meta AdCreative `url_tags` | "A set of query string parameters which will replace or be appended to urls clicked from page post ads" → url_tags win over the link's own parameters | developers.facebook.com/docs/marketing-api/reference/ad-creative/ |
| Meta AdCreative `asset_feed_spec` | "Used for Dynamic Creative…"; `link_urls[].website_url` is the shape create_meta_dynamic_creative_ad already writes | same; src/platforms/meta/tools/create.ts |
| Meta dynamic URL parameters (`{{campaign.name}}` …) | **Not confirmed**: the AdCreative reference does not document them, the Business Help page returned no body and the guessed developer page was 404. The tools therefore never resolve them: such campaigns are reported as unmatched (`dynamic_parameter`) with the raw template | (none) |
| Search Console regex filters | `includingRegex` uses RE2 (recorded in "Search Console tools"); brand patterns use character classes (`[aA]`) instead of the `(?i)` flag so no RE2 flag syntax is relied on | — |

**Caps and limits enforced by the tools (review fixes, 2026-11-10):** `MetaAdsClient.list` stops at 5,000 rows
(`HARD_ROW_CAP`, src/platforms/meta/client.ts), so the combined tools use at most 4,999 ads per account and ask for 5,000: a
full 5,000 means more ads exist (`complete: false`; campaigns with no ad read are `not_read_cap`). Search Console's latest
day with final data is read for explicit dates too, and a later `end_date` is refused (those days would read as zero). A UTM
pair several Meta campaigns share is never credited to one of them (`shared_utm_groups`). Tested against fakes only.

**Not confirmed (not relied on):** how GA4 stores `sessionGoogleAdsCustomerId` (so compare_conversion_tracking joins on campaign
id and lists GA4 campaigns not in the compared accounts instead of filtering by customer id); whether GA4's `landingPage` ever
contains a query string (the join strips one if present).

## Bing Webmaster tools (2026-11-10)

The Bing Webmaster connection and tools (`src/platforms/bing/`, tests in `src/tests/bing/`). Pages fetched 2026-11-10 (WebFetch).
`LB` = `https://learn.microsoft.com/en-us/bingwebmaster`, `API` = `https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces`.
Status: docs-checked, tested against a fake API, **not run against a real site**. Each section's tools add their own method facts below.

| Fact | Result | Source |
|---|---|---|
| Protocols | SOAP and POX are retired on 2026-08-31; JSON stays. JSON GET `https://ssl.bing.com/webmaster/api.svc/json/METHOD_NAME?apikey=...&param=...`, JSON POST `.../json/METHOD_NAME?apikey=...` | `LB/` (note), `LB/api-protocols` |
| OAuth API calls | Sample: `POST /webmaster/api.svc/json/SubmitUrl`, `Host: www.bing.com`, `Authorization: Bearer <access token>`, JSON body `{"siteUrl", "url"}`. **This server calls `https://www.bing.com/webmaster/api.svc/json/{Method}` with the Bearer token and never uses `apikey`.** Whether ssl.bing.com also takes Bearer tokens is not documented. Confirm on the first live run. | `LB/oauth2` step 6 |
| Authorize | `GET https://www.bing.com/webmasters/oauth/authorize` with `response_type=code`, `client_id`, `redirect_uri` (must match exactly), `scope` (space-separated). The redirect returns `code` or `error`. `state` is not documented but is sent (standard OAuth 2.0, RFC 6749) and checked by this server. No PKCE parameters are documented, so none are sent. | `LB/oauth2` steps 2–4 |
| Token | `POST https://www.bing.com/webmasters/oauth/token`, form-encoded `client_id`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri`; the code is valid for 5 minutes. Response `access_token`, `expires_in` (sample 3599), `refresh_token` ("valid until the user revokes access"), `token_type` Bearer. No `scope` field is documented. | `LB/oauth2` step 5 |
| Refresh | Same endpoint, `client_id`, `client_secret`, `refresh_token`, `grant_type=refresh_token` (the page's parameter table says `authorization_code`; its own sample and RFC 6749 say `refresh_token`, which is used). Response `access_token`, `expires_in`, `token_type`. A refresh token in the response, if any, replaces the stored one. | `LB/oauth2` step 7 |
| Scopes | `webmaster.read` (read), `webmaster.manage` (read and write). The scope list spells them `Webmaster.read` / `Webmaster.manage`; the authorize sample uses `webmaster.manage`. The sample's spelling is sent and a returned scope list is compared without case. | `LB/oauth2` "Authorization Scopes" |
| Revocation | No revoke endpoint is documented. Disconnect deletes the credentials here only; the Connections page tells the user to remove the app in Bing Webmaster Tools. | `LB/oauth2` (absent) |
| Response envelope | Success: `{"d": <result>}`; methods with no result answer `{"d": null}` | method pages (GetUserSites, SubmitUrlBatch) |
| Errors | "In case of an exception, HTTP status code 400 will be returned for POX and JSON formats", body `{"ErrorCode": 3, "Message": "InvalidApiKey"}` | `LB/getting-started` |
| ApiErrorCode | None 0, InternalError 1, UnknownError 2, InvalidApiKey 3, ThrottleUser 4, ThrottleHost 5, UserBlocked 6, InvalidUrl 7, InvalidParameter 8, TooManySites 9, UserNotFound 10, NotFound 11, AlreadyExists 12, NotAllowed 13, NotAuthorized 14, UnexpectedState 15, Deprecated 16 (no descriptions given). Mapping: `src/platforms/bing/http.ts` | `API.apierrorcode` |
| Dates | WCF JSON form `"/Date(1316156400000-0700)/"`, the same instant the XML sample shows as `2011-09-16T00:00:00-07:00` (milliseconds are UTC; the offset names the zone the day is rendered in) | GetQueryStats JSON and XML samples |
| GetUserSites | `GET`, no parameters. `Site {AuthenticationCode, DnsVerificationCode, IsVerified, Url}`. Discovery connects verified sites only and keeps `Url` exactly as returned | `API.iwebmasterapi.getusersites` |
| GetRankAndTrafficStats | `GET ?siteUrl`. `RankAndTrafficStats {Clicks, Date, Impressions}`. "The data will be updated every day. The traffic data includes Impressions and Clicks from all verticals i.e. Web, Chat, News, Images, Videos and Knowledge Panel from March 24th, 2023 onwards." No date-range parameter | `API.iwebmasterapi.getrankandtrafficstats` |
| GetQueryStats / GetPageStats | `GET ?siteUrl`. `QueryStats {AvgClickPosition, AvgImpressionPosition, Clicks, Date, Impressions, Query}` (for GetPageStats `Query` is the page URL). "The data will be updated every week." No date-range parameter: Bing returns its own window with one row per key and bucket date | `API.iwebmasterapi.getquerystats`, `.getpagestats` |
| SubmitUrlBatch | `POST {"siteUrl", "urlList": [...]}`, answers `{"d": null}`. "The max number of urls that can be submitted in a batch is 500 unless it exceeds the available quota. GetUrlSubmissionQuota(String) should be called to determine how much urls can be submitted." | `API.iwebmasterapi.submiturlbatch` |
| AI Performance (Copilot citations) | Not in the API reference as of 2026-11-10; third-party reports say it is UI-only. Not built. | `API.iwebmasterapi` (method list) |

### Index status, getting pages indexed and Fetch as Bingbot (2026-11-10)

Tools: `inspect_bing_url`, `get_bing_directory_index`, `get_bing_submission_quota`, `submit_bing_urls`, `submit_bing_content`
(`src/platforms/bing/tools/indexing.ts`), `fetch_url_as_bingbot`, `list_bing_fetched_urls`, `get_bing_fetched_url`
(`src/platforms/bing/tools/fetch.ts`); calls in `src/platforms/bing/api/indexing.ts`. Pages fetched 2026-11-10 (WebFetch). `API` as above.
None of the data contracts below has field descriptions on its page; tool output explains fields from their names and the samples and says so.

| Method | Verb, parameters | Returns | Remarks (quoted) and readings chosen | Source |
|---|---|---|---|---|
| GetUrlInfo | `GET ?siteUrl&url` | `UrlInfo {AnchorCount, DiscoveryDate, DocumentSize, HttpStatus, IsPage, LastCrawledDate, TotalChildUrlCount, Url}` (sample: a directory with `HttpStatus` 0, `DocumentSize` 0, `Url` "example.com") | "\"domain:\" prefix can be used to get information for domain." The JSON GET sample sends `url=%22example.com%22` (JSON-quoted) while `siteUrl` in the same sample is bare: values are sent bare, like `siteUrl`. `HttpStatus` 0 is read as "none". DocumentSize unit and the meaning of AnchorCount are not documented. No result (`{"d": null}`) is read as "Bing knows nothing about the URL". | `API.iwebmasterapi.geturlinfo`, `API.urlinfo` |
| GetUrlTrafficInfo | `GET ?siteUrl&url` | `UrlTrafficInfo {Clicks, Impressions, IsPage, Url}` | Same `domain:` remark. **No period is documented** for the clicks and impressions; the tools say so. | `API.iwebmasterapi.geturltrafficinfo`, `API.urltrafficinfo` |
| GetChildrenUrlInfo | **`POST`** (WebInvoke, although it only reads) `{siteUrl, url, page, filterProperties}`; `page` UInt16 | `UrlInfo[]` | Paging: the page's own C# example starts at page 0 and loops "while (values.Count > 0)"; page size undocumented, so the tool reads up to 10 pages and reports `next_page` when the last page read was not empty. JSON sample `filterProperties`: `{"__type":"FilterProperties:#Microsoft.Bing.Webmaster.Api","CrawlDateFilter":1,"DiscoveredDateFilter":0,"DocFlagsFilters":0,"HttpCodeFilters":0}` (enums as numbers). Sent through `readPost`. | `API.iwebmasterapi.getchildrenurlinfo` |
| GetChildrenUrlTrafficInfo | `GET ?siteUrl&url&page` | `UrlTrafficInfo[]` | No filters. Not documented to page the same way as GetChildrenUrlInfo: traffic is matched by URL and null when absent. | `API.iwebmasterapi.getchildrenurltrafficinfo` |
| FilterProperties | `CrawlDateFilter`, `DiscoveredDateFilter`, `DocFlagsFilters`, `HttpCodeFilters` | | CrawlDateFilter: Any 0, LastWeek 1, LastTwoWeeks 2, LastThreeWeeks 4. DiscoveredDateFilter: Any 0, LastWeek 1, LastMonth 2. DocFlagsFilters **[Flags]**: Any 0, IsBlockedByRobotsTxt 1, IsMalware 2. HttpCodeFilters **[Flags]**: Any 0, Code2xx 1, Code3xx 2, Code301 4, Code302 8, Code4xx 16, Code5xx 32, AllOthers 64. Flag lists are OR-ed. | `API.filterproperties`, `.crawldatefilter`, `.discovereddatefilter`, `.docflagsfilters`, `.httpcodefilters` |
| GetUrlSubmissionQuota | `GET ?siteUrl` | `UrlSubmissionQuota {DailyQuota, MonthlyQuota}` (sample 5 / 24) | Fields undescribed. SubmitUrl's remark ("GetUrlSubmissionQuota(String) should be called to determine how much urls can be submitted") is the basis for reading them as **what is left**. Reset times undocumented. | `API.iwebmasterapi.geturlsubmissionquota`, `API.urlsubmissionquota` |
| GetContentSubmissionQuota | `GET ?siteUrl` | `ContentSubmissionQuota {DailyQuota, MonthlyQuota}` (sample 100 / 3000) | Read as what is left, from SubmitContent's remark. | `API.iwebmasterapi.getcontentsubmissionquota`, `API.contentsubmissionquota` |
| SubmitUrl | `POST {siteUrl, url}` → `{"d": null}` | none | "It is possible to submit only limited number of url. GetUrlSubmissionQuota(String) should be called to determine how much urls can be submitted." Used for a single URL. | `API.iwebmasterapi.submiturl` |
| SubmitUrlBatch | `POST {siteUrl, urlList}` → `{"d": null}` | none | (see table above) at most 500 per batch. plan() refuses more URLs than min(daily, monthly) left; plan() runs again right before sending, so quota used up meanwhile is refused with nothing sent. The quota is not part of the drift snapshot (it changes by itself). The JSON sample's path spells `SubmitUrlbatch`; the method name `SubmitUrlBatch` is used. | `API.iwebmasterapi.submiturlbatch` |
| SubmitContent | `POST {siteUrl, url, httpMessage, structuredData, dynamicServing}` → `{"d": null}` | none | httpMessage: "HTTP status line, such as HTTP/1.1 200 OK, HTTP Headers, an empty line and optional HTTP message body data equivalent of the response based64 encoded if bingbot was fetching this URL. The request/status line and headers must all end with <CR> <LF> … The empty line must consist of only <CR> <LF>". structuredData: "Structured Data (typically JSON-LD ) provided based64 encoded … Empty if no structured data provided." dynamicServing: "{none = 0, PC-laptop = 1, mobile = 2, AMP = 3, tablet = 4, non-visual browser = 5}. Set this field to a value greater than 0 only if your web site dynamically serves different content based on customer devices". Remarks: "Currently, API Supports upto 10MB payload uncompressed for the content per request." **Contradiction:** the signature types dynamicServing as Int32 but the JSON sample sends `"0"` (a string); a JSON number is sent, per the signature. The 10 MB limit is applied to the encoded size (stricter reading); the tool's input caps (1,000,000-character body, 200,000-character structured data) keep every request under ~5 MB. The tool builds the HTTP message from the HTML it is given and never fetches the page. | `API.iwebmasterapi.submitcontent` |
| FetchUrl | `POST {siteUrl, url}` | none | No samples, no remarks. Changes nothing on the site; execute confirms the request appears (newer entry) in GetFetchedUrls, else `unknown_outcome`. | `API.iwebmasterapi.fetchurl` |
| GetFetchedUrls | `GET ?siteUrl` | `FetchedUrl[] {Date, Expired (bool), Fetched, Url}` | No samples. The meaning of Date, Fetched and Expired is not documented; passed on as reported. | `API.iwebmasterapi.getfetchedurls`, `API.fetchedurl` |
| GetFetchedUrlDetails | `GET ?siteUrl&url` | `FetchedUrlDetails {Date, Document (string), Headers (string), Status (string), Url}` | No samples; the encoding of Document is not documented (passed on as sent). All of it is the website's response relayed by Bing: untrusted text; the document is capped (default 20,000, at most 100,000 characters) and headers at 8,000, with the cut reported. | `API.iwebmasterapi.getfetchedurldetails`, `API.fetchedurldetails` |
| Read-back of submissions | none documented | | No method lists URL or content submissions or their status. execute treats Bing's success response as the only confirmation (quota after is informative, null if that read fails); verify returns `indeterminate` with that reason. | `API.iwebmasterapi` (method list) |

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
