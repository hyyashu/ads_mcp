import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db";
import { appUser, webSession } from "../db/schema";
import { sha256 } from "../security/canonical";
import type { Role } from "./context";

export const SESSION_COOKIE = "adsmcp_session";
const TTL_MS = 8 * 3600_000;

export interface WebSession {
  sessionId: string;
  tenantId: string;
  userId: string;
  role: Role;
  csrfSecret: string;
}

export async function createSession(db: Db, o: { tenantId: string; userId: string; now?: Date }): Promise<{ token: string; maxAgeSeconds: number }> {
  const token = randomBytes(32).toString("base64url");
  const now = o.now ?? new Date();
  await db.insert(webSession).values({
    tokenHash: sha256(token),
    tenantId: o.tenantId,
    userId: o.userId,
    csrfSecret: randomBytes(32).toString("base64url"),
    expiresAt: new Date(now.getTime() + TTL_MS),
    createdAt: now,
  });
  return { token, maxAgeSeconds: TTL_MS / 1000 };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function getSession(db: Db, cookieHeader: string | undefined, now = new Date()): Promise<WebSession | null> {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  const [row] = await db
    .select({ id: webSession.id, tenantId: webSession.tenantId, userId: webSession.userId, csrfSecret: webSession.csrfSecret, role: appUser.role })
    .from(webSession)
    .innerJoin(appUser, eq(appUser.id, webSession.userId))
    .where(and(eq(webSession.tokenHash, sha256(token)), gt(webSession.expiresAt, now)));
  return row ? { sessionId: row.id, tenantId: row.tenantId, userId: row.userId, role: row.role as Role, csrfSecret: row.csrfSecret } : null;
}

export async function destroySession(db: Db, cookieHeader: string | undefined) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token) await db.delete(webSession).where(eq(webSession.tokenHash, sha256(token)));
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
export const clearCookie = (secure: boolean) => `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;

/** CSRF token derived from the session secret and a purpose, so a token for one form cannot be replayed on another. */
export const csrfToken = (s: Pick<WebSession, "csrfSecret">, purpose: string) => createHmac("sha256", s.csrfSecret).update(purpose).digest("base64url");

export function verifyCsrf(s: Pick<WebSession, "csrfSecret">, purpose: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const a = Buffer.from(csrfToken(s, purpose));
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
