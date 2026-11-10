# Combined tools: build plan (2026-11-10)

Design: `docs/superpowers/specs/2026-11-10-gsc-ga4-gtm-design.md` §5.5 (what each tool answers), §2–3 (no fake precision,
say what could not be matched, no causal claims). Contract: `2026-11-10-foundation-contract.md` (tools in
`src/platforms/cross/`, exported as `crossTools`, platform fixed per tool, second accounts only through `ctx.linked` /
`ctx.accountFor`). Branch `feat/cross-tools` from `feat/gsc-ga4-gtm` @69380de. All 11 tools are read-only.

## 1. Shared rules (src/platforms/cross/common.ts)

**Choosing the other accounts.** Each other product has an argument (`site_account_id`, `property_account_id`,
`google_ads_account_id(s)`, `meta_account_id(s)`, `container_account_id`). Order:
1. An explicit id wins. It goes through `ctx.accountFor(platform, id)`: this workspace and that platform only; another
   workspace's id, an unknown id or an account of another platform is `not_found` (never a different error).
2. Otherwise `ctx.linked(platform)` (links set on the Connections page).
3. A **required** product with no link: `invalid_argument` "No Search Console site is linked to this Google Ads account.
   Link one on the Connections page, or pass site_account_id." With **more than one** link for a single-account role: the
   same code, listing the linked ids and asking for the argument (never a silent pick).
4. **Optional** products (spend next to a trend, Meta in a landing-page audit, sources of the tracking audit) that are not
   linked are left out and listed in `coverage.not_checked` with the reason. Multi-account roles (ad spend, UTM checks) use
   every linked account.

**Periods (whole days).** Input: `days` (7–90, default 28) or `start_date` + `end_date` (YYYY-MM-DD, inclusive). The same
calendar dates are sent to every source, each evaluated in its own zone: Google Ads in the account's time zone, Meta in the
ad account's, GA4 in the property's reporting zone, Search Console in Pacific Time (`America/Los_Angeles`). A named period
ends on the latest day that is complete in every zone involved (yesterday in the earliest zone); when Search Console is
involved, also no later than its latest day with final data (one `date` query, as the GSC tools do). Explicit dates may not be
after today in any zone involved; GSC's 16-month limit is checked. With Search Console involved, an explicit `end_date` after
its latest day with final data (else 3 days ago, Pacific) is refused with `invalid_argument` naming the day to use: those days
have no final organic data and would read as zero (a fake drop in a brand trend, terms "without organic impressions"). Every output has `period { start_date, end_date, days,
time_zones[{source, account, time_zone}], notes }`; when zones differ the note says day boundaries differ by the offset and
that figures are not hour-aligned. An unknown zone is reported as unknown.

**Normalisation.**
- Search terms / queries: Unicode NFKC, lower case, trimmed, runs of whitespace collapsed to one space. Joins are exact on
  this form: no stemming, plurals, word order or close variants. Stated in `rules`.
- Landing URLs: parsed as URLs; host lower-cased; query string and fragment dropped (this removes UTM and click ids); path
  percent-decoded where valid; a trailing `/` removed except for the root. GA4's `landingPage` is a path without host or
  query, so the join with GA4 is on that path; ads URLs on different hosts with the same path share one GA4 row (said in the
  output when it happens). URL inspection uses the ad's final URL without query and fragment, and only URLs inside the GSC
  property (`withinProperty`).
- UTM values from Meta: query of the creative link plus `url_tags` (Meta: url_tags "replace or be appended to" clicked URLs, so
  url_tags wins per key). Compared with GA4 `sessionManualSource` / `sessionManualCampaignName` case-insensitively after
  trimming. A value containing `{{…}}` (a Meta dynamic URL parameter) is **not** resolved: Meta's developer pages checked do
  not document how they resolve, so those campaigns go to `unmatched` with reason `dynamic_parameter` and the raw template.
- Shared UTM pairs: claimants are counted per `utm_source|utm_campaign` key across every campaign (with insights in the
  period) of every Meta account in the call. A key claimed by more than one campaign is credited to none: GA4 cannot tell
  which campaign a session came from. Its GA4 figures are reported once under `shared_utm_groups` (with the campaigns sharing
  it) and are left out of per-campaign rows, comparisons and summary totals. A campaign whose pairs are all shared is
  unmatched with reason `shared_utm` (detail names the other campaign ids, with the account when it differs); a campaign with
  unique pairs too is credited with the unique ones only and lists the shared ones in `shared_utm_not_credited`.
