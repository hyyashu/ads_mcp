# Search Console, GA4 and Tag Manager in JackOfAds: design

Date: 2026-11-10. Status: draft for owner approval.

## 1. Intent

JackOfAds (this repo, `ads_mcp`) is a multi-tenant SaaS MCP server: agencies and businesses connect their ad accounts and let
an AI client (Claude, ChatGPT, Cursor) analyse and change their ads, with every change approved by a person. Today it only
sees what the ad platforms report about themselves.

This adds the three Google products a good performance marketer checks next to the ad accounts:

- **Google Search Console (GSC)**: what people search to find the site for free.
- **Google Analytics 4 (GA4)**: what visitors actually do on the site after a click.
- **Google Tag Manager (GTM)**: whether the tracking that feeds both the ads and GA4 is set up right.

The reason is **better ad decisions**. The combined tools in section 5 are the point of the project. The plain GSC, GA4 and GTM
tools exist because the combined tools are built on them, and because an AI client needs them to explain what it found.

## 2. Goals, non-goals, anti-goals

**Goals**
- All 54 tools in section 5, including writes for all three products, behind the existing approval flow.
- One **Connect** button per product (Search Console, Google Analytics, Tag Manager), each asking only for that product's
  access, separate from Connect Google Ads.
- Combined tools that join ad data with GSC and GA4 data for the same business, so an AI client can answer
  "should we stop paying for this term?", "where do our ad clicks go to waste?" and "is our tracking lying to us?".

**Non-goals (this project)**
- Google's Indexing API ("request indexing"). Officially it covers only job-posting and livestream pages, so it is left out
  rather than offered for pages it does not support.
- GA4 property, account or data-stream creation and deletion, user and access management, BigQuery/DV360/SA360/Firebase links,
  measurement protocol secrets. GTM container creation and deletion, user permissions, environments, server-side clients.
- Storing any GSC, GA4 or GTM data (same rule as ad data: fetched live, never stored).
- Industry benchmarks or predictions of any kind.

**Anti-goals (would make this a failure even if it works)**
- A number that looks precise but is wrong: a total over a partial list, a "conversion gap" caused by a date or time zone
  mismatch, a Meta traffic figure that silently missed untagged campaigns. Every combined tool says what it could not match.
- Claiming causation. The brand-trend tool shows a trend next to ad spend; it never says the ads caused it.
- A GTM publish that the approver could not understand. Publishing changes a customer's live website with no undo through the API.
- Asking a new customer for every Google permission at once.

## 3. Constraints (from the existing codebase, all binding)

- **Inventory first.** A tool exists only if it is in `inventory/tool-registry.json`; the registry rejects anything else
  (`src/mcp/registry.ts`). The 54 tools are added there with new platform keys, and `docs/TRACKING.md` is regenerated
  (`npm run inventory:matrix`).
- **No stubs.** A tool is exposed only with a real handler, input and output schemas, declared permissions and tests.
- **Docs discipline.** Use only fields, enums and limits confirmed on Google's official pages; record each in
  `docs/VERIFICATION.md`. Where a field cannot be confirmed, do not use it.
- **Writes** go through plan → approval → execute → verify (`src/security/approvals.ts`), re-check state at approval time,
  refuse on drift, read back the result, and never retry a sent mutation. Risk tiers in section 6.
