export type Role = "owner" | "admin" | "member";

/** Who is calling and for which tenant. Established by an Authenticator from the request, never from tool arguments. */
export interface AuthContext {
  tenantId: string;
  userId: string;
  role: Role;
  scopes: string[];
  tokenId?: string;
}

export interface Authenticator {
  /** Returns the caller, or null when the request carries no valid credential. */
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthContext | null>;
}

/** The token of an "Authorization: Bearer <token>" header, or null. One parser for every authenticator. */
export function bearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.authorization;
  const h = Array.isArray(raw) ? raw[0] : raw;
  return h?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
}
