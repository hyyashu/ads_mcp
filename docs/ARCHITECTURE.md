# ads-mcp architecture

Status: proposal grounded in the code at commit `29cf7e6` (2026-11-04). The code is the source of truth; where this
document and the code disagree, the code wins until a milestone changes it.

Verification labels used below:
- **[verified 2026-11-02]**: confirmed on an official page, recorded in `docs/VERIFICATION.md` by the session that could reach
  the docs. Not re-checked since (the docs hosts are blocked in the current build environment).
- **[unverified]**: from knowledge or inference; must be checked against official docs before code depends on it.

---

## 1. Assessment of the repository

**Complete and worth keeping (do not rebuild)**

| Area | What exists | Files |
|---|---|---|
| Tenancy and humans | tenants, users with roles, scrypt passwords, web sessions, per-purpose CSRF, owner bootstrap script | `src/db/schema.ts`, `src/auth/passwords.ts`, `src/auth/web-session.ts`, `scripts/create-tenant.ts` |
| MCP client identity | OAuth authorization server: protected resource metadata, server metadata, PKCE S256 only, `resource` binding and audience check, CIMD, DCR, `iss` on redirects, rotating refresh tokens with reuse detection, revocation; personal API tokens | `src/auth/oauth-server.ts`, `src/auth/api-token.ts` |
| Platform identity | Google OAuth (PKCE, offline), Meta OAuth (long-lived token, `appsecret_proof`), account discovery, disconnect with revoke, `needs_reauth` | `src/auth/platform-oauth.ts`, `src/auth/token-providers.ts` |
| Credentials | AES-256-GCM, AAD bound to tenant and row, versioned keyring, redaction of token patterns | `src/security/crypto.ts`, `src/mcp/errors.ts` |
| Pipeline | one `runTool` path: scope, tenant rate limit, validation, tenant-scoped account resolution, account rate limit, handler, output validation, structured envelope | `src/mcp/pipeline.ts` |
| Mutations | prepare (plan, read-only) to approve (human, browser, CSRF) to execute; idempotency key over tenant+account+tool+args; row lock; drift re-plan; definite vs unknown outcome; `verify()` reconciliation with backoff; second approver for high-impact/destructive | `src/security/approvals.ts`, `src/web/routes.ts` |
| Registry | rejects tools not in the inventory, with wrong read/write kind, unbounded arrays, undocumented permissions, write tools without `verify()` | `src/mcp/registry.ts` |
| Google | GAQL builder (injection-safe), REST transport with error mapping and no mutation retries, client with pagination and atomic batch mutate, 39 tools | `src/platforms/google/**` |
| Limits | Postgres token buckets shared across instances | `src/security/rate-limit-db.ts` |

**Incomplete**

1. Meta adapter: only OAuth exists. 0 of 60 tools.
2. 128 Google tools pending (`docs/TRACKING.md`).
3. No correlation id, no structured logs (8 raw `console.*` calls), no per-call execution record.
4. No per-tool deadline. The MCP request's abort signal reaches the tool context but **not** the Google HTTP client, so a cancelled call keeps running upstream.
5. Retry backoff has no jitter.
6. **Reporting units**: money is returned "in the account's currency" but the currency code and time zone are neither stored nor returned.
7. Change summaries are free text. Risk is a static per-tool tier, so a budget decrease and a budget increase get the same policy.
8. No tenant automation policy, no plan entitlements.
9. MCP: the spec site serves revision 2026-07-28 **[verified 2026-11-02]**; the installed SDK (1.32.2) supports up to 2025-11-25 **[verified 2026-11-02]**. Clients fall back to the older handshake, so this works, but the new revision is not implemented.
10. ~~No background job table. Reconciliation runs on a `setInterval` in each process.~~ Fixed in M6.

**Unsafe or risky (remaining after the 2026-11-04 review fixes)**