- Google Ads campaigns ↔ GA4: on campaign id (`sessionGoogleAdsCampaignId`), never on name.

**Lists and caps.** Every list in an output carries `{ total, returned, truncated }`; `limit` (default 50, max 500) caps
what is shown, never what is computed. Source caps, all reported in `coverage`: Google Ads search terms 10,000 rows by cost
(GAQL page limit; `complete: false` when the cap is reached); Search Console 25,000 query rows (`partial`, `truncated`
flag); GA4 10,000 rows per report (`row_count` vs returned); Meta 4,999 ads (5,000 are asked for, the Meta client's hard
cap, so getting 5,000 back sets `truncated`; campaigns with no ad among those read are unmatched as `not_read_cap`, not
`no_ads_read`) and 2,000 insight rows. A truncated source is
named in `coverage.notes` with its effect on the result (e.g. "a term listed as without organic impressions may have some").

**Output frame (all tools).** `period`, `accounts` (each source: platform, account_id, external id, name, time zone,
currency), `rules` (each rule with its inputs and defaults, as text), `coverage` (`sources[]` with rows read / complete,
`not_checked[]`, `notes[]`), the tool's result lists, and `unmatched` where the tool joins two sides.

## 2. Tools

| Tool | Platform (account_id) | Other accounts | Data pulled | Join / rules (defaults) |
|---|---|---|---|---|
| `analyze_paid_organic_overlap` | google_ads | GSC site (required, `site_account_id`) | Ads `search_term_view`: term, impressions, clicks, cost_micros, conversions, conversions_value for the dates; GSC `query` rows (web, final) | term = query (normalised). Overlap when GSC position ≤ `top_n` (3) and GSC impressions ≥ `min_impressions` (10); sorted by paid cost. Unmatched: paid terms with no GSC row (count + top by cost). Candidates only |
| `find_organic_keyword_gaps` | google_ads | GSC site (required) | GSC `query` rows; Ads `ad_group_criterion` keywords (positive and negative, not removed) and campaign negative keywords; Ads search terms for the dates | Gap: impressions ≥ `min_impressions` (100) and (CTR ≤ `max_ctr` (0.02) or position > `min_position` (10)) and the normalised query equals no positive keyword text (any match type). Flags `excluded_by_negative` and `has_paid_search_term_traffic` |
| `audit_ad_landing_pages` | google_ads | GA4 property (required), GSC site (optional), Meta ad account (optional, explicit `meta_account_id` only: links are per pair, a Meta account is not linked to a Google Ads account) | Ads `ad_group_ad.ad.final_urls` with clicks/impressions/cost for the dates (ads not removed); Meta ads `creative{object_story_spec,asset_feed_spec,url_tags}` (link); GA4 `fetchLandingPages`; GSC `inspectUrl` for a sample | Join on path. Per page: ad clicks/cost, ads count, GA4 sessions, engagement rate, key events, session key-event rate; index verdict for the sampled pages. Sample = top `inspect_max` (10, max 50) pages by ad clicks inside the property; quota hit → the rest marked `not_inspected: quota`, said in coverage |
| `find_converting_terms_without_content` | google_ads | GSC site (required) | Ads search terms with conversions; GSC `query` rows | Term with conversions ≥ `min_conversions` (1) whose normalised form has no GSC row with impressions > 0 in the same dates. Notes: anonymised queries, GSC row cap |
| `analyze_meta_traffic_quality` | meta_ads | GA4 property (required) | Meta campaign insights (spend, clicks, inline_link_clicks, conversions); ads with creative link + url_tags; GA4 `fetchCampaignTraffic(utm_only)` | Campaign ↔ GA4 rows where utm_source and utm_campaign equal (case-insensitive). Per campaign: sessions, engaged sessions, engagement rate (engaged / sessions of the matched rows), key events, revenue, sessions per link click. Unmatched: no ads read, ads not read (cap), no utm_campaign, dynamic parameter, shared UTM pair, no GA4 sessions. Shared pairs reported once in `shared_utm_groups`; GA4 Meta-like sources (facebook, fb, instagram, ig, meta, an.) not claimed by any campaign |
| `compare_conversion_tracking` | google_analytics | Google Ads (`google_ads_account_ids`, else all linked) and/or Meta (`meta_account_ids`, else all linked); at least one | Ads `campaign` with `metrics.conversions_by_conversion_date` (event date, closer to GA4) and `metrics.conversions`; GA4 `fetchGoogleAdsTraffic(level campaign)` key events; Meta campaign insights conversions + url_tags matching as above with GA4 manual UTM rows (one join over all Meta accounts, so a pair shared across accounts is never credited twice; shared pairs go to `shared_utm_groups`, outside rows and totals) | Per campaign: both counts, gap, relative gap = \|a−b\| / max(a,b). Flag when both sides ≥ `min_conversions` (5) or one side ≥ it, and relative gap > `gap_threshold` (0.25). Fixed list of reasons a gap can be normal (attribution, click vs event date, counting, which actions count, time zones, consent/ad blockers). No side is called right |
| `get_channel_mix` | google_analytics | Google Ads and Meta (all linked or explicit), optional | GA4 `fetchChannelTraffic`; Ads `customer` cost for the dates; Meta account insights spend | Channels with sessions, key events, revenue and share of GA4's totals. Spend per ad account in its own currency, never summed across currencies and never assigned to a GA4 channel |
| `check_utm_tagging` | google_analytics | Google Ads and Meta (all linked or explicit) | Ads `customer.auto_tagging_enabled`, account and campaign tracking template / final URL suffix; Meta ads url_tags + link; GA4 manual UTM rows | Ads: auto-tagging off (high); manual utm_ in templates/suffix (info). Meta per campaign: tagged / partly / untagged on utm_source, utm_medium, utm_campaign; several utm_campaign values in one campaign; dynamic parameters listed. GA4: source/medium/campaign values that differ only by case; source set but medium `(not set)` |
| `analyze_paid_search_on_site` | google_analytics | none | GA4 `fetchGoogleAdsTraffic(level query)` | Buckets: converting (key events > 0), engaged without key events (engagement rate ≥ `engaged_rate` 0.5, sessions ≥ `min_sessions` 10), low engagement (rate < `low_rate` 0.2, sessions ≥ min). `(not set)` query share reported |
| `analyze_brand_search_trend` | google_search_console | Google Ads and Meta (all linked or explicit), optional | GSC `date` rows filtered by brand regex (built from `brand_terms`, case-insensitive by character classes, RE2) and unfiltered `date` totals; Ads `customer` daily cost; Meta account insights daily spend | Daily or weekly (Mon-start) series: branded clicks/impressions, all clicks/impressions, branded share, spend per account. Descriptive comparison of first and second half only. Output says: a trend, no causal claim |
| `audit_tracking_setup` | google_tag_manager | GA4 property, Google Ads, Meta (each optional, linked or explicit) | GTM `readLiveForAudit` + `recogniseGa4/GoogleAds/MetaPixel`, GA4 tags' `eventName`; GA4 data streams, key events and 28-day counts (`fetchKeyEventCounts`); Ads `conversion_action` (enabled, `tag_snippets`) and `customer.conversion_tracking_setting`; Meta `adspixels` (id, last_fired_time) | Per conversion, where it is defined: GA4 key event ↔ GTM GA4 event tag; Ads conversion action (send_to `AW-id/label` from its event snippet) ↔ GTM awct tag (id + label); Meta pixel ↔ GTM pixel base code. Flags: defined in one place, missing in another; measurement id in GTM not a stream of the property; key event with no events |

## 3. Tests (src/tests/cross/)

One harness wires the existing fakes (`fakeGoogle`, `FakeGsc`, `fakeGa4`, `FakeGtm`, a small Meta fake on `metaPage`) into one
`createServicesFactory`, seeds one account per platform plus links, and a second workspace. Per tool: the join and rules on
fixtures; link missing → `invalid_argument` naming what to link; two links → asks for the argument; explicit id of another
workspace → `not_found`; truncation (`limit`, source caps) and `unmatched` reporting; time-zone notes. Plus quota during URL
inspection, dynamic Meta parameters, case variants in UTMs.

## 4. Verification

New API fields (not used before) recorded in `docs/VERIFICATION.md` under "Combined tools (2026-11-10)": Google Ads
`metrics.conversions_by_conversion_date`, `conversion_action.tag_snippets` (TagSnippet.event_snippet),
`customer.conversion_tracking_setting.*`, `customer.tracking_url_template` / `final_url_suffix`; Meta AdCreative `url_tags`,
`asset_feed_spec`. All GAQL is also checked against the v26 schema by the test guard.
