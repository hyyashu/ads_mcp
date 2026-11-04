import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

/** True for any address a server must never be tricked into contacting. */
export function isForbiddenAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local incl. cloud metadata 169.254.169.254
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    if (x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb")) return true; // link-local
    if (x.startsWith("fc") || x.startsWith("fd")) return true; // unique local
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isForbiddenAddress(mapped[1]!);
    return false;
  }
  return true; // not an IP at all: refuse
}

export class UnsafeUrlError extends Error {}

export function assertSafeHttpsUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("not a valid URL");
  }
  if (u.protocol !== "https:") throw new UnsafeUrlError("only https URLs are allowed");
  if (u.username || u.password) throw new UnsafeUrlError("credentials in URL are not allowed");
  if (u.port && u.port !== "443") throw new UnsafeUrlError("non-standard ports are not allowed");
  if (isIP(u.hostname.replace(/^\[|\]$/g, ""))) throw new UnsafeUrlError("IP literals are not allowed");
  if (u.hostname === "localhost" || !u.hostname.includes(".")) throw new UnsafeUrlError("host is not a public name");
  return u;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/**
 * A `lookup` for http(s).request that refuses forbidden addresses at connect time. Node may call lookup with `{ all: true }`
 * (it does by default on Node 20+, for happy-eyeballs connection attempts) and then expects an ARRAY of {address, family};
 * otherwise it expects a single address and family. Both forms are supported here.
 */
export function safeLookup(resolve: (host: string) => Promise<string[]>) {
  return (host: string, opts: { all?: boolean } | number | undefined, cb: LookupCallback) => {
    resolve(host).then(
      (addrs) => {
        if (addrs.length === 0 || addrs.some(isForbiddenAddress)) return cb(new UnsafeUrlError("host resolves to a forbidden address") as NodeJS.ErrnoException, "", 4);
        const list = addrs.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
        if (typeof opts === "object" && opts?.all) return cb(null, list);
        cb(null, list[0]!.address, list[0]!.family);
      },
      (e) => cb(e as NodeJS.ErrnoException, "", 4),
    );
  };
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Injectable for tests. Must return the addresses the name resolves to. */
  resolve?: (host: string) => Promise<string[]>;
}

/**
 * GET a bounded document from an untrusted URL. Defences: https only, public DNS names only, every resolved address
 * checked at connect time (so DNS rebinding cannot swap in a private address), no redirects, a hard size and time limit,
 * and an allowed content type.
 */
export async function safeFetchBytes(raw: string, opts: SafeFetchOptions & { accept: string; contentTypes: string[]; userAgent?: string }): Promise<{ bytes: Buffer; contentType: string }> {
  const url = assertSafeHttpsUrl(raw);
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const resolve = opts.resolve ?? (async (h: string) => (await dnsLookup(h, { all: true })).map((a) => a.address));
  return new Promise((resolve_, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: { accept: opts.accept, "user-agent": opts.userAgent ?? "ads-mcp-fetcher" },
        timeout: opts.timeoutMs ?? 5000,
        // Validate the address actually used for the connection.
        lookup: safeLookup(resolve) as never,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new UnsafeUrlError(`unexpected status ${res.statusCode} (redirects are not followed)`));
        }
        const type = String(res.headers["content-type"] ?? "").toLowerCase().split(";")[0]!.trim();
        if (!opts.contentTypes.includes(type)) {
          res.resume();
          return reject(new UnsafeUrlError(`content type must be one of ${opts.contentTypes.join(", ")}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new UnsafeUrlError("document too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve_({ bytes: Buffer.concat(chunks), contentType: type }));
      },
    );
    req.on("timeout", () => req.destroy(new UnsafeUrlError("timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** GET a small JSON document from an untrusted URL (see safeFetchBytes for the defences). */
export async function safeFetchJson(raw: string, opts: SafeFetchOptions = {}): Promise<unknown> {
  const { bytes } = await safeFetchBytes(raw, { ...opts, accept: "application/json", contentTypes: ["application/json"], userAgent: "ads-mcp-client-metadata-fetcher" });
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new UnsafeUrlError("invalid JSON");
  }
}