1. Keyring comes from an environment variable. Acceptable for MVP, but a KMS-wrapped data key is the production target.
2. Tenant isolation is enforced in application code only (every query filters by tenant). No Postgres row-level security as a second line.
3. Dynamic Client Registration is deprecated in the current spec **[verified 2026-11-02]** and widens attack surface (open registration). Keep it rate-limited for clients that still need it; plan to make it optional.
4. Reconnecting a Meta account with a read-only grant keeps a previously granted `write` access level on the account row; writes would then be approved and fail at Meta.
5. Meta `debug_token` is called with POST so the token stays out of URLs **[unverified that POST is accepted]**.

**Duplicated or misfiled**

1. Inventory overlap: 24 Google tool names collapse to the same operation once the campaign-type word is removed (`add_search_ad_group` / `add_display_ad_group` / `add_demandgen_ad_group` / `add_shopping_ad_group`; `get_display_audiences` / `get_ad_group_audiences` / `get_demandgen_audiences`; and so on). Three responsive-search-ad edit tools overlap (`update_ad_headlines`, `update_ad_descriptions`, `update_ad_content`). Keep the names (they are the external contract) but implement them on shared operations, as `src/platforms/google/tools/status.ts` already does.
2. Platform-agnostic tools filed under `google_ads`: `get_usage_status`, `help_user_upload`.
3. Capabilities the platforms cannot honestly fulfil as named: industry benchmarks (`get_benchmark_context`), generative ad copy (`suggest_ad_content`), Meta audience insights (`get_meta_audience_insights`). These have owner decisions recorded in `inventory/mapping.ts`.
4. `usage_counter` (aggregate) will overlap with execution records (detail). Keep both: counters are the cheap source for entitlements; execution records are short-retention observability.

---

## 2. Architecture

```
 AI client (Claude, ChatGPT, Cursor)                 Human in a browser
   | OAuth 2.1 bearer (audience = /mcp)                | session cookie + CSRF
   v                                                   v
 +------------------------------------------------------------------------------+
 | HTTP edge (src/mcp/http.ts)  request id, origin check, body limit             |
 |   /mcp  --> MCP server (stateless, per request)    /authorize /token /login     |
 |              |                                     /approvals /connections      |
 |              v                                          | (src/web, src/auth)    |
 |   Pipeline (src/mcp/pipeline.ts)                         |                       |
 |   scope -> limits -> validate -> resolve account -> deadline -> plan/handler     |
 |        -> approval request | read result -> normalize -> execution record        |
 |              |                                          |                       |
 |   Policy + approvals (src/security, later src/policy) <-+  decide -> execute     |
 |              |                                                                   |
 |   Platform adapters (src/platforms/<platform>)  capabilities, client, errors     |
 |     google (GAQL, mutate)    meta (Graph, insights)   later: linkedin, tiktok    |
 +--------------|-------------------------------------------------------------------+
                v                                      Postgres (single database)
       Google Ads REST, Meta Graph API          tenants, users, grants, connections,
                                                accounts, approvals, executions,
                                                audit, usage, rate buckets, jobs
```

Modular monolith, one deployable, one Postgres. No queue, no cache server: Postgres already holds rate limits and is the
right place for a small job table. Add infrastructure only when a measured need appears.

### Module boundaries and folders

Existing folders stay. New code goes where its responsibility lives.

```
src/
  mcp/          transport, MCP server factory, pipeline, registry, envelope, errors     (existing)
  auth/         MCP OAuth server, API tokens, sessions, platform OAuth, token providers (existing)
  security/     crypto, approvals, rate limits, audit                                   (existing)
  obs/          structured logger with redaction, execution records                     (NEW, milestone 1)
  policy/       mutation policy: change sets, risk evaluation, tenant automation rules  (NEW, milestone 3)
  jobs/         Postgres-backed jobs: async reports, reconciliation                     (NEW, milestone 6)
  platforms/
    core/       adapter contract, capability registry                                   (NEW, milestone 5)
    google/     http, gaql, client, services, tools/*                                   (existing)
    meta/       http, client, services, tools/*                                         (NEW, milestone 5)
  web/          html, routes                                                            (existing)
  db/           schema, migrations                                                      (existing)
```

Rules:
1. `mcp/` never imports a platform module directly; it sees tools through the registry.
2. A platform module never imports another platform module.
3. Tool handlers never see tokens or the database. They receive platform clients from `createServices` (tenant-level tools get a database handle and must scope by `ctx.tenantId`).
4. Only `security/approvals.ts` changes approval state. Only `obs/` writes execution records.

