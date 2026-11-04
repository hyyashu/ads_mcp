import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  PUBLIC_URL: z.string().url().optional(),
  NODE_ENV: z.string().optional(),
  TRUST_PROXY: z.enum(["0", "1"]).default("0"),
  ALLOWED_ORIGINS: z.string().default(""),
  RATE_LIMIT_STORE: z.enum(["db", "memory"]).default("db"),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_API_VERSION: z.string().regex(/^v\d+$/).optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_API_VERSION: z.string().regex(/^v\d+\.\d+$/).optional(),
  YOUTUBE_API_KEY: z.string().optional(),
});

export interface AppConfig {
  port: number;
  /** Canonical origin. Also the OAuth issuer. */
  issuer: string;
  /** Canonical MCP resource identifier. Access tokens are bound to it. */
  resource: string;
  secureCookies: boolean;
  trustProxy: boolean;
  allowedOrigins: string[];
  rateLimitStore: "db" | "memory";
  google?: { clientId: string; clientSecret: string; apiVersion: string };
  meta?: { appId: string; appSecret: string; apiVersion: string };
  youtubeApiKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = Env.parse(env);
  const production = e.NODE_ENV === "production";
  const publicUrl = (e.PUBLIC_URL ?? `http://localhost:${e.PORT}`).replace(/\/$/, "");
  if (production && !publicUrl.startsWith("https://")) throw new Error("PUBLIC_URL must be https in production");
  const cfg: AppConfig = {
    port: e.PORT,
    issuer: publicUrl,
    resource: `${publicUrl}/mcp`,
    secureCookies: publicUrl.startsWith("https://"),
    trustProxy: e.TRUST_PROXY === "1",
    allowedOrigins: e.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    rateLimitStore: e.RATE_LIMIT_STORE,
    youtubeApiKey: e.YOUTUBE_API_KEY,
  };
  if (e.GOOGLE_OAUTH_CLIENT_ID && e.GOOGLE_OAUTH_CLIENT_SECRET) {
    // No default version: Google Ads API versions are sunset on a schedule, so the operator must choose a current one.
    if (!e.GOOGLE_ADS_API_VERSION) throw new Error("GOOGLE_ADS_API_VERSION (e.g. v23) is required when Google OAuth is configured. Check Google's release notes for the current version.");
    cfg.google = { clientId: e.GOOGLE_OAUTH_CLIENT_ID, clientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET, apiVersion: e.GOOGLE_ADS_API_VERSION };
  }
  if (e.META_APP_ID && e.META_APP_SECRET) {
    if (!e.META_API_VERSION) throw new Error("META_API_VERSION (e.g. v26.0) is required when Meta OAuth is configured. Check Meta's changelog for the current version.");
    cfg.meta = { appId: e.META_APP_ID, appSecret: e.META_APP_SECRET, apiVersion: e.META_API_VERSION };
  }
  return cfg;
}
