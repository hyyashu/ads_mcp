# Design notes from Adspirer's public docs

Source: https://github.com/amekala/ads-mcp (MIT; docs, skills and plugin packaging only, **no server code**), read 2026-11-02.
Adspirer is a commercial hosted product. These are hints about tool behaviour, not verified facts about the Google or
Meta APIs. Every field and rule must still be checked against the official reference when its tool is built.

## Overlap with our inventory
- 96 of our 227 tool names appear in their docs. 131 do not (their docs only mention tools their skills use).
- Names in their docs that are not in our inventory: `create_display_campaign`, `get_meta_ad_performance`.
  Our inventory has no `create_display_campaign` (Display ad groups/ads exist, but no campaign creator): confirm with the owner whether it is wanted.
- Their README counts 151 Google and 58 Meta tools, versus our 167 and 60.

## Behaviour worth copying (to verify against official docs first)
- New campaigns are created **paused**; read the campaign back after creation to confirm budget, status and targeting.
- Keywords, negative keywords and ads attach to **ad groups**, not campaigns. Tools must take `ad_group_id`, and `get_campaign_structure` is how callers find ids. Guard against a campaign id being passed as an ad group id.
- `research_keywords` (planner volume) and `analyze_search_terms` (what people typed) are different things; do not blend them. A brand query in a non-brand campaign is a routing negative, not waste.
- Do not set target CPA/ROAS on a campaign with no conversion history (warn in the plan summary).
- Search campaigns should get sitelinks, callouts and structured snippets; a build is not "finished" without them (advice, not an API rule).
- Asset bundles prepared by `validate_and_prepare_assets` **expire after one hour**: that is their server's behaviour. In ours, prefer not to hold bundles at all: validate and create in one call, or store only a short-lived reference.
- Resolve place names with `resolve_google_locations` rather than letting callers guess geo ids.
- Meta ads need a Facebook `page_id` and an http(s) landing URL; collect them before building.
- Meta: three ad sets under one campaign is one campaign, not three; budget can sit at campaign or ad set level, not both (matches Meta's campaign reference).

## Unit conventions
- Their Meta tools take `daily_budget` as a **decimal in the ad account's currency**, not cents. That is their wrapper's convention. Meta's Graph API itself works in the currency's minor units (my recollection; the budget page did not state it). Our tools should do the same as our Google tools: accept decimals in account currency and convert, using the account's currency offset read from the API. Verify the conversion against a real ad account.
