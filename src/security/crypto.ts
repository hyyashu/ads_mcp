import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM with a versioned keyring and additional authenticated data (AAD).
 * AAD binds each ciphertext to its row (tenant + row id), so a ciphertext copied to another row or
 * tenant fails authentication. In production the keyring should be unwrapped from a KMS at boot; the
 * env-var keyring below is the minimum acceptable setup, not the ideal.
 */
export interface Keyring {
  active: number;
  keys: Map<number, Buffer>;
}

export function keyringFromEnv(env: NodeJS.ProcessEnv = process.env): Keyring {
  // ADS_MCP_KEYS="1:<base64 32 bytes>,2:<base64 32 bytes>"; ADS_MCP_ACTIVE_KEY defaults to the highest version.
  const raw = env.ADS_MCP_KEYS;
  if (!raw) throw new Error("ADS_MCP_KEYS is required (format: 1:<base64 32-byte key>[,2:<key>]). Generate: openssl rand -base64 32");
  const keys = new Map<number, Buffer>();
  for (const part of raw.split(",")) {
    const [v, k] = part.trim().split(":");
    const key = Buffer.from(k ?? "", "base64");
    if (!v || key.length !== 32) throw new Error("Each ADS_MCP_KEYS entry must be <version>:<base64 of exactly 32 bytes>");
    keys.set(Number(v), key);
  }
  const active = env.ADS_MCP_ACTIVE_KEY ? Number(env.ADS_MCP_ACTIVE_KEY) : Math.max(...keys.keys());
  if (!keys.has(active)) throw new Error(`Active key version ${active} is not in ADS_MCP_KEYS`);
  return { active, keys };
}

export class CredentialCipher {
  constructor(private ring: Keyring) {}

  get activeVersion() {
    return this.ring.active;
  }

  /** Output: v<keyVersion>.<iv>.<tag>.<ciphertext> (base64 parts). */
  encrypt(value: unknown, aad: string): { enc: string; keyVersion: number } {
    const version = this.ring.active;
    const key = this.ring.keys.get(version)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const enc = [`v${version}`, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
    return { enc, keyVersion: version };
  }

  decrypt<T>(enc: string, aad: string): T {
    const [v, iv, tag, data] = enc.split(".");
    const version = Number(v?.replace(/^v/, ""));
    const key = this.ring.keys.get(version);
    if (!key || !iv || !tag || !data) throw new Error("Unrecognized credential format or unknown key version");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const out = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]);
    return JSON.parse(out.toString("utf8")) as T;
  }

  /** True when the ciphertext was written with an older key and should be re-encrypted. */
  needsRotation(enc: string): boolean {
    return Number(enc.split(".")[0]?.replace(/^v/, "")) !== this.ring.active;
  }
}

export const credentialAad = (tenantId: string, connectionId: string) => `conn|${tenantId}|${connectionId}`;
