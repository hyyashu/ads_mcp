import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ToolError, redact, toToolError } from "../../mcp/errors";
import { canonicalJson, hashArgs } from "../../security/canonical";
import { CredentialCipher, credentialAad, keyringFromEnv } from "../../security/crypto";
import { RateLimiter } from "../../security/rate-limit";

const key = () => randomBytes(32).toString("base64");

describe("credential encryption", () => {
  const cipher = new CredentialCipher(keyringFromEnv({ ADS_MCP_KEYS: `1:${key()}` }));
  const aad = credentialAad("tenant-a", "conn-1");

  it("round-trips and never contains the plaintext", () => {
    const { enc } = cipher.encrypt({ refreshToken: "1//SECRET-REFRESH-TOKEN-VALUE" }, aad);
    expect(enc).not.toContain("SECRET");
    expect(cipher.decrypt<{ refreshToken: string }>(enc, aad).refreshToken).toBe("1//SECRET-REFRESH-TOKEN-VALUE");
  });

  it("is bound to its row: the same ciphertext fails under another tenant or connection", () => {
    const { enc } = cipher.encrypt({ a: 1 }, aad);
    expect(() => cipher.decrypt(enc, credentialAad("tenant-b", "conn-1"))).toThrow();
    expect(() => cipher.decrypt(enc, credentialAad("tenant-a", "conn-2"))).toThrow();
  });

  it("rejects tampering", () => {
    const parts = cipher.encrypt({ a: 1 }, aad).enc.split(".");
    parts[3] = Buffer.from("tampered-ciphertext").toString("base64");
    expect(() => cipher.decrypt(parts.join("."), aad)).toThrow();
  });

  it("uses a fresh IV every time", () => {
    expect(cipher.encrypt({ a: 1 }, aad).enc).not.toBe(cipher.encrypt({ a: 1 }, aad).enc);
  });

  it("supports key rotation: old ciphertext still decrypts and is flagged for re-encryption", () => {
    const k1 = key();
    const old = new CredentialCipher(keyringFromEnv({ ADS_MCP_KEYS: `1:${k1}` }));
    const { enc, keyVersion } = old.encrypt({ a: 1 }, aad);
    expect(keyVersion).toBe(1);
    const rotated = new CredentialCipher(keyringFromEnv({ ADS_MCP_KEYS: `1:${k1},2:${key()}` }));
    expect(rotated.activeVersion).toBe(2);
    expect(rotated.decrypt(enc, aad)).toEqual({ a: 1 });
    expect(rotated.needsRotation(enc)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt({ a: 1 }, aad).enc)).toBe(false);
  });

  it("refuses a missing or malformed keyring", () => {
    expect(() => keyringFromEnv({})).toThrow(/ADS_MCP_KEYS is required/);
    expect(() => keyringFromEnv({ ADS_MCP_KEYS: "1:c2hvcnQ=" })).toThrow(/32 bytes/);
    expect(() => keyringFromEnv({ ADS_MCP_KEYS: `1:${key()}`, ADS_MCP_ACTIVE_KEY: "9" })).toThrow(/not in ADS_MCP_KEYS/);
  });
});

describe("canonical hashing", () => {
  it("is independent of key order and ignores undefined", () => {
    expect(hashArgs({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(hashArgs({ b: { d: [1, 2], c: 2 }, a: 1, z: undefined }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
  });
});

describe("error redaction", () => {
  it("strips credentials from upstream error text", () => {
    const dirty = "401 for Bearer ya29.A0ARrdaMabcdefghijklmnop and refresh 1//0gABCDEFGHIJKLMNOPQRSTUV and token EAABwzLixnjYBO1234567890abcdef and access_token=abcdef123456789 developer-token: ZZZZZZZZZZZZ";
    const clean = redact(dirty);
    for (const secret of ["ya29.", "1//0g", "EAABwz", "abcdef123456789", "ZZZZZZZZZZZZ"]) expect(clean).not.toContain(secret);
  });

  it("unknown errors never leak their message", () => {
    const e = toToolError(new Error("connection string postgres://user:pw@host"));
    expect(e.code).toBe("internal");
    expect(e.message).not.toContain("postgres://");
  });

  it("ToolError keeps its code and redacts its message", () => {
    const e = toToolError(new ToolError("quota_exceeded", "limit Bearer abcdefghijklmnop", { retryAfterSeconds: 5 }));
    expect(e.code).toBe("quota_exceeded");
    expect(e.retryable).toBe(true);
    expect(e.message).not.toContain("abcdefghijklmnop");
  });
});

describe("rate limiter", () => {
  it("allows a burst, then refuses with a retry hint, then refills", () => {
    let now = 0;
    const rl = new RateLimiter(3, 1, () => now);
    expect([rl.take("t"), rl.take("t"), rl.take("t")].every((r) => r.ok)).toBe(true);
    const denied = rl.take("t");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    now += 2000;
    expect(rl.take("t").ok).toBe(true);
  });

  it("keeps tenants separate", () => {
    const rl = new RateLimiter(1, 0.001, () => 0);
    expect(rl.take("a").ok).toBe(true);
    expect(rl.take("a").ok).toBe(false);
    expect(rl.take("b").ok).toBe(true);
  });
});
