# Plan approvals and decisions (2026-11-10)

The owner delegated approval of the three channel plans to the lead session. All three plans are approved with the decisions
below; where a plan's recommendation is accepted it is listed as "accepted". Builders follow their plan plus these decisions.

## Shared changes made by the lead before the builds (commit after 49532b9)
- `mapGapiError`: HTTP 412 (Tag Manager fingerprint mismatch) is a definite `conflict`; quota reasons now include every
  `*limitExceeded` reason (`limitExceeded`, `concurrentLimitExceeded`, `servingLimitExceeded`, ...).
- `GoogleApiClientOptions.beforeCall`: runs before every request. The GTM services branch uses it for a server-wide Tag
  Manager limiter (`GTM_RATE_BURST` 25, `GTM_RATE_PER_SEC` 0.25), refusing with `quota_exceeded` and nothing sent.
- The approval page shows up to 300 change rows for destructive approvals (50 otherwise).
- `todayIn` moved to `src/platforms/core/report-math.ts` (re-exported from `meta/insights.ts`).
- `create_gtm_tag` and `update_gtm_tag` are `high_impact` (inventory/mapping.ts), stricter than design section 6.
- `send()` with method PUT/DELETE and no body already sends no body (`body: undefined`).

## GSC plan (docs/superpowers/plans/2026-11-10-gsc-plan.md): approved
- Q1 accepted (point to list_accounts). Q2: no automatic refresh; the tool says to refresh on the Connections page.
- Q3 refuse adding an already-listed site. Q4 keep `remove_gsc_site` (destructive, `confirm_site_url`, summary states the
  effects are not documented). Q5 refuse sitemaps outside the property. Q6–Q16 accepted as recommended.
- The 403 quota reasons and body-less PUT/DELETE are handled in the foundation (above).

## GA4 plan (docs/superpowers/plans/2026-11-10-ga4-plan.md): approved
- 1 Realtime by page title / country / device / event, stated in every response: accepted.
- 2 Change history stays a read tool that needs a write (analytics.edit) connection, with a clear refusal otherwise: accepted.
- 3 v1alpha tools labelled, own files, no combined tool depends on funnels or attribution settings: accepted.
- 4 No metadata cache in v1: accepted. 5 GA4 totals labelled "GA4's totals": accepted.
- 6 Reduced audience input: accepted. 7 Standard-tier limits only on Standard properties: accepted.
- 8 `list_ga4_properties` per property: accepted. 9 digits-only Ads customer ids: accepted.
- 10 Drop creator email on Ads links; keep actor email in change history: accepted.
- 11 `todayIn` move: done by the lead (above); import it from core/report-math.

## GTM plan (docs/superpowers/plans/2026-11-10-gtm-plan.md): approved
- 1 Project-wide limiter: done in the foundation (above). Applying for a higher quota is a launch task for the owner.
- 2 412 → conflict: done in the foundation; no client wrapper needed.
- 3 Custom HTML allowed with the plan's limits (4,000 chars, full code in every approval, external hosts listed), and both
  tag-draft tools are high_impact (done in mapping).
- 4 Report and never touch the workspace Google creates after create_version: accepted.
- 5 Approval page shows up to 300 rows for destructive (done); publish still refuses a diff above 300 rows.
- 6 `list_gtm_containers` takes the `account_id` of a connected container and lists the containers of that GTM account from
  the API (no special context needed).
- 7–14 accepted as recommended.

## All builders
- Work only in your product folder (`src/platforms/<p>/`), your tests (`src/tests/<p>/`), your plan, your section of
  `docs/VERIFICATION.md`, and the tool's `implementation_status` line in `inventory/tool-registry.json`. If you believe a
  shared file must change, make the smallest change and say so in your report.
- `npx tsc --noEmit` and `npm test` green; `npm run inventory:matrix`; commit on your branch; never stage `.env.example`.