---

## 3. Contracts

### Tool contract (current, `src/mcp/tool.ts`, with milestone-1 additions marked)

```ts
interface ToolBase<I, O, S> {
  name: string;               // exact inventory name: the external contract
  platform: Platform;
  title: string; description: string;
  input: z.ZodObject;         // bounded arrays enforced by the registry
  output: z.ZodType;          // wrapped in the common envelope
  permissions: { scope: "ads:read" | "ads:write"; platformPermissions: string[]; notes?: string };
  accountScope?: "required" | "none";
  timeoutMs?: number;         // NEW (M1): deadline for one call; default 30s read/plan, 60s execute
}
// operation (read | analyze | create | update | delete) is DERIVED from the inventory's action_type by the registry
// (NEW in M1, operationOf(tool)), so it cannot drift from the inventory and needs no edit in each tool.

interface ReadTool  extends ToolBase { kind: "read";  handler(args, ctx): Promise<O> }
interface WriteTool extends ToolBase {
  kind: "write";
  risk: "write" | "high_impact" | "destructive";   // approval policy today: see section 6
  plan(args, ctx):    Promise<{ summary: string; snapshot?: unknown }>;  // read-only; M3 adds a structured change set
  execute(args, ctx, run: { idempotencyKey: string; snapshot: unknown }): Promise<O>;
  verify(args, ctx, run: { snapshot: unknown }): Promise<{ outcome: "applied" | "not_applied" | "indeterminate" }>;
}
```

Idempotency strategy today is the same for every write tool and is enforced outside the tool: the approval key
(`sha256(tenant|account|tool|canonical args)`), state-based drift checks, and `verify()` after ambiguous failures.
Neither Google Ads nor Meta documents a request-id idempotency mechanism that this code uses **[unverified that none exists:
check before Meta writes]**. If one is confirmed, a tool declares `idempotency: "native"` and passes the key through.

### Platform adapter contract (milestone 5, extracted from what Google already does)

```ts
interface PlatformAdapter<S> {
  platform: Platform;                          // "google_ads" | "meta_ads" | later "linkedin_ads" | "tiktok_ads"
  apiVersion: string;                          // explicit, from config, no default
  oauth: { start(actor, access): Promise<string>; finish(actor, query): Promise<FinishResult>; revoke(conn): Promise<boolean> };
  discoverAccounts(credentials): Promise<AccountInfo[]>;   // includes currency and time zone (M2)
  createServices(account, signal): Promise<S>;  // per-call clients; handlers get only this
  mapError(status, body, mutation: boolean): ToolError;   // rate limits, auth, permission, ambiguous outcomes
  tools: AnyTool[];                             // registered through the same registry rules
}
```

Adding LinkedIn or TikTok = one folder under `platforms/`, one adapter object, its tools, and inventory rows. The
pipeline, approvals, OAuth server, limits and audit do not change. Platform concepts stay native: Google campaigns, ad
groups, keywords and micros; Meta campaigns, ad sets, creatives and its own budget units. No universal ad schema.

---

## 4. Tool catalog for AI clients

Facts: MCP supports paginated `tools/list` and a `tools/list_changed` notification **[unverified how each client
handles either]**. Model quality drops when hundreds of tools are visible at once (well known; exact client limits
**[unverified]**). 227 tools cannot all be shown.

Recommendation, in order:
1. **Filter `tools/list` per caller** (server side, works with every client): show a platform's tools only if the tenant
   has an active connection for it; hide write tools when the token lacks `ads:write`. Zero client support needed.
2. **Tenant-selected bundles**: owners choose bundles in the web UI (Reporting, Search campaigns, PMax, Meta campaigns,
   Catalog). Stored per tenant, applied in step 1. Again zero client support needed.
3. **Not recommended now**: one MCP URL per bundle. Each URL is a separate OAuth resource (audience, metadata) and a
   separate connector in the client: more setup for users and more auth surface for us.
4. Keep inventory names; collapse overlapping names onto shared implementations.

---

## 5. Data model

