import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mapTool } from "../../../inventory/mapping";
import { loadInventory } from "../../inventory";
import { createVerifier } from "../../mcp/pipeline";
import { riskOf } from "../../mcp/tool";
import { fetchTools, latestFetch } from "../../platforms/bing/tools/fetch";
import { FakeBing, RO_SITE, SITE, bingErr, bingHarness, guardProtocol, wcfDay, type BingHarness } from "./fake-bing";
import { type IndexState, P, installIndexHandlers, newIndexState } from "./indexing-fixtures";

const fake = new FakeBing();
guardProtocol(fake);
let kit: BingHarness;
let s: IndexState;
beforeAll(async () => {
  kit = await bingHarness("BFET", fake, fetchTools);
});
beforeEach(() => {
  fake.reset();
  s = newIndexState();
  installIndexHandlers(fake, s);
});

let n = 0;
const fresh = () => P(`fetch-${++n}.html`);
const verify = (args: Record<string, unknown>, snapshot: unknown) =>
  createVerifier(kit.deps)({ tool: "fetch_url_as_bingbot", tenantId: kit.tenantId, accountId: kit.accountId, args: { account_id: kit.accountId, ...args }, planSnapshot: snapshot, requestedBy: kit.owner, decidedBy: kit.second });

describe("risk tiers", () => {
  it("each tool declares the risk inventory/mapping.ts assigns", () => {
    const inv = loadInventory();
    for (const t of fetchTools) expect(riskOf(t), t.name).toBe(mapTool(inv.find((x) => x.name === t.name)!).risk);
    expect(fetchTools.map((t) => t.name).sort()).toEqual(["fetch_url_as_bingbot", "get_bing_fetched_url", "list_bing_fetched_urls"]);
  });
});

