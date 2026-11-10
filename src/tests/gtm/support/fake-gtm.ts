import type { FetchLike, GoogleTokenProvider } from "../../../auth/token-providers";
import type { Db } from "../../../db";
import { loadInventory } from "../../../inventory";
import type { Envelope } from "../../../mcp/envelope";
import { createExecutor, createVerifier, runTool, type PipelineDeps } from "../../../mcp/pipeline";
import { ToolRegistry } from "../../../mcp/registry";
import { GoogleApiHttp } from "../../../platforms/gapi/http";
import { gtmTools } from "../../../platforms/gtm";
import type { GtmBuiltIn, GtmContainerInfo, GtmStatus, GtmTag, GtmTrigger, GtmVariable, GtmVersion, GtmWorkspace } from "../../../platforms/gtm/types";
import { createServicesFactory } from "../../../platforms/services";
import { ApprovalService } from "../../../security/approvals";
import { type Limiter, RateLimiter } from "../../../security/rate-limit";
import { addUser, seedAccount, seedTenant, testDb } from "../../support/helpers";

/**
 * In-memory Tag Manager v2 for one container (accounts/1/containers/2): workspaces with their tags, triggers, variables and
 * built-ins, versions, the live version. Routes by method + path like tagmanager.googleapis.com, records every call, bumps
 * fingerprints on change, enforces ?fingerprint= (412 on mismatch), deletes a workspace when it is versioned.
 */
export const C = "accounts/1/containers/2";
const API = "https://tagmanager.googleapis.com/tagmanager/v2/";
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const err = (status: number, s: string, message: string) => J({ error: { code: status, status: s, message } }, status);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