Existing tables are kept: `tenant`, `app_user`, `web_session`, `api_token`, `oauth_client`, `oauth_auth_code`,
`oauth_access_token`, `oauth_refresh_token`, `platform_connection`, `platform_oauth_state`, `connected_account`,
`approval_request`, `audit_log`, `usage_counter`, `rate_limit_bucket`. Memberships are a role on `app_user` (one tenant
per user); move to a membership table only when multi-workspace users are a real requirement.

Minimum additions, by milestone:

| Milestone | Change | Why |
|---|---|---|
| M1 | `tool_execution` (tenant, user, tool, platform, account, request id, operation, outcome, error code, duration, time). No arguments, no results. Index (tenant, created_at). Retention 30 days. | Latency/error metrics and support lookups by request id, without storing ad data |
| M2 | `connected_account.currency_code`, `time_zone` | Every money and date value must say which currency and day boundary it uses |
| M3 | `approval_request.change_set jsonb` (structured before/after); `tenant_policy` (tenant, rule, limits) | Concrete approvals; explicit, bounded automation |
| M6 | `job` (tenant, kind, status, run_after, attempts, payload ids only, lease) | Async reports and reconciliation off the request path |
| Later | `plan`, `tenant_entitlement` | Billing tiers; until then limits are config |

Isolation: every tenant table has `tenant_id` with a foreign key and cascade delete; every query filters on it (today in
code; row-level security later). Unique keys: `connected_account (tenant, platform, external_id)`,
`approval_request.idempotency_key`, token hashes. Credential deletion: disconnect overwrites `credentials_enc` with
`revoked` and deletes the connected accounts (pending approvals cascade). No upstream responses are stored.

---

## 6. Mutation safety

Policy today: every modifying tool needs a human approval in the browser; `high_impact` and `destructive` need a second
person. Approvals are bound to tenant, account, tool, canonical arguments (hash and stored arguments: execution uses the
stored ones, never new input), requester and expiry (24 h). Consumed, expired, superseded or foreign approvals are
refused. Execution re-plans against live state and refuses on drift.

Planned refinements (M3):
1. **Direction-aware risk**: `plan()` returns a change set; policy derives risk from it. A budget increase or
   enabling spend is high impact; a decrease or pause is ordinary write; removal is destructive; bulk over N items needs a
   second approver.
2. **Structured change set** stored with the approval: account and currency, each resource, existing value, proposed
   value, units (micros converted for display, raw kept), operation count, risks.
3. **Tenant automation policy**: explicit rules such as "pausing is allowed without approval" or "budget changes up to
   +10% and 50/day without approval". Off by default. Chat text is never treated as approval.

---

## 7. End-to-end flows

**Read campaign performance**: bearer token validated (audience `/mcp`) -> tenant and user from the token row -> scope
`ads:read` -> tenant limit -> arguments validated -> `account_id` resolved within the tenant (foreign ids are
`not_found`) -> account limit -> deadline starts -> Google client built with the caller's abort signal -> GAQL query ->
rows validated against the output schema -> envelope with request id (M1), currency and time zone (M2) -> execution
record and usage counter.

**Prepare and approve a budget increase**: same front half with `ads:write` and a write-capable account -> `plan()` reads
the campaign and budget, refuses shared budgets, produces the summary and snapshot -> approval row (pending, 24 h) ->
the client is told nothing changed -> an owner or admin (the requester included) signs in, sees the change, approves (CSRF, origin check).

**Execute an approved change**: approval claimed atomically (pending to executing) -> account resolved again (access
may have been revoked) -> `plan()` re-run, snapshot must match -> one atomic Google mutate -> read back and compare ->
`executed` with result, audit event.

