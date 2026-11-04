import { sql } from "drizzle-orm";
import { check, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * What we store, and nothing more: tenants and users, connection credentials (encrypted), account
 * associations and permissions, approval requests, usage counters and a minimal audit trail.
 * Advertising data (campaigns, metrics, creatives, search terms, lead data) is NEVER stored: it is
 * fetched from the platform APIs on demand.
 */
const id = () =>
  text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`);
const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenant = pgTable("tenant", {
  id: id(),
  name: text("name").notNull(),
  createdAt: created(),
});

export const appUser = pgTable(
  "app_user",
  {
    id: id(),
    tenantId: text("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"), // owner | admin | member
    /** scrypt hash for human web login (approvals, connecting accounts, OAuth consent). Null = cannot log in. */
    passwordHash: text("password_hash"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("app_user_email_uq").on(t.email), index("app_user_tenant_idx").on(t.tenantId), check("app_user_email_lowercase", sql`${t.email} = lower(${t.email})`)],
);

/** Bearer tokens for MCP clients. Only a SHA-256 hash is stored; the token is shown once at issue time. */
export const apiToken = pgTable(
  "api_token",
  {
    id: id(),
    tenantId: text("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => appUser.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    label: text("label").notNull(),
    /** e.g. ["ads:read", "ads:write"] */
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex("api_token_hash_uq").on(t.tokenHash), index("api_token_tenant_idx").on(t.tenantId)],
);

/** An OAuth grant to one platform. Credentials are AES-256-GCM encrypted, bound to this row via AAD. */
export const platformConnection = pgTable(
  "platform_connection",
  {
    id: id(),
    tenantId: text("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => appUser.id, { onDelete: "set null" }),
    platform: text("platform").notNull(), // google_ads | meta_ads
    credentialsEnc: text("credentials_enc").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    grantedScopes: text("granted_scopes").array().notNull().default(sql`'{}'::text[]`),
    /** The platform user behind the grant (Google email / Meta user id), for display and revocation. */
    externalUserId: text("external_user_id"),
    /** Meta long-lived tokens expire (no refresh token). Google refresh tokens have no fixed expiry. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    status: text("status").notNull().default("active"), // active | needs_reauth | revoked
    createdAt: created(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("conn_tenant_idx").on(t.tenantId)],
);

/** An ad account a tenant may act on, and how far (read-only vs read+write). */
export const connectedAccount = pgTable(
  "connected_account",
  {
    id: id(),
    tenantId: text("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull().references(() => platformConnection.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    externalId: text("external_id").notNull(), // Google customer id (digits) or Meta act_ id
    displayName: text("display_name").notNull().default(""),
    /** Google: the manager (MCC) account to send as login-customer-id. Per account, never global. */
    loginCustomerId: text("login_customer_id"),
    access: text("access").notNull().default("read"), // read | write
    /** ISO 4217 code the platform reports money in (Google customer.currency_code, Meta account currency). Null until known. */
    currencyCode: text("currency_code"),
    /** IANA time zone the platform uses for dates and named periods (Google customer.time_zone, Meta timezone_name). */
    timeZone: text("time_zone"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("account_uq").on(t.tenantId, t.platform, t.externalId), index("account_tenant_idx").on(t.tenantId)],
);

/** Server-verified approval gate for every tool that modifies an ad account. */
export const approvalRequest = pgTable(
  "approval_request",
  {
    id: id(),
    tenantId: text("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull().references(() => connectedAccount.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    risk: text("risk").notNull(), // write | high_impact | destructive
    args: jsonb("args").notNull(),
    argsHash: text("args_hash").notNull(),
    summary: text("summary").notNull(),
    /** Live state captured when the request was made, so we can detect drift before executing. */
    planSnapshot: jsonb("plan_snapshot"),
    /** Structured before/after of every field the change touches, with units and the reason for `risk` (M3). Null for tools without one. */
    changeSet: jsonb("change_set"),
    /** Same tenant + account + tool + arguments => same key => the mutation can only exist once. */
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"), // pending|rejected|executing|executed|failed|expired|unknown_outcome
    requestedBy: text("requested_by").references(() => appUser.id, { onDelete: "set null" }),
    decidedBy: text("decided_by").references(() => appUser.id, { onDelete: "set null" }),
    /** Set when a workspace automation rule approved this instead of a person (decided_by is then null). */
    approvedByRule: text("approved_by_rule"),
    result: jsonb("result"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: created(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    executingSince: timestamp("executing_since", { withTimezone: true }),
  },
  (t) => [uniqueIndex("approval_idem_uq").on(t.idempotencyKey), index("approval_tenant_status_idx").on(t.tenantId, t.status)],
);

/** Counters only: how many calls per tenant, tool and day. No arguments, no results. */
export const usageCounter = pgTable(
  "usage_counter",
  {
    tenantId: text("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    day: text("day").notNull(), // YYYY-MM-DD (UTC)
    tool: text("tool").notNull(),
    calls: integer("calls").notNull().default(0),
    errors: integer("errors").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.day, t.tool] })],
);

/** Privacy-conscious: event names and ids only. Never tool arguments, results, tokens or ad text. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    tenantId: text("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    event: text("event").notNull(),
    tool: text("tool"),
    accountId: text("account_id"),
    refId: text("ref_id"), // e.g. approval id
    outcome: text("outcome"),
    createdAt: created(),
  },
  (t) => [index("audit_tenant_time_idx").on(t.tenantId, t.createdAt)],
);

/** Human web sessions (cookie). Only a hash of the session token is stored. */
export const webSession = pgTable(
  "web_session",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    tenantId: text("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => appUser.id, { onDelete: "cascade" }),
    /** Per-session secret used to derive CSRF tokens. */
    csrfSecret: text("csrf_secret").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("web_session_hash_uq").on(t.tokenHash)],
);

// ------------------------------------------------------------------------------------------------
// MCP-client OAuth (this server is the OAuth resource server AND authorization server for MCP clients).
// Completely separate from the Google/Meta OAuth used to connect ad accounts.
// ------------------------------------------------------------------------------------------------

/** Registered MCP OAuth clients: dynamic registration (RFC 7591), cached Client ID Metadata Documents, or pre-registered. */
export const oauthClient = pgTable("oauth_client", {
  /** DCR: generated id. CIMD: the https URL of the metadata document. */
  clientId: text("client_id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  source: text("source").notNull(), // dcr | cimd | preregistered
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  createdAt: created(),
});

export const oauthAuthCode = pgTable("oauth_auth_code", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id").notNull(),
  tenantId: text("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => appUser.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  scopes: text("scopes").array().notNull(),
  resource: text("resource").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: created(),
});

/** Short-lived opaque access tokens, bound to one resource (audience). Hash only. */
export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    familyId: text("family_id").notNull(),
    clientId: text("client_id").notNull(),
    tenantId: text("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => appUser.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex("oauth_at_hash_uq").on(t.tokenHash), index("oauth_at_family_idx").on(t.familyId)],
);

/** Rotating refresh tokens. Reusing a used token revokes the whole family (theft detection). */
export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    familyId: text("family_id").notNull(),
    clientId: text("client_id").notNull(),
    tenantId: text("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => appUser.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex("oauth_rt_hash_uq").on(t.tokenHash), index("oauth_rt_family_idx").on(t.familyId)],
);

/** In-flight "connect Google/Meta" flows: single-use, short-lived, bound to the user who started them. */
export const platformOauthState = pgTable("platform_oauth_state", {
  stateHash: text("state_hash").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => appUser.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  /** PKCE verifier, encrypted at rest. */
  verifierEnc: text("verifier_enc").notNull(),
  /** Requested access: "read" or "write". Decides which scopes are requested and what accounts are granted. */
  access: text("access").notNull().default("read"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

/** Shared token buckets, so rate limits hold across every server instance. Updated atomically in one statement. */
export const rateLimitBucket = pgTable("rate_limit_bucket", {
  key: text("key").primaryKey(),
  tokens: doublePrecision("tokens").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-call execution metadata for latency, error rates and support lookups by request id. No arguments, no results, no
 * ad text. Retained 30 days (pruneExecutions).
 */
export const toolExecution = pgTable(
  "tool_execution",
  {
    id: id(),
    tenantId: text("tenant_id").notNull().references(() => tenant.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    tool: text("tool").notNull(),
    platform: text("platform").notNull(),
    accountId: text("account_id"),
    requestId: text("request_id"),
    operation: text("operation").notNull(), // read | analyze | create | update | delete
    outcome: text("outcome").notNull(), // ok | approval_pending | error
    errorCode: text("error_code"),
    durationMs: integer("duration_ms").notNull(),
    createdAt: created(),
  },
  (t) => [index("tool_exec_tenant_time_idx").on(t.tenantId, t.createdAt), index("tool_exec_request_idx").on(t.requestId)],
);

/** A workspace's automation rules (policy/automation.ts). No row = everything needs a person. Owners edit it in the browser only. */
export const tenantPolicy = pgTable("tenant_policy", {
  tenantId: text("tenant_id").primaryKey().references(() => tenant.id, { onDelete: "cascade" }),
  rules: jsonb("rules").notNull(),
  updatedBy: text("updated_by").references(() => appUser.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