describe("fetch_url_as_bingbot", () => {
  it("is a write; the approval says it changes nothing on the site or in the index; nothing is sent before approval", async () => {
    const u = fresh();
    const r = await kit.run("fetch_url_as_bingbot", { url: u });
    expect(r.approval).toMatchObject({ status: "pending_approval", risk: "write" });
    expect(r.approval!.summary).toBe(`Ask Bingbot to fetch ${u} (Bing site ${SITE}) so the result can be inspected. Nothing on the website changes, and this does not add the page to Bing's index or ask Bing to index it.`);
    expect(r.approval!.change_set!.changes[0]).toMatchObject({ resource: "bingbot_fetch", id: u, before: null, after: "requested", effect: "neutral" });
    expect(fake.mutations).toHaveLength(0);
    expect(fake.of("GetFetchedUrls")[0]!.http).toBe("GET");
  });

  it("after approval sends one FetchUrl {siteUrl, url} and confirms it in GetFetchedUrls", async () => {
    const u = fresh();
    const r = await kit.run("fetch_url_as_bingbot", { url: u });
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("executed");
    expect(fake.mutations.map((c) => [c.method, c.body])).toEqual([["FetchUrl", { siteUrl: SITE, url: u }]]);
    expect(done.result).toMatchObject({ site_url: SITE, url: u, requested: true, listed: { url: u, fetched: false, expired: false } });
    expect((done.result as any).listed.date).toMatch(/^2026-11-10T/);
  });

  it("a URL fetched before: the summary says when, and the new request must show a newer entry", async () => {
    const u = fresh();
    s.fetched.push({ Url: u, Date: wcfDay("2026-10-01"), Fetched: true, Expired: true });
    const r = await kit.run("fetch_url_as_bingbot", { url: u });
    expect(r.approval!.summary).toContain("It was last fetched this way 2026-10-01T07:00:00.000Z.");
    expect(r.approval!.change_set!.changes[0]!.before).toBe("2026-10-01T07:00:00.000Z");
    // Bing flipping its own flags between request and approval is not drift.
    s.fetched[0]!.Fetched = false;
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("executed");
  });

  it("someone fetching the same URL between request and approval is drift: nothing is sent", async () => {
    const u = fresh();
    const r = await kit.run("fetch_url_as_bingbot", { url: u });
    s.fetched.push({ Url: u, Date: wcfDay("2026-11-09"), Fetched: true, Expired: false });
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("failed");
    expect((done.result as any).error.code).toBe("conflict");
    expect(fake.mutations).toHaveLength(0);
  });

  it("not listed after the FetchUrl is unknown_outcome; so is a failed read-back", async () => {
    let r = await kit.run("fetch_url_as_bingbot", { url: fresh() });
    s.ignoreFetch = true;
    let done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect((done.result as any).error.message).toContain("not in the fetched URL list yet");
    s.ignoreFetch = false;
    r = await kit.run("fetch_url_as_bingbot", { url: fresh() });
    const sentBefore = fake.mutations.length;
    fake.fail = (c) => (c.method === "GetFetchedUrls" && fake.mutations.length > sentBefore ? bingErr(5, "ThrottleHost") : undefined);
    done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect((done.result as any).error.message).toContain("reading it back failed");
    expect(fake.of("FetchUrl")).toHaveLength(2);
  });

  it("Bing refusing the FetchUrl (NotAllowed) is a definite failure; a 500 is unknown_outcome and never retried", async () => {
    let r = await kit.run("fetch_url_as_bingbot", { url: fresh() });
    fake.handlers.FetchUrl = () => bingErr(13, "NotAllowed");
    let done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("failed");
    expect((done.result as any).error.code).toBe("platform_permission_denied");
    r = await kit.run("fetch_url_as_bingbot", { url: fresh() });
    fake.handlers.FetchUrl = () => bingErr(1, "InternalError", 500);
    done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("unknown_outcome");
    expect(fake.of("FetchUrl")).toHaveLength(2);
  });

  it("refuses URLs outside the site and read-only connections", async () => {
    expect((await kit.run("fetch_url_as_bingbot", { url: "https://other.example.org/" })).error?.code).toBe("invalid_argument");
    expect((await kit.run("fetch_url_as_bingbot", { account_id: kit.readOnlyId, url: `${RO_SITE}a` })).error?.code).toBe("permission_denied");
    expect(fake.calls).toHaveLength(0);
  });

  it("verify: applied when a newer entry is listed, not_applied when none, indeterminate when only the old one", async () => {
    const u = fresh();
    expect(await verify({ url: u }, { site_url: SITE, url: u, previous_date: null })).toEqual({ outcome: "not_applied" });
    s.fetched.push({ Url: u, Date: wcfDay("2026-10-01"), Fetched: true, Expired: false });
    expect((await verify({ url: u }, { site_url: SITE, url: u, previous_date: "2026-10-01T07:00:00.000Z" })).outcome).toBe("indeterminate");
    expect(await verify({ url: u }, { site_url: SITE, url: u, previous_date: null })).toEqual({ outcome: "applied" });
    s.fetched.push({ Url: u, Date: wcfDay("2026-11-10"), Fetched: false, Expired: false });
    expect(await verify({ url: u }, { site_url: SITE, url: u, previous_date: "2026-10-01T07:00:00.000Z" })).toEqual({ outcome: "applied" });
  });

  it("latestFetch matches URLs after parsing and picks the newest", () => {
    const list = [
      { url: "https://WWW.example.com/a", date: "2026-10-01T00:00:00.000Z", fetched: true, expired: false },
      { url: "https://www.example.com/a", date: "2026-11-01T00:00:00.000Z", fetched: false, expired: false },
      { url: "https://www.example.com/b", date: "2026-12-01T00:00:00.000Z", fetched: false, expired: false },
    ];
    expect(latestFetch(list, "https://www.example.com/a")?.date).toBe("2026-11-01T00:00:00.000Z");
    expect(latestFetch(list, "https://www.example.com/c")).toBeNull();
  });
});