**Recover from an uncertain result**: timeout or 5xx after the send -> `unknown_outcome` (never retried) -> the
reconciler calls `verify()` with backoff -> `applied` records success; `not_applied` frees the request for a new human
approval; `indeterminate` stays visible for manual review after 20 checks. A crash mid-execution is caught by the
stuck-row sweep and enters the same path.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Cross-tenant data or credential use | tenant filter on every query, tenant-keyed token cache, AAD-bound ciphertext; RLS later |
| Duplicate mutation | idempotency key, row lock, unique constraint, no mutation retries, verify-before-retry |
| Spend from a stale plan | re-plan before execute, drift refusal, expiry |
| Token leakage | redaction in errors and (M1) logs; tokens never reach handlers or responses |
| Upstream quota exhaustion shared across tenants | tenant and account limits now; per-platform/app limits from the adapter's quota errors (M4) |
| API version sunsets | explicit version config, release-notes check each quarter (Google sunsets are scheduled **[verified 2026-11-02]**) |
| Unverified field names | every tool marked `mocked-api only` until a live test account run |
| MCP revision drift | track SDK support for 2026-07-28; the current transport keeps working through client fallback |

---

## 9. Implementation plan

Each milestone is one reviewable branch with tests.

1. **M1 Execution envelope**: request ids, structured redacting logger, per-tool deadlines, cancellation reaching the upstream client, jittered backoff, execution records. *(in progress)*
2. **M2 Reporting units** (done): store and return currency and time zone; distinguish zero, missing and unavailable in outputs.
   - `connected_account.currency_code` / `time_zone` (migration 0005), filled at connect time from Google
     `customer[_client].currency_code` / `time_zone` and Meta `currency` / `timezone_name`; refreshed on reconnect
     without erasing a value the platform omitted.
   - No backfill: no accounts existed before this milestone. Units the platform did not report stay null.
   - Every account-scoped response carries `meta.account = {id, currency_code, time_zone}`; tenant-level tools carry none.
   - Output convention, documented in `platforms/google/gaql.ts`: absent counter metric = 0 (proto3 omits defaults;
     inferred, not verified per metric), absent attribute = null, ratio with zero denominator = null.
3. **M3 Change sets and policy**: structured change set, direction-aware risk, tenant automation rules (off by default).
   - M3a (done): `plan()` may return `changes` (`policy/change-set.ts`: resource, id, field, before, after, unit,
     effect). `policy/risk.ts` derives the approval's risk: remove = destructive; increase_spend, enable, create =
     high_impact; decrease_spend, pause, neutral = write; more than 20 resources = at least high_impact. It can lower a
     declared high_impact to write but never lowers a destructive tool. The change set (with account currency, time zone
     and the risk reason) is stored in `approval_request.change_set` (migration 0006), returned in the approval
     envelope and shown as a before/after table on the approvals page. At execution, a fresh plan that assesses
     riskier than the approved level is refused. Adopted by pause/resume campaign and ad group, pause/resume/remove
     ad, bulk ad status, update_campaign, update_ad_group_settings, update_keyword, bulk keyword status. Other write
     tools keep their declared risk until they report changes.
   - M3b (done): workspace automation rules (`policy/automation.ts`, table `tenant_policy`, migration 0007). Off by
     default. Rules: `pause` (pauses only) and `budget` (daily budget increases within both a percent and an amount
     limit, inclusive; decreases only with `allow_decrease`), plus `max_auto_per_day` (UTC day). Every change in the
     stored change set must be covered; destructive, bulk (>20 resources), enabling, bids, renames, tools without a
     change set, an unknown current budget or an unknown currency are never automated. The rule is applied to the
     stored change set right after queueing; the daily cap is checked and the request claimed under a per-tenant
     advisory lock, so concurrent calls cannot exceed it. The executor still re-plans and refuses on drift.
     `approval_request.approved_by_rule` records the rule (decided_by null); audit `approval.auto_approved`. The
     response is the confirmed result with `meta.auto_approval`; a failure after sending is returned as
     `unknown_outcome`, never success. Only an owner edits rules, in the browser (session + CSRF + same origin); no
     MCP tool or bearer token can. A stored value that no longer validates fails closed (nothing automatic).