interface Ws {
  ws: GtmWorkspace;
  baseVersionId: string | null;
  tags: GtmTag[];
  triggers: GtmTrigger[];
  variables: GtmVariable[];
  builtIns: GtmBuiltIn[];
}
export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export class FakeGtm {
  container: GtmContainerInfo = { path: C, accountId: "1", containerId: "2", name: "Shop", publicId: "GTM-ABC123", usageContext: ["web"], domainName: ["shop.example"], tagIds: ["GTM-ABC123"], fingerprint: "c1" };
  otherContainers: GtmContainerInfo[] = [{ path: "accounts/1/containers/3", containerId: "3", name: "App", publicId: "GTM-APP999", usageContext: ["android"] }];
  workspaces: Ws[] = [];
  versions: GtmVersion[] = [];
  liveId: string | null = null;
  calls: Call[] = [];
  /** Items per list page (0: no paging). */
  pageSize = 0;
  /** Maximum workspaces (standard containers: Default + 2). */
  maxWorkspaces = 3;
  /** Next matching request fails with this response, nothing applied. */
  failNext: { re: RegExp; method?: string; status: number; body: unknown }[] = [];
  /** Next matching request is applied, then answered with a 500 (unknown outcome). */
  failAfter: { re: RegExp; method?: string }[] = [];
  /** Accept writes but do not store them (read-back mismatch). */
  dropWrites = false;
  /** Overrides for create_version / publish answers. */
  createVersionAnswer?: (ws: Ws) => Record<string, unknown> | undefined;
  publishCompilerError = false;
  conflicts: GtmStatus["mergeConflict"] = [];
  /** Runs before each request is handled (tests change state mid-flow here). */
  onRequest?: (c: Call) => void;
  private seq = 100;
  private fp = 1000;

  id = () => String(this.seq++);
  nextFp = () => String(this.fp++);

  /** Adds a version (and makes it live when asked). Entities get fingerprints. */
  addVersion(v: Partial<GtmVersion> & { containerVersionId: string }, live = false): GtmVersion {
    const full: GtmVersion = { path: `${C}/versions/${v.containerVersionId}`, name: `v${v.containerVersionId}`, fingerprint: this.nextFp(), tag: [], trigger: [], variable: [], builtInVariable: [], ...clone(v) };
    this.versions.push(full);
    if (live) this.liveId = full.containerVersionId!;
    return full;
  }
  latest(): GtmVersion | null {
    const vs = this.versions.filter((v) => !v.deleted);
    return vs.sort((a, b) => Number(b.containerVersionId) - Number(a.containerVersionId))[0] ?? null;
  }
  /** Adds a workspace starting from the latest version (or empty). */
  addWorkspace(name: string, description = "", o: { from?: GtmVersion | null } = {}): Ws {
    const base = o.from === undefined ? this.latest() : o.from;
    const id = this.id();
    const w: Ws = {
      ws: { path: `${C}/workspaces/${id}`, workspaceId: id, name, description, fingerprint: this.nextFp() },
      baseVersionId: base?.containerVersionId ?? null,
      tags: clone(base?.tag ?? []).map((t) => ({ ...t, workspaceId: id, fingerprint: this.nextFp() })),
      triggers: clone(base?.trigger ?? []).map((t) => ({ ...t, workspaceId: id, fingerprint: this.nextFp() })),
      variables: clone(base?.variable ?? []).map((t) => ({ ...t, workspaceId: id, fingerprint: this.nextFp() })),
      builtIns: clone(base?.builtInVariable ?? []),
    };
    this.workspaces.push(w);
    return w;
  }
  ws(id: string) {
    return this.workspaces.find((w) => w.ws.workspaceId === id);
  }
  server() {
    return this.workspaces.find((w) => w.ws.name === "JackOfAds");
  }
  writes() {
    return this.calls.filter((c) => c.method !== "GET");
  }

  private page<T>(items: T[], key: string, q: Record<string, string>) {
    if (!this.pageSize) return J({ [key]: items });
    const at = Number(q.pageToken ?? 0);
    const next = at + this.pageSize;
    return J({ [key]: items.slice(at, next), ...(next < items.length ? { nextPageToken: String(next) } : {}) });
  }

  private status(w: Ws): GtmStatus {
    const base = this.versions.find((v) => v.containerVersionId === w.baseVersionId);
    const changes: GtmStatus["workspaceChange"] = [];
    const cmp = <T extends Record<string, unknown>>(kind: string, idKey: string, mine: T[], theirs: T[]) => {
      const strip = (x: T) => JSON.stringify({ ...x, fingerprint: undefined, workspaceId: undefined, path: undefined });
      for (const x of mine) {
        const b = theirs.find((y) => y[idKey] === x[idKey]);
        if (!b) changes.push({ changeStatus: "added", [kind]: x });
        else if (strip(b) !== strip(x)) changes.push({ changeStatus: "updated", [kind]: x });
      }
      for (const y of theirs) if (!mine.some((x) => x[idKey] === y[idKey])) changes.push({ changeStatus: "deleted", [kind]: y });
    };
    cmp("tag", "tagId", w.tags as never, (base?.tag ?? []) as never);
    cmp("trigger", "triggerId", w.triggers as never, (base?.trigger ?? []) as never);
    cmp("variable", "variableId", w.variables as never, (base?.variable ?? []) as never);
    return { workspaceChange: changes, mergeConflict: this.conflicts };
  }

  fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (!u.href.startsWith(API)) return err(400, "INVALID_ARGUMENT", `unexpected host ${u.host}`);
    const path = decodeURIComponent(u.pathname.replace("/tagmanager/v2/", ""));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call: Call = { method, path, query: Object.fromEntries(u.searchParams), body };
    this.calls.push(call);
    this.onRequest?.(call);
    const fi = this.failNext.findIndex((f) => f.re.test(path) && (!f.method || f.method === method));
    if (fi >= 0) {
      const f = this.failNext.splice(fi, 1)[0]!;
      return J(f.body, f.status);
    }
    const ai = this.failAfter.findIndex((f) => f.re.test(path) && (!f.method || f.method === method));
    const res = this.handle(method, path, call.query, body);
    if (ai >= 0) {
      this.failAfter.splice(ai, 1);
      return err(500, "INTERNAL", "backend error");
    }
    return res;
  };

  private handle(method: string, path: string, q: Record<string, string>, body: any): Response {
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "accounts/1/containers") return this.page([this.container, ...this.otherContainers], "container", q);
    if (method === "GET" && path === C) return J(this.container);
    if (path === `${C}/workspaces`) {
      if (method === "GET") return this.page(this.workspaces.map((w) => w.ws), "workspace", q);
      if (this.workspaces.length >= this.maxWorkspaces) return err(400, "INVALID_ARGUMENT", "Workspace limit reached.");
      const w = this.addWorkspace(body.name, body.description);
      return J(w.ws);
    }
    if ((m = /^accounts\/1\/containers\/2\/workspaces\/(\d+)(.*)$/.exec(path))) {
      const w = this.ws(m[1]!);
      if (!w) return err(404, "NOT_FOUND", "Workspace not found");
      const rest = m[2]!;
      if (rest === "/status" && method === "GET") return J(this.status(w));
      if (rest === ":create_version" && method === "POST") {
        const custom = this.createVersionAnswer?.(w);
        if (custom) return J(custom);
        const vid = String(Math.max(0, ...this.versions.map((v) => Number(v.containerVersionId))) + 1);
        const strip = <T extends object>(x: T) => ({ ...x, workspaceId: undefined, fingerprint: this.nextFp() });
        const v = this.addVersion({ containerVersionId: vid, name: body.name, description: body.notes, tag: w.tags.map(strip), trigger: w.triggers.map(strip), variable: w.variables.map(strip), builtInVariable: w.builtIns });
        this.workspaces = this.workspaces.filter((x) => x !== w);
        return J({ containerVersion: v, compilerError: false });
      }
      const coll = /^\/(tags|triggers|variables|built_in_variables)(?:\/(\d+))?$/.exec(rest);
      if (!coll) return err(404, "NOT_FOUND", `no route ${method} ${path}`);
      const [, kind, eid] = coll;
      const key = { tags: "tags", triggers: "triggers", variables: "variables", built_in_variables: "builtIns" }[kind!] as "tags" | "triggers" | "variables" | "builtIns";
      const idKey = { tags: "tagId", triggers: "triggerId", variables: "variableId", built_in_variables: "type" }[kind!]!;
      const items = w[key] as Record<string, unknown>[];
      const itemsKey = { tags: "tag", triggers: "trigger", variables: "variable", built_in_variables: "builtInVariable" }[kind!]!;
      if (!eid) {
        if (method === "GET") return this.page(items, itemsKey, q);
        if (method === "POST" && (kind === "tags" || kind === "triggers")) {
          const id = this.id();
          const created = { ...body, [idKey]: id, path: `${w.ws.path}/${kind}/${id}`, accountId: "1", containerId: "2", workspaceId: w.ws.workspaceId, fingerprint: this.nextFp() };
          if (!this.dropWrites) {
            items.push(created);
            w.ws.fingerprint = this.nextFp();
          }
          return J(created);
        }
      } else {
        const i = items.findIndex((x) => x[idKey] === eid);
        if (i < 0) return err(404, "NOT_FOUND", "Not found");
        if (method === "GET") return J(items[i]);
        if (method === "PUT" && kind === "tags") {
          if (q.fingerprint && q.fingerprint !== items[i]!.fingerprint) return err(412, "FAILED_PRECONDITION", "Fingerprint does not match.");
          const updated = { ...body, tagId: eid, workspaceId: w.ws.workspaceId, fingerprint: this.nextFp() };
          if (!this.dropWrites) {
            items[i] = updated;
            w.ws.fingerprint = this.nextFp();
          }
          return J(updated);
        }
      }
      return err(404, "NOT_FOUND", `no route ${method} ${path}`);
    }
    if (path === `${C}/versions:live` && method === "GET") {
      const v = this.versions.find((x) => x.containerVersionId === this.liveId);
      return v ? J(v) : err(404, "NOT_FOUND", "Not found or permission denied.");
    }
    if (path === `${C}/version_headers:latest` && method === "GET") {
      const v = this.latest();
      return v ? J({ containerVersionId: v.containerVersionId, name: v.name, numTags: String(v.tag?.length ?? 0) }) : err(404, "NOT_FOUND", "Not found");
    }
    if ((m = /^accounts\/1\/containers\/2\/versions\/(\d+)(:publish)?$/.exec(path))) {
      const v = this.versions.find((x) => x.containerVersionId === m![1]);
      if (!v) return err(404, "NOT_FOUND", "Version not found");
      if (!m[2] && method === "GET") return J(v);
      if (m[2] && method === "POST") {
        if (q.fingerprint && q.fingerprint !== v.fingerprint) return err(412, "FAILED_PRECONDITION", "Fingerprint does not match.");
        if (this.publishCompilerError) return J({ compilerError: true });
        if (!this.dropWrites) this.liveId = v.containerVersionId!;
        return J({ containerVersion: v, compilerError: false });
      }
    }
    return err(404, "NOT_FOUND", `no route ${method} ${path}`);
  }
}