describe("list_bing_fetched_urls", () => {
  it("lists newest first with flags, and reports truncation", async () => {
    s.fetched = [
      { Url: P("a"), Date: wcfDay("2026-10-01"), Fetched: true, Expired: true },
      { Url: P("b"), Date: wcfDay("2026-11-05"), Fetched: false, Expired: false },
      { Url: P("c"), Date: wcfDay("2026-11-01"), Fetched: true, Expired: false },
    ];
    let r = await kit.run("list_bing_fetched_urls");
    expect((r.data as any).fetched_urls.map((f: any) => f.url)).toEqual([P("b"), P("c"), P("a")]);
    expect((r.data as any).fetched_urls[2]).toEqual({ url: P("a"), date: "2026-10-01T07:00:00.000Z", fetched: true, expired: true });
    expect(r.data).toMatchObject({ returned: 3, total: 3, truncated: false });
    r = await kit.run("list_bing_fetched_urls", { limit: 1 });
    expect(r.data).toMatchObject({ returned: 1, total: 3, truncated: true });
    expect(fake.of("GetFetchedUrls").every((c) => c.http === "GET" && c.params.get("siteUrl") === SITE)).toBe(true);
  });

  it("an empty list ({\"d\": null}) and a read-only connection both work", async () => {
    fake.handlers.GetFetchedUrls = () => undefined;
    expect((await kit.run("list_bing_fetched_urls")).data).toMatchObject({ fetched_urls: [], returned: 0, truncated: false });
    expect((await kit.run("list_bing_fetched_urls", { account_id: kit.readOnlyId })).ok).toBe(true);
  });
});

describe("get_bing_fetched_url", () => {
  it("returns status, headers and the document, marked untrusted, and caps the document", async () => {
    const u = P("fetched");
    const doc = `<html>${"x".repeat(30_000)}</html>`;
    s.details[u] = { Url: u, Date: wcfDay("2026-11-09"), Status: "200 OK", Headers: "Content-Type: text/html\r\nServer: test", Document: doc };
    let r = await kit.run("get_bing_fetched_url", { url: u });
    const d = r.data as any;
    expect(d).toMatchObject({ url: u, bing_url: u, date: "2026-11-09T07:00:00.000Z", status: "200 OK", headers: "Content-Type: text/html\r\nServer: test", headers_truncated: false, document_chars: doc.length, document_truncated: true });
    expect(d.document).toHaveLength(20_000);
    expect(d.notes[0]).toContain("untrusted");
    expect(d.notes[1]).toContain(`cut to 20,000 of ${doc.length.toLocaleString("en-US")} characters`);
    expect(fake.of("GetFetchedUrlDetails")[0]!.params.get("url")).toBe(u);
    r = await kit.run("get_bing_fetched_url", { url: u, max_document_chars: 100_000 });
    expect(r.data).toMatchObject({ document: doc, document_truncated: false });
    r = await kit.run("get_bing_fetched_url", { url: u, max_document_chars: 0 });
    expect(r.data).toMatchObject({ document: "", document_truncated: true });
  });

  it("caps headers at 8,000 characters; a document Bing does not send is null", async () => {
    const u = P("big-headers");
    s.details[u] = { Url: u, Date: wcfDay("2026-11-09"), Status: "200", Headers: "H: v\r\n".repeat(3000), Document: null as unknown as string };
    const d = (await kit.run("get_bing_fetched_url", { url: u })).data as any;
    expect(d.headers).toHaveLength(8000);
    expect(d).toMatchObject({ headers_truncated: true, document: null, document_chars: null, document_truncated: false });
  });

  it("no fetch result is not_found pointing to fetch_url_as_bingbot; Bing's NotFound maps too", async () => {
    let r = await kit.run("get_bing_fetched_url", { url: P("never") });
    expect(r.error).toMatchObject({ code: "not_found" });
    expect(r.error!.message).toContain("fetch_url_as_bingbot");
    fake.handlers.GetFetchedUrlDetails = () => bingErr(11, "NotFound");
    r = await kit.run("get_bing_fetched_url", { url: P("never") });
    expect(r.error?.code).toBe("not_found");
  });

  it("refuses URLs outside the site and an oversized cap", async () => {
    expect((await kit.run("get_bing_fetched_url", { url: "https://other.example.org/" })).error?.code).toBe("invalid_argument");
    expect((await kit.run("get_bing_fetched_url", { url: P("a"), max_document_chars: 100_001 })).error?.code).toBe("invalid_argument");
    expect(fake.calls).toHaveLength(0);
  });
});
