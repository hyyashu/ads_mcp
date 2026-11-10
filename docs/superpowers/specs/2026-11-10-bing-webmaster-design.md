# Bing Webmaster Tools in JackOfAds: design

Date: 2026-11-10. Status: approved in chat by the owner (scope: "add all"; combined tools gain a Google / Bing / both choice).

## 1. Intent

JackOfAds already reads Google Search Console next to the ad accounts. This adds **Bing Webmaster Tools**, the Bing equivalent,
so an AI client can see Bing organic search next to Google organic and the ads. It also brings things Google's API does not
offer: keyword impression data from Bing, URL submission for indexing, and backlinks.

## 2. Goals, non-goals, anti-goals

**Goals**
- All 56 Bing tools listed in section 5, writes included, behind the existing approval flow.
- A **Connect Bing Webmaster** button using Bing's own OAuth, with read-only or allow-changes access like the other products.
- The existing combined search tools gain `search_engine: "google" | "bing" | "both"` (default `google`, so nothing changes for
  current users): `analyze_paid_organic_overlap`, `find_organic_keyword_gaps`, `find_converting_terms_without_content`,
  `analyze_brand_search_trend`. `audit_ad_landing_pages` also checks Bing index status when a Bing site is linked.

**Non-goals**
- Microsoft Advertising (Bing Ads) campaigns: a separate later project.
- Bing's AI Performance / Copilot citation report: not in the API.
- IndexNow (a separate protocol that needs a key file hosted on the customer's site).
- The three API methods Microsoft marks obsolete (GetDeepLink, GetDeepLinkAlgoUrls, UpdateDeepLink).
- The API-key login: keys are per user, unscoped and would travel in URLs.
- Storing any Bing data (fetched live, never stored).

**Anti-goals**
- Numbers that look precise but are not. Bing's query and page reports come in **weekly buckets over Bing's own window** with
  no date-range parameter. A Bing figure set beside a Google Ads period must say which Bing weeks it covers. It must never be
  presented as covering the exact same dates.
- Adding Google and Bing impressions together. The two engines count differently, so `both` shows them side by side, per engine.
- A write the approver cannot understand. Blocking pages, URL parameters, site moves and giving access change how Bing treats
  the whole site, so their summaries say so plainly.

## 3. Constraints (binding, from the existing codebase)

Inventory first (`inventory/tool-registry.json`, `inventory/mapping.ts`); no stubs; facts only from Microsoft's pages, recorded
in `docs/VERIFICATION.md` "Bing Webmaster tools (2026-11-10)"; writes go plan → approval → execute → verify, re-check state at
approval time, read back after, never retry a sent change; no silently cut lists; tenant scoping; handlers never see tokens.

## 4. Connection (decided)

- Platform key `bing_webmaster`, Connect slug `bing`, callback `/connect/bing/callback`.
- Env `BING_OAUTH_CLIENT_ID`, `BING_OAUTH_CLIENT_SECRET` (registered in Bing Webmaster Tools, Settings → API Access → OAuth Client).
- Scopes: read `webmaster.read`, write `webmaster.manage`.
- One account per **verified** site from GetUserSites (external id = `Url` exactly as returned).
- Disconnect is local only (Bing documents no revoke endpoint); the Connections page says so.
- A Bing site is linked to an ad account on the Connections page like a Search Console site.

## 5. Tools (56) and risk

Delete actions are destructive (repo rule). High impact: `add_bing_site_user`, `update_bing_crawl_settings`,
`add_bing_preview_block`, `add_bing_sitelink_block`, `add_bing_url_parameter`, `update_bing_url_parameter`,
`add_bing_country_targeting`. Destructive although they create something: `block_bing_url`, `submit_bing_site_move`.
Everything else that changes something is a plain write. Per-tool API methods: `inventory/mapping.ts`.

| Section | Tools |
|---|---|
| Sites and access | list_bing_sites, add_bing_site, verify_bing_site, remove_bing_site, list_bing_site_users, add_bing_site_user, remove_bing_site_user, get_bing_site_moves, submit_bing_site_move |
| Search performance | get_bing_search_performance, get_bing_top_queries, get_bing_top_pages, get_bing_query_pages, get_bing_page_queries, get_bing_query_page_detail, get_bing_query_trend, compare_bing_search_periods |
| Keyword research | get_bing_keyword_volume, get_bing_keyword_history, get_bing_related_keywords |
| Index status | inspect_bing_url, get_bing_directory_index |
| Getting pages indexed | submit_bing_urls, get_bing_submission_quota, submit_bing_content |
| Fetch as Bingbot | fetch_url_as_bingbot, list_bing_fetched_urls, get_bing_fetched_url |
| Crawl | get_bing_crawl_stats, get_bing_crawl_issues, get_bing_crawl_settings, update_bing_crawl_settings |
| Sitemaps | list_bing_sitemaps, get_bing_sitemap, submit_bing_sitemap, remove_bing_sitemap |
| Backlinks | get_bing_linked_pages, get_bing_backlinks, list_bing_connected_pages, add_bing_connected_page |
| Blocking | list_bing_blocked_urls, block_bing_url, unblock_bing_url, list_bing_preview_blocks, add_bing_preview_block, remove_bing_preview_block, list_bing_sitelink_blocks, add_bing_sitelink_block, remove_bing_sitelink_block |
| URL parameters | list_bing_url_parameters, add_bing_url_parameter, update_bing_url_parameter, remove_bing_url_parameter |
| Country targeting | list_bing_country_targeting, add_bing_country_targeting, remove_bing_country_targeting |

## 6. Build (decided)

Shared groundwork first (connection, token refresh, transport, client, `api/traffic.ts`, test fake and harness, inventory),
then one agent per section group, each in its own worktree and files (`src/platforms/bing/tools/<section>.ts`,
`src/platforms/bing/api/<section>.ts`, `src/tests/bing/<section>.test.ts`), then one merge that wires `bingTools` and runs the
full suite.

## 7. Owner launch tasks

Register the Bing OAuth client with redirect `${PUBLIC_URL}/connect/bing/callback`, set the two env vars, and run one live
read-only check (it confirms the API host accepts Bearer tokens at www.bing.com).