/** A tenant with an owner and a second admin, one connected Tag Manager container, the real GTM tools and approvals. */
export async function gtmHarness(label: string, fake: FakeGtm, o: { gtmLimiter?: Limiter; access?: "read" | "write" } = {}) {
  const db: Db = await testDb();
  const t = await seedTenant(db, label, "owner");
  const tenantId = t.tenant.id;
  const owner = t.user.id;
  const second = (await addUser(db, tenantId, "adm", "admin")).id;
  const accountId = (await seedAccount(db, tenantId, "google_tag_manager", o.access ?? "write", "active", C, null)).id;
  const approvals = new ApprovalService(db);
  const http = new GoogleApiHttp({ fetch: (u, i) => fake.fetch(u, i), sleep: async () => {}, random: () => 0 });
  const deps: PipelineDeps = {
    db,
    registry: new ToolRegistry(loadInventory()).registerAll(gtmTools),
    approvals,
    tenantLimiter: new RateLimiter(10_000, 10_000),
    accountLimiter: new RateLimiter(10_000, 10_000),
    createServices: createServicesFactory({ db, gapi: { tokens: { getAccessToken: async () => "tok" } as unknown as Pick<GoogleTokenProvider, "getAccessToken">, http, ...(o.gtmLimiter ? { gtmLimiter: o.gtmLimiter } : {}) } }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (name: string, args: Record<string, unknown>) => runTool(deps, deps.registry.get(name)!, { account_id: accountId, ...args }, { tenantId, userId: owner, role: "owner", scopes: ["ads:read", "ads:write"] }) as Promise<Envelope & { data: any }>;
  return {
    db,
    tenantId,
    owner,
    second,
    accountId,
    approvals,
    deps,
    run,
    approveAs: (approvalId: string, userId: string) => approvals.decide({ tenantId, approvalId, decider: { userId, role: userId === owner ? "owner" : "admin" }, decision: "approve", execute: createExecutor(deps) }),
    verify: createVerifier(deps),
    /** Requests a write and approves it as the second admin; returns the approval row. */
    async request(name: string, args: Record<string, unknown>) {
      const r = await run(name, args);
      if (!r.approval) throw new Error(`expected an approval for ${name}: ${JSON.stringify(r.error)}`);
      return r.approval;
    },
  };
}
export type GtmHarness = Awaited<ReturnType<typeof gtmHarness>>;

/** A realistic web container: GA4 config + event, an Ads conversion, a Meta pixel base, two triggers, variables. */
export function seedContainer(f: FakeGtm, o: { live?: boolean } = {}) {
  const tag = (x: Partial<GtmTag>): GtmTag => ({ accountId: "1", containerId: "2", fingerprint: f.nextFp(), ...x });
  f.addVersion(
    {
      containerVersionId: "41",
      name: "Consent update",
      tag: [
        tag({ tagId: "10", name: "GA4 config", type: "googtag", parameter: [{ type: "template", key: "tagId", value: "G-ABC1234" }], firingTriggerId: ["2147479553"] }),
        tag({ tagId: "12", name: "GA4 - add_to_cart", type: "gaawe", parameter: [{ type: "template", key: "eventName", value: "add_to_cart" }, { type: "template", key: "measurementIdOverride", value: "G-ABC1234" }, { type: "boolean", key: "sendEcommerceData", value: "false" }, { type: "list", key: "eventSettingsTable", list: [] }], firingTriggerId: ["31"] }),
        tag({ tagId: "13", name: "Ads purchase", type: "awct", parameter: [{ type: "template", key: "googleConversionId", value: "987654" }, { type: "template", key: "googleConversionLabel", value: "abcDEF" }], firingTriggerId: ["31"] }),
        tag({ tagId: "14", name: "Meta Pixel - base", type: "html", parameter: [{ type: "template", key: "html", value: "<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){};t.src=v}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init', '1234567890');fbq('track', 'PageView');</script>" }], firingTriggerId: ["2147479553"] }),
      ],
      trigger: [
        { triggerId: "31", name: "Thank you page", type: "pageview", filter: [{ type: "contains", parameter: [{ type: "template", key: "arg0", value: "{{Page Path}}" }, { type: "template", key: "arg1", value: "/thanks" }] }], fingerprint: f.nextFp() },
        { triggerId: "32", name: "All pages (custom)", type: "pageview", fingerprint: f.nextFp() },
      ],
      variable: [{ variableId: "50", name: "Order value", type: "v", parameter: [{ type: "template", key: "name", value: "ecommerce.value" }], fingerprint: f.nextFp() }],
      builtInVariable: [
        { type: "pagePath", name: "Page Path" },
        { type: "pageUrl", name: "Page URL" },
        { type: "event", name: "Event" },
      ],
    },
    o.live ?? true,
  );
  f.addWorkspace("Default Workspace", "");
}
