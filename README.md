# ads-mcp

A remote MCP server (Streamable HTTP) for Google Ads and Meta Ads: 232 tools (172 Google, 60 Meta) from
`inventory/tool-registry.json`, implemented against the official platform APIs. Advertising data is fetched on demand
and never stored.

## Status (read this first)

**231 of 232 tools are implemented** (171 Google, 60 Meta). The remaining one, `create_youtube_campaign`, is a documented
external limitation. `docs/TRACKING.md` (generated) lists every tool, its plan and its status. A tool is exposed only
when it has a real handler, input and output schemas, documented permissions and tests; there are no stub or
fake-success tools.

**"Implemented" means tested against crafted API responses, not against a real account.** Google tools are checked
against Google's published v26 schema ("schema-checked (v26), not live"); Meta tools were built from Meta's reference
docs ("docs-checked, not live"). Nothing has run against a live ad account yet (`inventory/live-verified.json` is
empty). See `docs/VERIFICATION.md` for what was checked against which page.

Tests (`npm test`) cover the MCP transport (2026-07-28 and 2025-era clients), the tool registry and its rules, the
MCP-client OAuth server, Google/Meta connection flows, human approvals, crash reconciliation, shared rate limiting,
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
| `src/auth` | **MCP-client OAuth** (`oauth-server.ts`) and, separately, **platform OAuth** (`platform-oauth.ts`: connect Google/Meta), web sessions, token providers |
| `src/platforms/google` | GAQL builder, REST transport and error mapping, Ads client, tool definitions |
| `src/security` | AES-256-GCM credentials, approval service, rate limiters (memory and Postgres), audit |
| `src/db` | Drizzle schema (Postgres). Stores tenants, users, encrypted connection credentials, account associations, approvals, usage counters, minimal audit. **No campaign, metric, creative or lead data.** |
| `inventory` | The 227-tool source of truth, the implementation plan (`mapping.ts`), documented limitations |

### Two separate OAuth systems

1. **MCP-client OAuth** (this server is the resource server and authorization server): protected resource metadata
   (`/.well-known/oauth-protected-resource`), authorization server metadata, PKCE `S256` required, `resource` binding,
   public clients, Client ID Metadata Documents (SSRF-hardened fetch) and dynamic registration, rotating refresh tokens
   with reuse detection, revocation. Tokens are audience-bound; there is no token passthrough. Clients can be granted
   `ads:read` and `ads:write` only. **Approval is never grantable to a client.**
2. **Platform OAuth** (connecting ad accounts): Google (authorization code + PKCE, offline access) and Meta (long-lived
   token, `appsecret_proof`). Credentials are encrypted at rest, bound to their row, revoked at the platform on
   disconnect, and a revoked/expired grant flips the connection to `needs_reauth`.

### Writes and approvals

A modifying tool never changes anything directly. It plans against live state (read-only) and queues an approval. A
signed-in owner or admin approves in the browser (`/approvals`, CSRF-protected). Destructive and high-impact changes
need a second person. Identical requests are deduplicated; approval re-plans and refuses if the account changed since the
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
npm test                          # 288 tests
npm run inventory:matrix          # regenerate docs/TRACKING.md
```

Sign in at `$PUBLIC_URL/login`, open **Connections** to connect Google/Meta, and point an MCP client at `$PUBLIC_URL/mcp`
(it discovers OAuth through the 401 challenge). Cursor and other header-capable clients can also use a personal token
issued with `issueApiToken` (read/write scopes only).

## Deployment

- Postgres: set `DATABASE_URL`, run `npm run db:migrate`. Do not use the embedded database in production.
- Serve behind TLS; set `PUBLIC_URL` to the https origin (required when `NODE_ENV=production`). Set `TRUST_PROXY=1` only behind a trusted proxy.
- Keys: `ADS_MCP_KEYS` supports rotation (add a new version, it encrypts new data; old versions still decrypt). Prefer unwrapping the keyring from a KMS at boot.
- Multiple instances: keep `RATE_LIMIT_STORE=db` (shared, atomic Postgres token buckets). The server is otherwise stateless.
- Register redirect URIs: Google `${PUBLIC_URL}/connect/google/callback`, Meta `${PUBLIC_URL}/connect/meta/callback`.
- Google: create a Cloud project, enable the Google Ads API, request Basic/Standard access for that project, set the OAuth consent screen (the `adwords` scope is sensitive and needs verification for external users).
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
   Add the `GOOGLE_*`, `META_*` and `YOUTUBE_API_KEY` values from `.env.example` as needed. The image already sets
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
- Web UI is deliberately minimal (login, consent, approvals, connections). No self-serve signup: tenants are created with `tenant:create`.
