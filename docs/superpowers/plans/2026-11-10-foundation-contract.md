# Foundation contract: Search Console, GA4 and Tag Manager

Design: `docs/superpowers/specs/2026-11-10-gsc-ga4-gtm-design.md` (approved by the owner on 2026-11-10).
Integration branch: `feat/gsc-ga4-gtm`. Nothing is merged to `main` (it auto-deploys); the owner merges the final PR.

The foundation is built first, by one builder, so the three channel builders (GSC, GA4, GTM) and the combined-tools builder
only add files in their own folders plus one-line registrations. Everything below is binding for all of them.

## Platform keys and accounts
- `src/inventory.ts` `PLATFORMS` gains `google_search_console`, `google_analytics`, `google_tag_manager`.
- One `connected_account` row per GSC site, GA4 property and GTM container, created by discovery after Connect.
  `external_id`: GSC = the site URL exactly as Search Console returns it (`https://example.com/` or `sc-domain:example.com`);
  GA4 = `properties/123`; GTM = `accounts/1/containers/2`. `account_id` in tools accepts this server's id or that external id
  (`src/auth/accounts.ts`). GA4 rows store the property's `currencyCode` and `timeZone` (from the Admin API) in
  `currency_code` / `time_zone`; GSC and GTM leave them null.
- `access` (read | write) per connection, as for ads. Write tools need write access, as today.

## Connect flows (one per product)
- Three Connect buttons on `/connections`: Search Console, Google Analytics, Tag Manager, each with read / write choice.
  Same Google OAuth client and token handling as Google Ads (`src/auth/platform-oauth.ts`, `src/auth/token-providers.ts`),
  each its own grant and `platform_connection`. Callback paths `/connect/gsc/callback`, `/connect/ga4/callback`,
  `/connect/gtm/callback` (the builder may choose one shared Google callback if it keeps the platform in the state row).
- Scopes: GSC read `webmasters.readonly`, write `webmasters`. GA4 read `analytics.readonly`, write `analytics.edit`.
  GTM read `tagmanager.readonly`, write `tagmanager.readonly tagmanager.edit.containers tagmanager.edit.containerversions
  tagmanager.publish`. All prefixed `https://www.googleapis.com/auth/`. Confirm each on Google's docs before use; the granted
  scopes are checked on callback exactly as for Ads.
- Discovery: GSC `GET https://www.googleapis.com/webmasters/v3/sites`; GA4 Admin `accountSummaries.list` then `properties.get`
  for currency and time zone; GTM `accounts.list` then `accounts.containers.list`. Disconnect revokes as for Ads.

## Transport and clients
- `src/platforms/gapi/http.ts`: `GoogleApiHttp.call<T>({ accessToken, method?, url, params?, body?, idempotent, signal? })`
  built on `sendWithRetry` (`src/platforms/core/http-core.ts`), with Google API error mapping (400 invalid_argument,
  401 auth_expired, 403 platform_permission_denied or quota_exceeded for quota reasons, 404 not_found, 409 conflict,
  429 quota_exceeded with retry-after when given, 5xx transient). `url` must be https on one of: `www.googleapis.com`,
  `searchconsole.googleapis.com`, `analyticsdata.googleapis.com`, `analyticsadmin.googleapis.com`,
  `tagmanager.googleapis.com`; anything else is refused.
- `src/platforms/gapi/client.ts`: `GoogleApiClient` base: `read(url, params?)`, `query(url, body)` (POST that only reads,
  idempotent), `send(method, url, body?)` (mutation: abort check, counts `mutationsSent`, never retried), and
  `pages(url, params, { itemsKey, maxRows, partial? })` that follows `nextPageToken` and, like the ads clients since PR #18,
  refuses with `unsupported` (`details.reason = "row_cap"`) past `maxRows` unless `partial`.
- Per product (foundation creates them with the constructor and the bits discovery needs; channel builders add methods):
  `src/platforms/gsc/client.ts` `GscClient` (knows `siteUrl`), `src/platforms/ga4/client.ts` `Ga4Client` (knows
  `property`, `currencyCode`, `timeZone`), `src/platforms/gtm/client.ts` `GtmClient` (knows `containerPath`).
- Services: `GscServices { gsc; mutationsSent }`, `Ga4Services { ga4; mutationsSent }`, `GtmServices { gtm; mutationsSent }`
  in each folder's `services.ts`; one branch per platform in `src/platforms/services.ts`.

## Tools
- Declaration helpers in `src/platforms/<p>/tools/common.ts`: `gscRead`/`gscWrite`, `ga4Read`/`ga4Write`, `gtmRead`/`gtmWrite`
  via `platformTools` (`src/platforms/core/tool-defs.ts`), with platform permission notes naming the scopes.
- Each folder's `index.ts` exports `gscTools` / `ga4Tools` / `gtmTools` (start empty); `src/platforms/index.ts` registers them.
  Combined tools live in `src/platforms/cross/` and export `crossTools`.
- Inventory: all 54 tools from the design are added to `inventory/tool-registry.json` (status pending) and to the plan in
  `inventory/mapping.ts` with the risk tiers of design section 6 (reads `read`). A builder flips a tool to implemented only
  with handler, schemas and tests. `npm run inventory:matrix` regenerates `docs/TRACKING.md`.
- Combined tools' platforms (the account named by `account_id`):
  `analyze_paid_organic_overlap`, `find_organic_keyword_gaps`, `audit_ad_landing_pages`, `find_converting_terms_without_content`
  → `google_ads`; `analyze_meta_traffic_quality` → `meta_ads`; `compare_conversion_tracking`, `get_channel_mix`,
  `check_utm_tagging`, `analyze_paid_search_on_site` → `google_analytics`; `analyze_brand_search_trend` →
  `google_search_console`; `audit_tracking_setup` → `google_tag_manager`; `get_property_links` → `google_analytics`
  (account_id optional is NOT allowed by the pipeline unless the builder confirms how `list_accounts` does it; follow that).

## Links between accounts
- Table `account_link (id, tenant_id, account_a_id, account_b_id, created_at)`: an undirected link between two connected
  accounts of the same tenant (stored with a < b), unique per pair, cascade on delete. Managed on `/connections`
  (owners and admins, CSRF), never by an MCP tool.
- Tool context gains two helpers (tenant-scoped, read access required, ids of other tenants report `not_found`):
  `ctx.linked(platform)` → the accounts of that platform linked to the tool's account (array, with their services);
  `ctx.accountFor(platform, accountId)` → an explicitly named account of this tenant on that platform, with its services.
  Combined tools use an explicit id argument when given, else the links, else fail with a message saying what to link.

## Rules every builder follows
- Only fields, enums, limits and scopes confirmed on Google's official docs (developers.google.com); record each in
  `docs/VERIFICATION.md` with the URL. Unconfirmed: do not use.
- No stubs, no fake success, no stored analytics data. Writes: plan (snapshot) → approval → execute → verify; never retry a
  sent mutation.
- Tests in `src/tests/<p>/` with fake APIs in the existing style; `npx tsc --noEmit` and `npm test` green before handing back.
- Never stage `.env.example` (the owner's uncommitted edit). Commit only your own paths.