4. **M4 Catalog exposure**: per-caller `tools/list` filtering by connection and scope; tenant bundles.
   - Done (`mcp/catalog.ts`): each MCP request registers only the tools the caller can use. Hidden: tools whose scope the
     token lacks; tools of a platform with no active connection in the workspace; write tools when no account on that
     platform is connected with write access. Workspace-level tools are always listed. Server instructions say what is
     connected and how to connect more. One query per MCP request. No `tools/list_changed` (stateless server): a client
     sees new connections when it lists tools again. Hiding is for relevance; the pipeline still enforces every check.
   - Deferred: tenant-selected bundles. The inventory has no categories, so bundles need a curated name-to-bundle map;
     revisit once the Meta tools exist (M5), when the catalog is large enough to need it.
5. **M5 Adapter contract and Meta core**: extract the adapter interface from Google; Meta transport, error mapping, first read tools, each endpoint checked against the official reference first.
   - Done: `platforms/meta/http.ts` (Graph v26.0 transport: token only in the Authorization header, `appsecret_proof`
     as a parameter, documented error and throttle mapping, retry-after from usage headers, reads retried with jitter,
     writes sent once), `platforms/meta/client.ts` (one ad account; cursor pagination that never follows the raw
     `paging.next` URL; `getOwned` refuses objects of other ad accounts the same token can reach; minor-unit currency
     conversion from the documented offset table; `mutationsSent`). The services factory is the adapter seam: one
     branch per platform builds that platform's client from the resolved account. First Meta tools:
     `list_meta_campaigns`, `pause_meta_campaign` (write), `resume_meta_campaign` (high impact), with change sets.
   - Not done: a formal `PlatformAdapter` interface. With two platforms the factory branch is the whole contract;
     extract an interface when a third platform arrives rather than guess at it now.
6. **M6 Jobs**: Postgres job table for async reports and reconciliation; remove per-process intervals.
   - Done: `job` table (migration 0008) and `jobs/queue.ts`. Claims use `FOR UPDATE SKIP LOCKED`, so any number of
     instances run workers without coordination; a lease (default 5 min) is reclaimed when it expires, the handler's
     signal aborts 5 s before expiry, and only the current lease holder can finish a job. Retryable failures back off
     with full jitter up to `max_attempts`. A partial unique index on `dedupe_key` (queued or running) keeps exactly one
     instance of each recurring job across all servers. Jobs must be safe to run twice; mutations never run as jobs.
   - The two `setInterval`s are gone: `system.reconcile` (every 60 s: stuck recovery, then unknown-outcome
     reconciliation, which still never re-sends a mutation), `system.prune_executions` (daily, 30 days) and
     `system.prune_jobs` (daily, 7 days). `JOBS_ENABLED=false` turns the worker off on request-only instances.
   - Not built: async report jobs. No inventory tool can start or poll one, and storing report results would be the
     first stored copy of platform data; add it with a tool that needs it, with a short result TTL.
7. **M7 Remaining Google batches**, then Meta writes.
   - Google done: 166 of 167 tools implemented; `create_youtube_campaign` is a documented external limitation (Google: "Video
     campaigns cannot be created or mutated using the Google Ads API"; Demand Gen is the route for YouTube video ads).
   - Verification: Google's v26 REST discovery document and field reference pages are recorded in
     `inventory/google-ads-v26-schema.json` and `-gaql.json`; the Google test harness checks every request (fields, FROM
     compatibility, metrics and segments, selectable/filterable, enum literals, mutate bodies) and every fake response row
     against them. This caught real mistakes (asset field types, Demand Gen channel controls) before any live call.
   - New shared pieces: `write-kit.ts` (read live state, build one atomic GoogleAdsService.Mutate or one service RPC,
     confirm by re-reading, verify for reconciliation), `media.ts` (SSRF-safe image download, header parsing, Google's
     published image specs, SHA-256 pinned in the approved snapshot), `youtube.ts` (YouTube Data API, key in a header).
   - Not live-tested: no Google tool has run against a real account yet (M8).
   - Meta: 3 of 60 implemented; the remaining 57 are next.
8. **M8 Live verification** on test accounts (Google Test/Basic, Meta test ad account).
9. **M9 Hardening**: KMS-wrapped keys, row-level security, DCR optional.

**MVP** = M1 to M5 plus the Google reads and safe writes already built, verified on test accounts (M8).
**Later** = automation policies beyond defaults, bundles UI, jobs for async reporting, LinkedIn/TikTok, RLS, KMS, billing.
