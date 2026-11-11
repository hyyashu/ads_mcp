import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { platformTools } from "../../core/tool-defs";
import { BING_MANAGE, BING_READ } from "../scopes";
import type { BingServices } from "../services";

export { BING_MANAGE, BING_READ };

/**
 * Shared pieces of every Bing Webmaster tool. Facts: docs/VERIFICATION.md, "Bing Webmaster tools (2026-11-10)".
 * Section files (tools/<section>.ts) import from here and never from each other.
 */
export const accountId = z.string().min(1).describe("Bing Webmaster site: the site URL exactly as Bing Webmaster Tools shows it (e.g. https://www.example.com/) or the account_id from list_accounts.");

const bing = platformTools<BingServices>("bing_webmaster", {
  read: { platformPermissions: [BING_READ], notes: "Bing Webmaster connection (read-only or allow changes; webmaster.manage covers reads too) on a verified site." },
  write: { platformPermissions: [BING_MANAGE], notes: "Bing Webmaster connection with changes allowed (webmaster.manage scope) on a verified site." },
});
/** Declares a Bing Webmaster read tool. */
export const bingRead = bing.read;
/** Declares a Bing Webmaster write tool. Writes never run directly: the pipeline queues an approval first. */
export const bingWrite = bing.write;

/** An absolute http(s) URL argument (at most 2,048 characters, no #fragment). */
export const httpUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((u) => {
    try {
      const x = new URL(u);
      return (x.protocol === "https:" || x.protocol === "http:") && !x.username && !x.password && !u.includes("#");
    } catch {
      return false;
    }
  }, "expected an absolute http(s) URL without #fragment");

/**
 * Whether `url` belongs to the Bing site `siteUrl`: same scheme-less host, and inside the site's path when the site is a path
 * prefix. Bing site URLs may omit the trailing slash ("http://example.com"), so the host is compared, not raw prefixes.
 */
export function withinSite(siteUrl: string, url: string): boolean {
  try {
    const s = new URL(siteUrl);
    const u = new URL(url);
    if (s.hostname.toLowerCase() !== u.hostname.toLowerCase()) return false;
    const base = s.pathname.endsWith("/") ? s.pathname : `${s.pathname}/`;
    return base === "/" || u.pathname === s.pathname || u.pathname.startsWith(base);
  } catch {
    return false;
  }
}

/** Refuses a URL outside the account's site, before anything is sent. */
export function requireWithinSite(siteUrl: string, url: string, what = "URL"): void {
  if (!withinSite(siteUrl, url)) throw new ToolError("invalid_argument", `${url} is not inside the Bing site ${siteUrl}. Use the ${what} through the site it belongs to.`, { definite: true });
}

/** Reads back after a change; a failed read means the outcome is unconfirmed, never "failed". */
export async function readBack<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw new ToolError("unknown_outcome", "The change was sent but reading it back failed, so its outcome is not confirmed. Check Bing Webmaster Tools before trying again.");
  }
}

/** Page of a list a tool returns: sorted rows, the first `limit`, and honest totals. */
export function page<T>(all: T[], limit: number): { rows: T[]; returned: number; total: number; truncated: boolean } {
  const rows = all.slice(0, limit);
  return { rows, returned: rows.length, total: all.length, truncated: all.length > rows.length };
}
