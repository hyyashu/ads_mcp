# ads-mcp

A remote MCP server (Streamable HTTP), product name JackOfAds, for Google Ads, Meta Ads, Google Search Console, Google
Analytics 4, Google Tag Manager and Bing Webmaster Tools: 382 tools from `inventory/tool-registry.json`, implemented against the official
platform APIs. Advertising and analytics data is fetched on demand and never stored.

## Status (read this first)

**379 of 382 tools are implemented**: 211 Google Ads, 60 Meta Ads, 12 Search Console, 18 GA4 (plus the cross-product
`get_property_links`), 12 Tag Manager, 54 Bing Webmaster Tools, and 11 combined tools that join ad data with Search
Console (or Bing, or both) and GA4 (for example paid vs organic overlap, conversion tracking gaps, landing page quality,
tracking setup audit). The remaining three are documented external limitations: `create_youtube_campaign` (the Google
Ads API cannot create Video campaigns), and `add_bing_preview_block` and `add_bing_sitelink_block` (Microsoft does not
document values they must send). Search Console, GA4 and Tag Manager each have their own Connect button and Google
grant; Bing Webmaster has its own Connect button on Bing's OAuth. A workspace links a site, property and container to
its ad accounts on the Connections page, and the combined tools use those links. Designs:
`docs/superpowers/specs/2026-11-10-gsc-ga4-gtm-design.md`, `docs/superpowers/specs/2026-11-10-bing-webmaster-design.md`. `docs/TRACKING.md` (generated) lists every tool, its plan and its status. A tool is exposed only
when it has a real handler, input and output schemas, documented permissions and tests; there are no stub or
fake-success tools.

On 2026-11-11, 20 duplicate Google Ads tools were retired, and `remove_extensions` was added in place of four of them. The
retired tools are mostly Display-only copies of general tools (`add_display_audiences`, `remove_display_ad`, ...); clients
use the general tool instead, for example `get_ad_group_audiences` with `campaign_type: "DISPLAY"`. The note in
`inventory/tool-registry.json` lists each retired name and its replacement.

**"Implemented" means tested against crafted API responses, not against a real account.** Google tools are checked
against Google's published v26 schema ("schema-checked (v26), not live"); Meta tools were built from Meta's reference
docs ("docs-checked, not live"); Search Console, GA4 and Tag Manager tools were built from Google's reference pages
and Bing Webmaster tools from Microsoft's API reference, recorded per product in `docs/VERIFICATION.md`. Nothing has run against a live ad account yet (`inventory/live-verified.json` is
empty). See `docs/VERIFICATION.md` for what was checked against which page.

Tests (`npm test`) cover the MCP transport (2026-07-28 and 2025-era clients), the tool registry and its rules, the
MCP-client OAuth server, Google/Meta/Bing connection flows, human approvals, crash reconciliation, shared rate limiting,
the GAQL builder, both platform clients and every tool.

## Architecture

```
MCP client (Claude, ChatGPT, Cursor)             Human in a browser
   | Bearer access token (OAuth 2.1 + PKCE)         | session cookie + CSRF
   v                                                v
 /mcp  ----------------------+              /login /authorize /approvals /connections
   |  pipeline: scope -> rate limit -> validate -> resolve authorized account -> handler -> validate output
   v
 src/platforms/google | meta  (tool definitions)  ->  GoogleAdsClient / Meta client  ->  official REST APIs
```

| Module | Role |
|---|---|
| `src/mcp` | MCP server and Streamable HTTP transport, tool registry (rejects non-compliant tools), call pipeline, structured errors |
| `src/auth` | **MCP-client OAuth** (`oauth-server.ts`) and, separately, **platform OAuth** (`platform-oauth.ts`: connect Google/Meta/Bing), web sessions, token providers |
| `src/platforms/google` | GAQL builder, REST transport and error mapping, Ads client, tool definitions |
| `src/platforms/{meta,gsc,ga4,gtm,bing}` | One folder per other product: transport or client, services, tool definitions |
| `src/platforms/cross` | Combined tools that join ad accounts with their linked Search Console / Bing site and GA4 property |
| `src/security` | AES-256-GCM credentials, approval service, rate limiters (memory and Postgres), audit |
| `src/db` | Drizzle schema (Postgres). Stores tenants, users, encrypted connection credentials, account associations, approvals, usage counters, minimal audit. **No campaign, metric, creative or lead data.** |
| `inventory` | The 382-tool source of truth, the implementation plan (`mapping.ts`), documented limitations |

### Two separate OAuth systems

1. **MCP-client OAuth** (this server is the resource server and authorization server): protected resource metadata
   (`/.well-known/oauth-protected-resource`), authorization server metadata, PKCE `S256` required, `resource` binding,
   public clients, Client ID Metadata Documents (SSRF-hardened fetch) and dynamic registration, rotating refresh tokens
   with reuse detection, revocation. Tokens are audience-bound; there is no token passthrough. Clients can be granted
   `ads:read` and `ads:write` only. **Approval is never grantable to a client.**
