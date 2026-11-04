import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiTokenAuthenticator } from "./auth/api-token";
import { CompositeAuthenticator, OAuthServer } from "./auth/oauth-server";
import { PlatformOAuth } from "./auth/platform-oauth";
import { GoogleTokenProvider } from "./auth/token-providers";
import { GoogleAdsHttp } from "./platforms/google/http";
import { createServicesFactory } from "./platforms/google/services";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { loadInventory, validateInventory } from "./inventory";
import { createHttpServer } from "./mcp/http";
import { type PipelineDeps, createVerifier } from "./mcp/pipeline";
import { type Limitation, ToolRegistry, reconcile } from "./mcp/registry";
import { allTools } from "./platforms";
import { ApprovalService } from "./security/approvals";
import { CredentialCipher, keyringFromEnv } from "./security/crypto";
import { RateLimiter, type Limiter } from "./security/rate-limit";
import { DbRateLimiter } from "./security/rate-limit-db";
import { WebRoutes } from "./web/routes";
import { logger } from "./obs/logger";
import { pruneExecutions } from "./obs/executions";

function main() {
  const config = loadConfig();
  const cipher = new CredentialCipher(keyringFromEnv()); // fail fast on missing/malformed keys

  const inventory = loadInventory();
  const invProblems = validateInventory(inventory);
  if (invProblems.length) throw new Error(`Tool inventory is invalid:\n  ${invProblems.join("\n  ")}`);

  const registry = new ToolRegistry(inventory).registerAll(allTools());
  const limitations = JSON.parse(readFileSync(fileURLToPath(new URL("../inventory/limitations.json", import.meta.url)), "utf8")) as Record<string, Limitation>;
  const rec = reconcile(inventory, registry, limitations);
  if (rec.errors.length) throw new Error(`Registry reconciliation failed:\n  ${rec.errors.join("\n  ")}`);
  logger.info("startup.tools", { implemented: rec.counts.implemented, limitations: rec.counts.external_limitation, pending: rec.counts.pending });

  const db = createDb({ pgliteDir: process.env.PGLITE_DIR ?? ".data/pglite" });
  if (config.rateLimitStore === "memory" && process.env.NODE_ENV === "production") logger.warn("startup.memory_rate_limits", { message: "in-memory rate limiting is per instance: use RATE_LIMIT_STORE=db with more than one instance" });
  const limiter = (ns: string, burst: number, perSec: number): Limiter =>
    config.rateLimitStore === "db" ? new DbRateLimiter(db, { namespace: ns, capacity: burst, refillPerSecond: perSec }) : new RateLimiter(burst, perSec);
  const num = (k: string, d: number) => Number(process.env[k] ?? d);

  const approvals = new ApprovalService(db);
  const oauth = new OAuthServer({ db, config: { issuer: config.issuer, resource: config.resource } });
  const googleTokens = config.google ? new GoogleTokenProvider({ db, cipher, clientId: config.google.clientId, clientSecret: config.google.clientSecret }) : undefined;
  const platform = new PlatformOAuth(db, cipher, { publicUrl: config.issuer, google: config.google, meta: config.meta }, { onRevoked: (id) => googleTokens?.forget(id) });

  const deps: PipelineDeps = {
    db,
    registry,
    approvals,
    tenantLimiter: limiter("tenant", num("TENANT_RATE_BURST", 60), num("TENANT_RATE_PER_SEC", 5)),
    accountLimiter: limiter("account", num("ACCOUNT_RATE_BURST", 20), num("ACCOUNT_RATE_PER_SEC", 2)),
    // Builds a per-account platform client; handlers never see credentials. Meta joins in the Meta phase.
    createServices: createServicesFactory({
      db,
      google: config.google
        ? { tokens: googleTokens!, http: new GoogleAdsHttp({ apiVersion: config.google.apiVersion }) }
        : undefined,
    }),
  };
  const web = new WebRoutes({
    db,
    config,
    oauth,
    platform,
    approvals,
    pipeline: deps,
    limiters: { login: limiter("login", 5, 0.05), loginAccount: limiter("login-account", 20, 20 / 3600), register: limiter("register", 20, 0.01), token: limiter("token", 60, 1) },
  });

  const server = createHttpServer(deps, new CompositeAuthenticator(oauth, new ApiTokenAuthenticator(db)), { config }, web);
  server.listen(config.port, () => logger.info("startup.listening", { resource: config.resource, issuer: config.issuer }));
  // Execution records are short-lived observability data: keep 30 days.
  setInterval(() => void pruneExecutions(db, 30).catch((e) => logger.warn("prune.failed", { error: e })), 24 * 3600_000).unref();
  // Crash recovery: stuck mutations become "unknown", then are reconciled against live platform state. Never retried.
  const verifier = createVerifier(deps);
  setInterval(() => void approvals.recoverStuck().then(() => approvals.reconcileUnknown(verifier)).catch(() => {}), 60_000).unref();
}

main();
