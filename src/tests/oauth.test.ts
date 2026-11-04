import { createHash, randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redirectMatches, roleScopes, validateRedirectUri } from "../auth/oauth-server";
import { hashPassword, verifyPassword } from "../auth/passwords";
import { assertSafeHttpsUrl, isForbiddenAddress, safeFetchJson } from "../auth/ssrf";
import { clearCookie, csrfToken, sessionCookie, verifyCsrf } from "../auth/web-session";
import { schema } from "../db";
import { sha256 } from "../security/canonical";
import { addUser, harness, PASSWORD, seedAccount, seedTenant, setPassword, startStack, type Harness, type Stack } from "./helpers";

const pkce = () => {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const form = (o: Record<string, string>) => new URLSearchParams(o);

let h: Harness;
let st: Stack;
let owner: { id: string; email: string; tenantId: string };
let member: { id: string; email: string };
let cimdCalls = 0;
let cimdDoc: Record<string, unknown> | Error = {};

beforeAll(async () => {
  h = await harness();
  const t = await seedTenant(h.db, "O", "owner");
  await setPassword(h.db, t.user.id);
  await seedAccount(h.db, t.tenant.id, "google_ads");
  owner = { id: t.user.id, email: t.user.email, tenantId: t.tenant.id };
  const m = await addUser(h.db, t.tenant.id, "member1", "member");
  await setPassword(h.db, m.id);
  member = { id: m.id, email: m.email };
  st = await startStack(h, {
    fetchClientMetadata: async () => {
      cimdCalls++;
      if (cimdDoc instanceof Error) throw cimdDoc;
      return cimdDoc;
    },
  });
});
afterAll(async () => {
  await st.close();
});

async function register(extra: Record<string, unknown> = {}, uris: string[] = ["https://client.example/cb"]) {
  const r = await fetch(`${st.base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test Client", redirect_uris: uris, ...extra }) });
  return { status: r.status, body: (await r.json()) as Record<string, any>, headers: r.headers };
}

/** Runs the whole browser flow up to the redirect carrying the code. */
async function getCode(opts: { email?: string; scope?: string | null; client?: string; redirect?: string; challenge: string; state?: string; access?: "read" | "write" }) {
  const cookie = await st.login(opts.email ?? owner.email);
  const params = new URLSearchParams({
    client_id: opts.client!, redirect_uri: opts.redirect ?? "https://client.example/cb", response_type: "code", code_challenge: opts.challenge, code_challenge_method: "S256",
    state: opts.state ?? "xyz", scope: opts.scope ?? "ads:read", resource: `${st.base}/mcp`,
  });
  if (opts.scope === null) params.delete("scope");
  const page = await fetch(`${st.base}/authorize?${params}`, { headers: { cookie } });
  const html = await page.text();
  const csrf = html.split('action="/authorize"')[1]?.match(/name="csrf" value="([^"]+)"/)?.[1];
  const res = await fetch(`${st.base}/authorize`, { method: "POST", redirect: "manual", headers: { cookie, origin: st.base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...Object.fromEntries(params), csrf: csrf ?? "", decision: "allow", ...(opts.access ? { access: opts.access } : {}) }) });
  return { page, html, res, location: res.headers.get("location") ? new URL(res.headers.get("location")!) : null };
}

async function tokenCall(body: Record<string, string>) {
  const r = await fetch(`${st.base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any>, headers: r.headers };
}

async function fullGrant(scope: string | null = "ads:read ads:write", email = owner.email, access?: "read" | "write") {
  const reg = await register();
  const p = pkce();
  const got = await getCode({ client: reg.body.client_id, challenge: p.challenge, scope, email, access });
  const code = got.location!.searchParams.get("code")!;
  const tok = await tokenCall({ grant_type: "authorization_code", code, code_verifier: p.verifier, client_id: reg.body.client_id, redirect_uri: "https://client.example/cb" });
  return { reg, p, code, tok };
}

const mcpStatus = async (token: string) => (await fetch(`${st.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status;

describe("discovery (RFC 9728 / RFC 8414)", () => {
  it("serves protected resource metadata that points at this server as the authorization server", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await fetch(`${st.base}${path}`);
      const j = (await r.json()) as Record<string, any>;
      expect(r.status).toBe(200);
      expect(j.resource).toBe(`${st.base}/mcp`);
      expect(j.authorization_servers).toEqual([st.base]);
      expect(j.scopes_supported).toEqual(["ads:read", "ads:write"]);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  it("advertises PKCE S256 only, public clients, registration and client-id-metadata-document support", async () => {
    const j = (await (await fetch(`${st.base}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
    expect(j.issuer).toBe(st.base);
    expect(j.code_challenge_methods_supported).toEqual(["S256"]);
    expect(j.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(j.client_id_metadata_document_supported).toBe(true);
    expect(j.registration_endpoint).toBe(`${st.base}/register`);
    expect(j.authorization_response_iss_parameter_supported).toBe(true);
    expect(j.scopes_supported).not.toContain("ads:approve");
  });

  it("an unauthenticated /mcp request is challenged with the metadata URL and scope", async () => {
    const r = await fetch(`${st.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${st.base}/.well-known/oauth-protected-resource"`);
    expect(r.headers.get("www-authenticate")).toContain('scope="ads:read ads:write"');
  });

  it("answers CORS preflight for the public OAuth endpoints", async () => {
    const r = await fetch(`${st.base}/token`, { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("dynamic client registration (RFC 7591)", () => {
  it("registers a public client and never issues a secret", async () => {
    const r = await register();
    expect(r.status).toBe(201);
    expect(r.body.client_id).toMatch(/^mcpc_/);
    expect(r.body.client_secret).toBeUndefined();
    expect(r.body.token_endpoint_auth_method).toBe("none");
  });

  it("accepts https, loopback http (any port) and private-use scheme redirects", async () => {
    expect((await register({}, ["https://app.example/cb", "http://127.0.0.1:53211/cb", "http://localhost/cb", "cursor://anysphere.cursor-retrieval/oauth/callback"])).status).toBe(201);
  });

  it("rejects unsafe or malformed registrations", async () => {
    for (const body of [
      { redirect_uris: [] },
      { redirect_uris: ["http://evil.example/cb"] },
      { redirect_uris: ["javascript:alert(1)"] },
      { redirect_uris: ["https://a.example/cb#frag"] },
      { redirect_uris: ["https://user:pw@a.example/cb"] },
      { redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" },
      { redirect_uris: ["https://a.example/cb"], grant_types: ["password"] },
      { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a${i}.example/cb`) },
      {},
    ]) {
      const r = await fetch(`${st.base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("redirect URI rules", () => {
    expect(validateRedirectUri("https://a.example/cb")).toBeNull();
    expect(validateRedirectUri("http://[::1]:9/cb")).toBeNull();
    expect(validateRedirectUri("http://a.example/cb")).toMatch(/loopback/);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb")).toBe(true);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb2")).toBe(false);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example/cb/")).toBe(false);
    expect(redirectMatches(["http://127.0.0.1/cb"], "http://127.0.0.1:61234/cb")).toBe(true); // loopback port may vary
    expect(redirectMatches(["http://127.0.0.1/cb"], "http://127.0.0.1:61234/other")).toBe(false);
    expect(redirectMatches(["https://a.example/cb"], "https://a.example:8443/cb")).toBe(false); // https: exact only
  });
});

describe("Client ID Metadata Documents", () => {
  const url = "https://client.example.com/oauth/metadata.json";
  const good = () => ({ client_id: url, client_name: "CIMD App", redirect_uris: ["https://client.example.com/cb"] });

  it("resolves a valid document and caches it", async () => {
    cimdDoc = good();
    cimdCalls = 0;
    const a = await st.oauth.resolveClient(url);
    const b = await st.oauth.resolveClient(url);
    expect(a).toMatchObject({ clientId: url, name: "CIMD App", redirectUris: ["https://client.example.com/cb"] });
    expect(b?.clientId).toBe(url);
    expect(cimdCalls).toBe(1);
  });

  it("accepts a document that prefers private_key_jwt but also supports public auth (ChatGPT's shape)", async () => {
    const u = "https://client.example.com/chatgpt-shape.json";
    cimdDoc = {
      client_id: u,
      client_name: "ChatGPT",
      redirect_uris: ["https://client.example.com/connector_platform_oauth_redirect"],
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      jwks_uri: "https://client.example.com/oauth/jwks.json",
    };
    expect(await st.oauth.resolveClient(u)).toMatchObject({ clientId: u, name: "ChatGPT" });
  });

  it("rejects documents that are inconsistent or unsafe", async () => {
    const cases: Record<string, Record<string, unknown>> = {
      "client_id mismatch": { ...good(), client_id: "https://other.example/x.json" },
      "has a secret": { ...good(), client_secret: "s3cret" },
      "bad redirect": { ...good(), redirect_uris: ["http://evil.example/cb"] },
      "confidential auth": { ...good(), token_endpoint_auth_method: "client_secret_post" },
      "confidential only": { ...good(), token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["private_key_jwt"] },
      "no redirects": { ...good(), redirect_uris: [] },
    };
    for (const [name, doc] of Object.entries(cases)) {
      const u = `https://client.example.com/${name.replace(/\W/g, "-")}.json`;
      cimdDoc = { ...doc, client_id: doc.client_id === good().client_id ? u : doc.client_id };
      expect(await st.oauth.resolveClient(u), name).toBeNull();
    }
  });

  it("returns null when the fetch fails, and for non-https or private-looking client ids", async () => {
    cimdDoc = new Error("boom");
    expect(await st.oauth.resolveClient("https://down.example.com/m.json")).toBeNull();
    for (const bad of ["http://client.example.com/m.json", "https://127.0.0.1/m.json", "https://localhost/m.json", "https://user:pw@client.example.com/m.json", "https://client.example.com:8443/m.json"]) {
      cimdDoc = good();
      expect(await st.oauth.resolveClient(bad), bad).toBeNull();
    }
  });
});

describe("SSRF defences", () => {
  it("classifies forbidden addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "not-an-ip"]) {
      expect(isForbiddenAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) expect(isForbiddenAddress(ip), ip).toBe(false);
  });

  it("only allows plain public https URLs", () => {
    expect(() => assertSafeHttpsUrl("https://app.example.com/m.json")).not.toThrow();
    for (const u of ["http://a.example.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://[::1]/x", "https://a.example.com:8443/x", "https://u:p@a.example.com/x", "ftp://a.example.com/x", "not a url", "https://intranet/x"]) {
      expect(() => assertSafeHttpsUrl(u), u).toThrow();
    }
  });

  it("refuses to connect when DNS resolves to a private address (including rebinding to metadata IPs)", async () => {
    for (const addr of ["169.254.169.254", "10.0.0.5", "127.0.0.1", "::1"]) {
      await expect(safeFetchJson("https://innocent.example.com/m.json", { resolve: async () => [addr] })).rejects.toThrow();
    }
    // A name with one public and one private record is refused outright.
    await expect(safeFetchJson("https://mixed.example.com/m.json", { resolve: async () => ["8.8.8.8", "10.0.0.5"] })).rejects.toThrow();
  });
});

describe("authorization code flow with PKCE", () => {
  it("unauthenticated users are sent to log in, then returned to the authorize request", async () => {
    const reg = await register();
    const p = pkce();
    const q = new URLSearchParams({ client_id: reg.body.client_id, redirect_uri: "https://client.example/cb", response_type: "code", code_challenge: p.challenge, code_challenge_method: "S256" });
    const r = await fetch(`${st.base}/authorize?${q}`, { redirect: "manual" });
    expect(r.status).toBe(303);
    const loc = r.headers.get("location")!;
    expect(loc.startsWith("/login?next=")).toBe(true);
    expect(decodeURIComponent(loc)).toContain(reg.body.client_id);
  });

  it("completes: consent -> code -> tokens -> an authenticated MCP call", async () => {
    const { tok, reg } = await fullGrant();
    expect(tok.status).toBe(200);
    expect(tok.body).toMatchObject({ token_type: "Bearer", scope: "ads:read ads:write", expires_in: 3600 });
    expect(tok.body.access_token).toMatch(/^mcpat_/);
    expect(tok.body.refresh_token).toMatch(/^mcprt_/);
    expect(tok.headers.get("cache-control")).toBe("no-store");

    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${st.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok.body.access_token}` } } }));
    const { tools } = await c.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await c.close();
    expect(reg.status).toBe(201);
  });

  it("returns state and iss on the redirect, and the consent page names the client", async () => {
    const reg = await register({ client_name: "Acme Agent" });
    const got = await getCode({ client: reg.body.client_id, challenge: pkce().challenge, state: "state-123" });
    expect(got.html).toContain("Acme Agent");
    expect(got.location!.searchParams.get("state")).toBe("state-123");
    expect(got.location!.searchParams.get("iss")).toBe(st.base);
    expect(got.location!.searchParams.get("code")).toMatch(/^mcpac_/);
  });

  it("works for a client identified by a Client ID Metadata Document", async () => {
    const url = "https://app.example.com/client.json";
    cimdDoc = { client_id: url, client_name: "Metadata Client", redirect_uris: ["https://app.example.com/cb"] };
    const p = pkce();
    const got = await getCode({ client: url, redirect: "https://app.example.com/cb", challenge: p.challenge });
    const tok = await tokenCall({ grant_type: "authorization_code", code: got.location!.searchParams.get("code")!, code_verifier: p.verifier, client_id: url, redirect_uri: "https://app.example.com/cb" });
    expect(tok.status).toBe(200);
  });

  it("the consent page offers read only or read and propose changes, with changes pre-selected", async () => {
    const reg = await register();
    const got = await getCode({ client: reg.body.client_id, challenge: pkce().challenge, scope: "ads:read ads:write" });
    expect(got.html).toMatch(/name="access" value="write" checked/);
    expect(got.html).toMatch(/name="access" value="read"/);
    const ro = await getCode({ client: reg.body.client_id, challenge: pkce().challenge, scope: "ads:read" });
    expect(ro.html).not.toContain('name="access"'); // nothing to choose when only read was requested
    const mem = await getCode({ client: reg.body.client_id, challenge: pkce().challenge, scope: "ads:read ads:write", email: member.email });
    expect(mem.html).not.toContain('name="access"'); // members only ever get read
  });

  it("grants what the person chose: write by default, read only when they pick it", async () => {
    const both = await fullGrant("ads:read ads:write", owner.email, "write");
    expect(both.tok.body.scope).toBe("ads:read ads:write");
    const readOnly = await fullGrant("ads:read ads:write", owner.email, "read");
    expect(readOnly.tok.body.scope).toBe("ads:read");
    const noScope = await fullGrant(null, owner.email); // a client that asks for nothing gets the default: both
    expect(noScope.tok.body.scope).toBe("ads:read ads:write");
  });

  it("a forged access=write cannot widen the grant", async () => {
    const ro = await fullGrant("ads:read", owner.email, "write"); // client asked for read only
    expect(ro.tok.body.scope).toBe("ads:read");
    const mem = await fullGrant("ads:read ads:write", member.email, "write");
    expect(mem.tok.body.scope).toBe("ads:read");
  });

  it("members only ever receive read scope", async () => {
    const { tok } = await fullGrant("ads:read ads:write", member.email);
    expect(tok.body.scope).toBe("ads:read");
    expect(roleScopes("member")).toEqual(["ads:read"]);
  });

  it("escapes client-controlled text on the consent page (no script injection)", async () => {
    const reg = await register({ client_name: "<script>alert(1)</script>" });
    const got = await getCode({ client: reg.body.client_id, challenge: pkce().challenge });
    expect(got.html).not.toContain("<script>alert(1)</script>");
    expect(got.html).toContain("&lt;script&gt;");
    expect(got.page.headers.get("x-frame-options")).toBe("DENY");
    expect(got.page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // "no-referrer" makes browsers send `Origin: null` on same-origin form POSTs, so every form fails the
    // origin check. "same-origin" keeps the real Origin and still sends no referrer to other sites.
    expect(got.page.headers.get("referrer-policy")).toBe("same-origin");
  });
});

describe("authorization request validation", () => {
  const base = async () => {
    const reg = await register();
    return { client_id: reg.body.client_id as string, redirect_uri: "https://client.example/cb", response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s1" };
  };
  const ask = async (q: Record<string, string>) => {
    const cookie = await st.login(owner.email);
    return fetch(`${st.base}/authorize?${new URLSearchParams(q)}`, { redirect: "manual", headers: { cookie } });
  };

  it("never redirects to an unregistered redirect URI; shows an error page instead", async () => {
    const q = await base();
    const r = await ask({ ...q, redirect_uri: "https://evil.example/cb" });
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
  });

  it("unknown client -> error page", async () => {
    expect((await ask({ ...(await base()), client_id: "mcpc_nope" })).status).toBe(400);
  });

  it("requires PKCE with S256", async () => {
    const q = await base();
    const noChallenge = { ...q } as Record<string, string>;
    delete noChallenge.code_challenge;
    for (const [bad, expected] of [[noChallenge, "invalid_request"], [{ ...q, code_challenge_method: "plain" }, "invalid_request"], [{ ...q, code_challenge: "short" }, "invalid_request"]] as const) {
      const r = await ask(bad);
      expect(r.status).toBe(303);
      expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe(expected);
    }
  });

  it("rejects wrong response_type, a foreign resource, and unknown scopes (errors go to the validated redirect URI)", async () => {
    const q = await base();
    const err = async (extra: Record<string, string>) => new URL((await ask({ ...q, ...extra })).headers.get("location")!).searchParams.get("error");
    expect(await err({ response_type: "token" })).toBe("unsupported_response_type");
    expect(await err({ resource: "https://other.example/mcp" })).toBe("invalid_target");
    expect(await err({ scope: "ads:read admin" })).toBe("invalid_scope");
    expect(await err({ scope: "ads:approve" })).toBe("invalid_scope"); // approval is never grantable to a client
  });

  it("consent POST needs a valid CSRF token and a same-origin request", async () => {
    const reg = await register();
    const q = await base();
    const cookie = await st.login(owner.email);
    const body = new URLSearchParams({ ...q, client_id: reg.body.client_id, decision: "allow", csrf: "forged" });
    const noCsrf = await fetch(`${st.base}/authorize`, { method: "POST", redirect: "manual", headers: { cookie, origin: st.base, "content-type": "application/x-www-form-urlencoded" }, body });
    expect(noCsrf.status).toBe(403);
    const goodCsrf = csrfToken((await (await import("../auth/web-session")).getSession(h.db, cookie))!, "consent");
    const crossOrigin = await fetch(`${st.base}/authorize`, { method: "POST", redirect: "manual", headers: { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...q, client_id: reg.body.client_id, decision: "allow", csrf: goodCsrf }) });
    expect(crossOrigin.status).toBe(403);
    const noOrigin = await fetch(`${st.base}/authorize`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...q, client_id: reg.body.client_id, decision: "allow", csrf: goodCsrf }) });
    expect(noOrigin.status).toBe(403);
  });

  it("deny sends access_denied to the client", async () => {
    const reg = await register();
    const cookie = await st.login(owner.email);
    const q = { client_id: reg.body.client_id, redirect_uri: "https://client.example/cb", response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256", state: "d1" };
    const csrf = csrfToken((await (await import("../auth/web-session")).getSession(h.db, cookie))!, "consent");
    const r = await fetch(`${st.base}/authorize`, { method: "POST", redirect: "manual", headers: { cookie, origin: st.base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...q, csrf, decision: "deny" }) });
    const u = new URL(r.headers.get("location")!);
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("state")).toBe("d1");
    expect(u.searchParams.get("code")).toBeNull();
  });
});

describe("token endpoint", () => {
  it("requires form-encoded bodies and supported grants", async () => {
    const r = await fetch(`${st.base}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(400);
    expect((await tokenCall({ grant_type: "password", username: "a", password: "b" })).body.error).toBe("unsupported_grant_type");
  });

  it("rejects a wrong PKCE verifier, and the code stays usable only with the right one", async () => {
    const reg = await register();
    const p = pkce();
    const code = (await getCode({ client: reg.body.client_id, challenge: p.challenge })).location!.searchParams.get("code")!;
    const bad = await tokenCall({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, client_id: reg.body.client_id, redirect_uri: "https://client.example/cb" });
    expect(bad).toMatchObject({ status: 400 });
    expect(bad.body.error).toBe("invalid_grant");
    const ok = await tokenCall({ grant_type: "authorization_code", code, code_verifier: p.verifier, client_id: reg.body.client_id, redirect_uri: "https://client.example/cb" });
    expect(ok.status).toBe(200);
  });

  it("binds the code to its client and redirect URI", async () => {
    const reg = await register({}, ["https://client.example/cb", "https://client.example/other"]);
    const other = await register();
    const p = pkce();
    const code = (await getCode({ client: reg.body.client_id, challenge: p.challenge })).location!.searchParams.get("code")!;
    const t = (client_id: string, redirect_uri: string) => tokenCall({ grant_type: "authorization_code", code, code_verifier: p.verifier, client_id, redirect_uri });
    expect((await t(other.body.client_id, "https://client.example/cb")).body.error).toBe("invalid_grant");
    expect((await t(reg.body.client_id, "https://client.example/other")).body.error).toBe("invalid_grant");
    expect((await t(reg.body.client_id, "https://client.example/cb")).status).toBe(200);
  });

  it("an expired code is refused", async () => {
    const reg = await register();
    const p = pkce();
    const code = (await getCode({ client: reg.body.client_id, challenge: p.challenge })).location!.searchParams.get("code")!;
    await h.db.update(schema.oauthAuthCode).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.oauthAuthCode.codeHash, sha256(code)));
    expect((await tokenCall({ grant_type: "authorization_code", code, code_verifier: p.verifier, client_id: reg.body.client_id, redirect_uri: "https://client.example/cb" })).body.error).toBe("invalid_grant");
  });

  it("code reuse is refused AND revokes the tokens already issued from it", async () => {
    const { reg, p, code, tok } = await fullGrant();
    expect(await mcpStatus(tok.body.access_token)).toBe(200);
    const again = await tokenCall({ grant_type: "authorization_code", code, code_verifier: p.verifier, client_id: reg.body.client_id, redirect_uri: "https://client.example/cb" });
    expect(again.body.error).toBe("invalid_grant");
    expect(await mcpStatus(tok.body.access_token)).toBe(401);
    expect((await tokenCall({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token, client_id: reg.body.client_id })).body.error).toBe("invalid_grant");
  });

  it("a demoted user's grant is cut down at exchange time", async () => {
    const u = await addUser(h.db, owner.tenantId, "demoted", "admin");
    await setPassword(h.db, u.id);
    const reg = await register();
    const p = pkce();
    const code = (await getCode({ client: reg.body.client_id, challenge: p.challenge, scope: "ads:read ads:write", email: u.email })).location!.searchParams.get("code")!;
    await h.db.update(schema.appUser).set({ role: "member" }).where(eq(schema.appUser.id, u.id));
    const tok = await tokenCall({ grant_type: "authorization_code", code, code_verifier: p.verifier, client_id: reg.body.client_id, redirect_uri: "https://client.example/cb" });
    expect(tok.body.scope).toBe("ads:read");
  });
});

describe("refresh tokens", () => {
  it("rotates on every use and the new access token works", async () => {
    const { reg, tok } = await fullGrant();
    const r1 = await tokenCall({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token, client_id: reg.body.client_id });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(tok.body.refresh_token);
    expect(await mcpStatus(r1.body.access_token)).toBe(200);
  });

  it("reusing a rotated refresh token revokes the whole chain (theft detection)", async () => {
    const { reg, tok } = await fullGrant();
    const r1 = await tokenCall({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token, client_id: reg.body.client_id });
    const replay = await tokenCall({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token, client_id: reg.body.client_id });
    expect(replay.body.error).toBe("invalid_grant");
    expect(await mcpStatus(r1.body.access_token)).toBe(401);
    expect((await tokenCall({ grant_type: "refresh_token", refresh_token: r1.body.refresh_token, client_id: reg.body.client_id })).body.error).toBe("invalid_grant");
  });

  it("cannot widen scope, may narrow it, and is bound to its client", async () => {
    const { reg, tok } = await fullGrant("ads:read");
    expect((await tokenCall({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token, client_id: reg.body.client_id, scope: "ads:read ads:write" })).body.error).toBe("invalid_scope");
    const other = await register();
    expect((await tokenCall({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token, client_id: other.body.client_id })).body.error).toBe("invalid_grant");
    const ok = await tokenCall({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token, client_id: reg.body.client_id, scope: "ads:read" });
    expect(ok.status).toBe(200);
  });
});

describe("resource server: token validation and revocation", () => {
  it("a token issued for a different audience is refused (no token passthrough)", async () => {
    const { tok } = await fullGrant();
    await h.db.update(schema.oauthAccessToken).set({ resource: "https://some-other-api.example/mcp" }).where(eq(schema.oauthAccessToken.tokenHash, sha256(tok.body.access_token)));
    expect(await mcpStatus(tok.body.access_token)).toBe(401);
  });

  it("expired and garbage tokens are refused", async () => {
    const { tok } = await fullGrant();
    await h.db.update(schema.oauthAccessToken).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.oauthAccessToken.tokenHash, sha256(tok.body.access_token)));
    expect(await mcpStatus(tok.body.access_token)).toBe(401);
    expect(await mcpStatus("mcpat_garbage")).toBe(401);
  });

  it("revoking an access token takes effect immediately; revoking a refresh token kills the family", async () => {
    const a = await fullGrant();
    await fetch(`${st.base}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ token: a.tok.body.access_token, client_id: a.reg.body.client_id }) });
    expect(await mcpStatus(a.tok.body.access_token)).toBe(401);

    const b = await fullGrant();
    const rv = await fetch(`${st.base}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ token: b.tok.body.refresh_token, client_id: b.reg.body.client_id }) });
    expect(rv.status).toBe(200);
    expect(await mcpStatus(b.tok.body.access_token)).toBe(401);
  });

  it("revocation of an unknown token still returns 200 (no oracle)", async () => {
    expect((await fetch(`${st.base}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ token: "nope" }) })).status).toBe(200);
  });

  it("only hashes are stored", async () => {
    const { tok, code } = await fullGrant();
    const blob = JSON.stringify([...(await h.db.select().from(schema.oauthAccessToken)), ...(await h.db.select().from(schema.oauthRefreshToken)), ...(await h.db.select().from(schema.oauthAuthCode))]);
    for (const secret of [tok.body.access_token, tok.body.refresh_token, code]) expect(blob).not.toContain(secret);
  });
});

describe("human login and sessions", () => {
  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${st.base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: st.base, ...headers }, body: form(body) });

  it("rejects a wrong password and an unknown user identically (no user enumeration)", async () => {
    const wrong = await post("/login", { email: owner.email, password: "nope-nope-nope", next: "/" });
    const unknown = await post("/login", { email: "nobody@t.test", password: "nope-nope-nope", next: "/" });
    expect(wrong.status).toBe(303);
    expect(wrong.headers.get("location")).toBe(unknown.headers.get("location"));
    expect(wrong.headers.get("set-cookie")).toBeNull();
  });

  it("refuses cross-site login posts (login CSRF)", async () => {
    expect((await post("/login", { email: owner.email, password: PASSWORD }, { origin: "https://evil.example" })).status).toBe(403);
    const noOrigin = await fetch(`${st.base}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ email: owner.email, password: PASSWORD }) });
    expect(noOrigin.status).toBe(403);
  });

  it("does not redirect to other sites after login (open redirect)", async () => {
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      const r = await post("/login", { email: owner.email, password: PASSWORD, next });
      expect(r.headers.get("location")).toBe("/");
    }
    expect((await post("/login", { email: owner.email, password: PASSWORD, next: "/approvals" })).headers.get("location")).toBe("/approvals");
  });

  it("sets an HttpOnly, SameSite session cookie (Secure over https)", async () => {
    const r = await post("/login", { email: owner.email, password: PASSWORD });
    const c = r.headers.get("set-cookie")!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(sessionCookie("t", 10, true)).toMatch(/; Secure/);
    expect(clearCookie(false)).toMatch(/Max-Age=0/);
  });

  it("logout needs CSRF and really ends the session", async () => {
    const cookie = await st.login(owner.email);
    expect((await post("/logout", { csrf: "forged" }, { cookie })).headers.get("set-cookie")).toMatch(/Max-Age=0/); // clears the cookie either way
    expect((await fetch(`${st.base}/approvals`, { redirect: "manual", headers: { cookie } })).status).toBe(200); // forged logout did not end it
    const csrf = await st.csrfFor(cookie, "/approvals", "/logout");
    await post("/logout", { csrf }, { cookie });
    expect((await fetch(`${st.base}/approvals`, { redirect: "manual", headers: { cookie } })).status).toBe(303); // now sent to /login
  });

  it("CSRF tokens are per-purpose and session-bound", () => {
    const s = { csrfSecret: "secret-a" };
    expect(verifyCsrf(s, "consent", csrfToken(s, "consent"))).toBe(true);
    expect(verifyCsrf(s, "consent", csrfToken(s, "logout"))).toBe(false);
    expect(verifyCsrf({ csrfSecret: "secret-b" }, "consent", csrfToken(s, "consent"))).toBe(false);
    expect(verifyCsrf(s, "consent", undefined)).toBe(false);
  });

  it("password hashing is salted, verifiable and rejects wrong input", async () => {
    const a = await hashPassword("hunter2-hunter2");
    const b = await hashPassword("hunter2-hunter2");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("hunter2-hunter2", a)).toBe(true);
    expect(await verifyPassword("hunter3-hunter3", a)).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", "garbage")).toBe(false);
  });

  it("the database refuses mixed-case emails (so every user can log in)", async () => {
    await expect(h.db.insert(schema.appUser).values({ tenantId: owner.tenantId, email: "MixedCase@t.test" })).rejects.toThrow();
  });

  it("personal API tokens still work alongside OAuth tokens", async () => {
    const { issueApiToken } = await import("../auth/api-token");
    const { token } = await issueApiToken(h.db, { tenantId: owner.tenantId, userId: owner.id, label: "pat", scopes: ["ads:read"] });
    expect(await mcpStatus(token)).toBe(200);
  });
});