2. **Platform OAuth** (connecting ad accounts): Google (authorization code + PKCE, offline access), Meta (long-lived
   token, `appsecret_proof`) and Bing Webmaster (authorization code with Bing's own OAuth client, refresh token).
   Credentials are encrypted at rest, bound to their row, revoked at the platform on disconnect (Bing documents no
   revoke call, so a Bing disconnect is local and the user removes the app in Bing Webmaster Tools), and a
   revoked/expired grant flips the connection to `needs_reauth`.

### Writes and approvals

A modifying tool never changes anything directly. It plans against live state (read-only) and queues an approval. A
signed-in owner or admin approves in the browser (`/approvals`, CSRF-protected). The MCP client can never approve: only
a person signed in to the web app can. Workspace automation rules may auto-approve matching changes, never destructive ones. Identical requests are deduplicated; approval re-plans and refuses if the account changed since the
request; a crash or ambiguous failure becomes `unknown_outcome` and is **never retried automatically**. A background job
reconciles it by asking the platform (`verify()` on every write tool) and only then lets a human re-approve.

### Google Ads access model

Developer tokens were sunset on **2026-09-09** (confirmed from Google's developer-token page via search results). API
access levels (Test, Explorer, Basic, Standard) now attach to the **Google Cloud project that generated the OAuth
credentials**. No developer token is configured or sent. `login-customer-id` (the manager account to act through) is
stored per connected account. Google Ads API versions are retired on a schedule, so `GOOGLE_ADS_API_VERSION` has no
default and must be set deliberately.

## Run

```bash
npm install
cp .env.example .env              # set ADS_MCP_KEYS (openssl rand -base64 32) and PUBLIC_URL
set -a; . ./.env; set +a
npm run db:migrate                # embedded Postgres in .data/pglite, or set DATABASE_URL
ADS_MCP_OWNER_PASSWORD='a-long-password' npm run tenant:create -- "My Agency" owner@example.com
npm start                         # MCP endpoint: $PUBLIC_URL/mcp
npm test                          # 1,239 tests
npm run inventory:matrix          # regenerate docs/TRACKING.md
```

Sign in at `$PUBLIC_URL/login`, open **Connections** to connect Google/Meta/Bing, and point an MCP client at `$PUBLIC_URL/mcp`
(it discovers OAuth through the 401 challenge). Cursor and other header-capable clients can also use a personal token
issued with `issueApiToken` (read/write scopes only).

## Deployment

- Postgres: set `DATABASE_URL`, run `npm run db:migrate`. Do not use the embedded database in production.
- Serve behind TLS; set `PUBLIC_URL` to the https origin (required when `NODE_ENV=production`). Set `TRUST_PROXY=1` only behind a trusted proxy.
- Keys: `ADS_MCP_KEYS` supports rotation (add a new version, it encrypts new data; old versions still decrypt). Prefer unwrapping the keyring from a KMS at boot.
- Multiple instances: keep `RATE_LIMIT_STORE=db` (shared, atomic Postgres token buckets). The server is otherwise stateless.
- Register redirect URIs: Google `${PUBLIC_URL}/connect/google/callback`, `${PUBLIC_URL}/connect/gsc/callback`,
  `${PUBLIC_URL}/connect/ga4/callback`, `${PUBLIC_URL}/connect/gtm/callback` (same Google OAuth client), Meta
  `${PUBLIC_URL}/connect/meta/callback`, Bing `${PUBLIC_URL}/connect/bing/callback`. Enable the Search Console, Google
  Analytics Data, Google Analytics Admin and Tag Manager APIs on the Google Cloud project.
- Google: create a Cloud project, enable the Google Ads API, request Basic/Standard access for that project, set the OAuth consent screen (the `adwords` scope is sensitive and needs verification for external users).
- Bing: in Bing Webmaster Tools open Settings → API Access → OAuth Client, register the client with the redirect URI
  above, and set `BING_OAUTH_CLIENT_ID` and `BING_OAUTH_CLIENT_SECRET`. Without them the Bing Connect button shows
  "not configured".
- Meta: a Meta app with Business Verification and App Review for `ads_management` and the other requested permissions.

### Docker / Dokploy

The `Dockerfile` builds a production image: runtime dependencies only, a non-root user, `tini` as PID 1, and a health
check on `/healthz`. On every start, `scripts/docker-start.sh` applies pending migrations (`drizzle-kit migrate`;
already applied ones are skipped) and then starts the server. It refuses to start without `DATABASE_URL`.

1. **Database:** in the Dokploy project, create a **Postgres** service. Copy its **internal** connection URL
   (`postgres://user:pass@<service-host>:5432/<db>`).
2. **Application:** create an **Application** from this Git repository (branch `main`), with **Build Type: Dockerfile**
   and Dockerfile path `Dockerfile`.
3. **Environment:** set at least
   ```
   DATABASE_URL=postgres://...            # internal URL from step 1
   ADS_MCP_KEYS=1:<openssl rand -base64 32>
   PUBLIC_URL=https://ads.example.com     # the domain from step 4, no trailing slash
   ```
   Add the `GOOGLE_*`, `META_*`, `BING_*` and `YOUTUBE_API_KEY` values from `.env.example` as needed. The image already sets
   `NODE_ENV=production`, `PORT=8787`, `TRUST_PROXY=1` (Dokploy's Traefik is the trusted proxy) and `RATE_LIMIT_STORE=db`.
   Set `RUN_MIGRATIONS=false` to skip the automatic migrations.
4. **Domain:** add the domain with **container port 8787** and HTTPS (Let's Encrypt) enabled. Register the OAuth
   redirect URIs above using this domain.
5. **Deploy**, then create the first workspace from the application's **Terminal** in Dokploy:
   ```bash
   ADS_MCP_OWNER_PASSWORD='a-long-password' node --import tsx scripts/create-tenant.ts "My Agency" owner@example.com
   ```
   Sign in at `$PUBLIC_URL/login`. MCP clients connect to `$PUBLIC_URL/mcp`.

Back up the Postgres service (Dokploy → Backups): it holds the encrypted platform credentials and approvals. Keep
`ADS_MCP_KEYS` safe as well: without it, the stored credentials cannot be decrypted.

## Known gaps and limitations

- No live verification of any tool, OAuth flow or API mapping (see Status). This needs a Test- and a Basic-level Google
  Ads account and a Meta test ad account.
- Lists are read up to a fixed size per call (for example 5,000 rows). Past that, a tool either says `truncated`
  (when it shows a page) or refuses with `unsupported` (when it needs the whole list, as duplicate checks and totals
  do). It never works from a silently cut list.
- Each write makes several API calls (plan, re-check at approval time, execute, read back). That is the price of the
  approval and conflict checks and is intended.
- A few Meta fields could not be confirmed in Meta's docs and are deliberately not used (see `docs/VERIFICATION.md`).
- Meta `debug_token` is called with POST (token kept out of the URL); confirm on the first live run.
- Search Console, GA4 and Tag Manager have not run against live properties either. Each product's section in
  `docs/VERIFICATION.md` lists what is inferred rather than documented (for example GA4 tag type codes in Tag Manager,
  how GA4 stores Google Ads customer ids, and Meta's dynamic URL parameters, which the combined tools never resolve).
- Google must verify the OAuth app for the Search Console, Analytics and Tag Manager scopes before outside customers can
  connect them. Tag Manager allows 25 requests per 100 seconds per Cloud project, shared by every tenant; the server
  enforces that limit (`GTM_RATE_BURST`, `GTM_RATE_PER_SEC`), and a higher quota should be requested before launch.
- Some Google Ads features are restricted by Google, not by this server. The tools are built per the v26 docs and pass
  Google's own error through:
  - Offline click conversion uploads and Customer Match member uploads are not offered: Google refuses them from API
    projects without earlier use (`CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE`, since 2026-06-15 and 2026-04-01) and
    points new integrations to its Data Manager API. `upload_click_conversions` and `upload_customer_match_members` were
    removed on 2026-11-11; `create_customer_match_list` stays, and members are added in Google Ads or through Data Manager.
  - `get_auction_insights`: the `auction_insight_search_*` metrics are marked "not publicly available".
  - Conversion value rules that set a fixed value, and itinerary conditions, are allowlist-only and not offered.
- `request_policy_exemption` covers ads only: in v26 an existing keyword exposes no exemptible policy violation keys.
- Bing Webmaster tools have not run against a live site. Two things to confirm on the first live read: that
  `www.bing.com/webmaster/api.svc/json` accepts the OAuth Bearer token (Microsoft's OAuth page shows it; its protocol
  page shows only `ssl.bing.com` with an API key), and the readings recorded in `docs/VERIFICATION.md` where Microsoft's
  pages are silent or contradict themselves (for example quoting of text parameters, date parameters of the keyword
  methods, what the submission quota numbers mean, and the site-move rules taken from Bing's help).
- Bing's query and page reports have no date range: they cover Bing's own window in weekly buckets. Bing figures say
  which buckets they use and are never presented as covering an exact period; the combined tools show Bing beside
  Google and never add the two together. Bing keyword volumes are Bing-wide demand, not the site's traffic.
- Bing's AI Performance (Copilot citation) report is not in Bing's API, so it is not available.
- Web UI is deliberately minimal (login, consent, approvals, connections). No self-serve signup: tenants are created with `tenant:create`.