- **No silently cut lists.** Clients refuse past their row cap unless a tool shows a page and reports `truncated`
  (the convention from PR #18).
- **Tenancy.** Every lookup is scoped to the caller's tenant; ids of other tenants cannot be probed.
- **Tokens never reach handlers.** Handlers get clients only (`src/platforms/services.ts`).

## 4. Connections (decided)

**Owner decision: each product gets its own Connect button.**

- Three new Connect flows on the Connections page: **Search Console**, **Google Analytics**, **Tag Manager**. Each is a
  separate Google OAuth grant (its own `platform_connection` row and refresh token) asking only for that product's scopes,
  with a read or write choice like Google Ads today. *(Builder's call, made here: same Google OAuth client as Ads,
  separate grants, no `include_granted_scopes`, so disconnecting one product never affects another.)*
- Scopes (confirmed in Google's docs unless marked):
  - GSC: read `webmasters.readonly`, write `webmasters` (confirmed on the searchAnalytics.query page).
  - GA4: read `analytics.readonly`, write `analytics.edit` *(from knowledge: confirm on the Admin API pages)*.
  - GTM: read `tagmanager.readonly` *(from knowledge: confirm)*; write `tagmanager.edit.containers`,
    `tagmanager.edit.containerversions`, `tagmanager.publish` (names listed in the GTM developer guide; what each allows must be
    confirmed on the authorization page).
- After connecting, discovery creates one `connected_account` row per **GSC site** (external id = the site URL or
  `sc-domain:` property), per **GA4 property** (`properties/123`), and per **GTM container** (`accounts/1/containers/2`). Tools
  name them by `account_id` exactly as ad accounts are named today; `list_accounts` lists them with their platform.
- New platform keys: `google_search_console`, `google_analytics`, `google_tag_manager`.

**Links between an ad account and its site, property and container.** The combined tools need to know which GSC site and
GA4 property belong to which ad account. A tenant sets these links on the Connections page (new table, tenant-scoped, many
ad accounts may share one site or property). `get_property_links` reads them. Combined tools take the ad account's `account_id`
and use the saved link, or an explicit `site_account_id` / `property_account_id` argument that overrides it (it must be a
connected account of the same tenant). With neither, the tool fails with a clear message saying what to link.

**Launch dependency (not a build task):** for outside customers, Google requires OAuth app verification for these scopes,
as it does for Ads. It affects launch timing, not the build; plan for it.

## 5. Tools (54)

All reads unless marked. Names follow the existing style; descriptions say what the tool returns, plainly.

### 5.1 Search Console (12: 8 reads, 4 writes)
Facts confirmed in Google's docs: `searchAnalytics.query` groups by `country, device, page, query, searchAppearance, date,
hour`; `type` = `web` (default), `image, video, news, discover, googleNews`; filters with `contains, equals, notContains,
notEquals, includingRegex, excludingRegex` (AND only); `rowLimit` 1 to 25,000 with `startRow`; `dataState` `final` (default),
`all`, `hourly_all`; dates in Pacific Time. Quotas: Search Analytics 1,200 queries/min per site and per user; URL Inspection
600/min and 2,000/day per site.

| Tool | Kind | What it does |
|---|---|---|
| `list_gsc_sites` | read | Connected sites with permission level |
| `get_search_performance` | read | Clicks, impressions, CTR, position by any allowed dimensions, filters, type, period; pages through up to the cap, reports `truncated` |
| `get_top_queries` | read | Shortcut: top queries by clicks for a site and period |
| `get_top_pages` | read | Shortcut: top pages by clicks |
| `compare_search_periods` | read | Queries or pages that rose or fell between two periods, with the change in clicks, impressions, position |
| `get_search_appearance` | read | Performance by search appearance (rich result types) |
| `inspect_url` | read | Index status of one URL and why it is not indexed; says when the daily inspection quota is used up |
| `list_sitemaps` | read | Submitted sitemaps, errors, warnings, last read |
| `submit_sitemap` | write | Submit a sitemap URL on the site |
| `delete_sitemap` | write | Remove a submitted sitemap |
| `add_gsc_site` | write | Add a site to the connected user's Search Console (ownership must still be verified in Search Console; the tool says so). Acts on the GSC connection; the new site appears as an account after discovery |
| `remove_gsc_site` | write | Remove a site from the connected user's Search Console |

### 5.2 GA4 (18: 14 reads, 4 writes)
Facts confirmed: Data API `runReport`, `runPivotReport`, `batchRunReports`, `runRealtimeReport`, `getMetadata`,
`checkCompatibility` (v1beta), `runFunnelReport` (v1alpha). Session dimensions include `sessionSource`, `sessionMedium`,
`sessionCampaignName`, `sessionDefaultChannelGroup`, `sessionManual*` (UTM), `sessionGoogleAds*` (campaign, ad group, keyword,
**query**), `landingPage`; metrics include `sessions`, `engagedSessions`, `engagementRate`, `bounceRate`, `keyEvents`,
`sessionKeyEventRate`, `totalRevenue`, `purchaseRevenue`, `advertiserAdCost`, `returnOnAdSpend`. **There are no Meta
dimensions**: Meta traffic is matched through UTM tags only. Quotas: 200,000 tokens per property per day and 40,000 per hour
(Standard), 10 concurrent requests; `returnPropertyQuota` reports what is left. Admin API reads: account summaries,
properties, data streams, key events, Google Ads links, custom dimensions, attribution settings (v1alpha), change history.

| Tool | Kind | What it does |
|---|---|---|
| `list_ga4_properties` | read | Connected properties: time zone, currency, data streams |
| `get_ga4_metadata` | read | Dimensions, metrics and key events available in a property |
| `run_ga4_report` | read | General report: validated dimensions, metrics, filters, date ranges, order, limit; checks compatibility first |
| `run_ga4_pivot_report` | read | Pivot report |
| `run_ga4_funnel_report` | read | Funnel report (v1alpha API: label it as such) |
| `get_ga4_realtime` | read | Active users now by source and page |
| `get_traffic_by_channel` | read | Sessions, engagement, key events, revenue per default channel group |
| `get_campaign_traffic` | read | Same by session source, medium, campaign (UTM) |
| `get_landing_page_performance` | read | Engagement rate, key events, revenue per landing page |
| `get_google_ads_traffic_in_ga4` | read | GA4's Google Ads dimensions: campaign, ad group, keyword, search query → on-site behaviour |
| `get_conversion_events` | read | Key events and their counts in a period, to check tracking works |
| `get_ga4_ads_links` | read | Google Ads accounts linked to the property |
| `get_ga4_attribution_settings` | read | Attribution model and lookback windows (v1alpha) |
| `get_ga4_change_history` | read | Recent configuration changes |
| `create_key_event` | write | Mark an event as a key event (conversion) |
| `remove_key_event` | write | Unmark it |
| `create_custom_dimension` | write | Create a custom dimension |
| `create_ga4_audience` | write | Create an audience (v1alpha API) |

### 5.3 Tag Manager (12: 7 reads, 5 writes)
Facts confirmed: accounts, containers, workspaces (create, getStatus, create_version, sync), tags, triggers, variables,
built-in variables, versions (get, live, publish), version headers. Only `versions.publish` changes the live site;
`workspaces.create_version` creates a version without publishing. Google's guide warns that destructive operations have no
confirmation or undo.

| Tool | Kind | What it does |
|---|---|---|
| `list_gtm_containers` | read | Connected containers and their public ids |
| `get_gtm_live_version` | read | What is live: tags, triggers, variables |
| `list_gtm_tags` / `list_gtm_triggers` / `list_gtm_variables` | read | In a workspace (default: the one the server uses, see below) |
| `get_gtm_workspace_status` | read | Changed and conflicting entities in a workspace |
| `audit_gtm_container` | read | Rule-based check of the live version: GA4 configuration tag present, Google Ads conversion and remarketing tags, Meta pixel (custom HTML recognised by its documented snippet), duplicates, paused tags, tags with no firing trigger |
| `create_gtm_tag` | write | Create a tag in a workspace (draft only) |
| `update_gtm_tag` | write | Update a tag in a workspace (draft only) |
| `create_gtm_trigger` | write | Create a trigger in a workspace (draft only) |
| `create_gtm_version` | write | Turn a workspace into a version (not live) |
| `publish_gtm_version` | write | Publish a version: the only tool that changes the live site |

*(Builder's call, made here: writes happen in one workspace per container named "JackOfAds" that the server creates on first
use, never in the customer's Default Workspace, so their own drafts are untouched.)*

### 5.4 Connections (1)
| Tool | Kind | What it does |
|---|---|---|
| `get_property_links` | read | Which GSC site, GA4 property and GTM container are linked to each ad account |

### 5.5 Combined tools (11, all read-only)
Each one states its rules, the period and time zone it used, and what it could not match (untagged campaigns, URLs with
no data, rows past a cap). Periods are aligned explicitly: GSC dates are Pacific Time, Ads and GA4 use the account's or
property's time zone; a tool that compares them says so and uses whole days.

| Tool | Joins | Answers |
|---|---|---|
| `analyze_paid_organic_overlap` | Google Ads search terms + GSC queries | Paid terms where the site already ranks in the top N organically (N an input, default 3), with the paid spend on them. Candidates to cut or lower bids, not instructions |
| `find_organic_keyword_gaps` | GSC + Google Ads keywords | Queries with many impressions and low CTR or poor position that the account does not bid on: candidates to add |
| `audit_ad_landing_pages` | Ads final URLs (Google and/or Meta) + GA4 landing pages + GSC URL inspection | Per landing page: GA4 engagement and key-event rate, and index status (inspection is quota-limited, so it samples and says so) |
| `compare_conversion_tracking` | Google Ads or Meta conversions + GA4 key events | Per campaign: conversions each side reports, the gap, and the known reasons a gap is normal (attribution model, window, time zone). Flags gaps beyond a threshold |
| `analyze_meta_traffic_quality` | Meta campaigns (`url_tags`) + GA4 UTM sessions | What Meta clicks do on the site, per campaign, plus a list of Meta campaigns it could not match |
| `get_channel_mix` | GA4 (+ ad spend from linked ad accounts) | Paid, organic and other channels: sessions, key events, revenue, and share of each |
| `check_utm_tagging` | Google Ads + Meta + GA4 | Campaigns with missing or inconsistent UTMs; whether Google Ads auto-tagging is on |
| `analyze_brand_search_trend` | GSC + ad spend | Branded organic impressions and clicks over time next to ad spend. Brand terms are an input. A trend only, no causal claim |
| `find_converting_terms_without_content` | Google Ads search terms + GSC | Paid terms that convert but where the site gets no organic impressions: content ideas |
| `audit_tracking_setup` | GTM + GA4 + Google Ads conversion actions + Meta pixel | Does each conversion exist end to end? Flags one defined in one place but missing in another |
| `analyze_paid_search_on_site` | GA4 `sessionGoogleAdsQuery` | Which paid search queries bring visitors who engage and convert on the site |

## 6. Write risk tiers (builder's calls, recorded here)

Existing tiers: `write` (one approval), `high_impact` and `destructive` (a second person must approve; destructive also warns).

| Tool | Tier | Why |
|---|---|---|
| `submit_sitemap`, `add_gsc_site` | write | Reversible, no effect on ads |
| `delete_sitemap`, `remove_gsc_site` | destructive | Removes configuration the customer may rely on |
| `create_key_event` | high_impact | Changes what counts as a conversion; affects Smart Bidding when imported into Ads |
| `remove_key_event` | destructive | Same, and loses the conversion going forward |
| `create_custom_dimension`, `create_ga4_audience` | write | Additive |
| `create_gtm_tag`, `update_gtm_tag`, `create_gtm_trigger`, `create_gtm_version` | write | Draft only, nothing goes live |
| `publish_gtm_version` | destructive | Changes the live site. The approval page shows a readable diff against the live version (tags, triggers, variables added, changed, removed) |

Destructive changes are never approved by a workspace automation rule (`src/policy/automation.ts` already refuses them), so
every GTM publish and every removal needs a person.

*(Builder's calls, made here:)* `add_gsc_site` names its Search Console connection through any site account of that
connection (`account_id`); if the connection has no sites yet, it is added from the Connections page instead. A connection has
one access level per product (read or write); GTM write asks for the edit, version and publish scopes together.

Verify step per write: read the object back (sitemap listed, key event present, tag in workspace, live version id equals the
published one). A publish whose result is unclear is `unknown_outcome` and never retried, as today.

## 7. Left to the builder

- Module layout under `src/platforms/` (one adapter per product, or one Google-analytics family), client classes, HTTP error
  mapping (follow `google/http.ts`), and how combined tools obtain a second product's client for a linked account (today a
  tool gets services for one account; extend the factory or the pipeline).
- The link table schema and the Connections page UI for links.
- Exact input and output schemas, caps and defaults, within section 3.
- How `audit_gtm_container` and `audit_tracking_setup` recognise tags: only by documented tag types and snippets.
- Batch order: suggested sequence is connections and discovery, GSC reads, GA4 reads, combined tools, GTM reads, then writes.
- Tests with fake APIs, matching the existing `src/tests` style, including row caps and quota errors (GA4 `429
  RESOURCE_EXHAUSTED`, URL inspection daily limit).
