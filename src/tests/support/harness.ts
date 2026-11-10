import type { FetchLike, GoogleTokenProvider } from "../../auth/token-providers";
import type { Db } from "../../db";
import { loadInventory } from "../../inventory";
import { createExecutor, runTool, type PipelineDeps } from "../../mcp/pipeline";
import { ToolRegistry } from "../../mcp/registry";
import { googleTools } from "../../platforms/google";
import { GoogleAdsHttp } from "../../platforms/google/http";
import { createServicesFactory } from "../../platforms/services";
import { ApprovalService } from "../../security/approvals";
import { RateLimiter } from "../../security/rate-limit";
import { addUser, seedAccount, seedTenant, testDb } from "./helpers";
import { schemaChecked } from "./schema-guard";

/**
 * Everything a Google tool test needs except the fake API itself: a fresh database, one tenant with an owner and a second
 * approver, one connected Google account, the real tool registry and approval service, and `run` / `approveAs` helpers.
 * Each test file supplies only `fetch`, its stand-in for googleads.googleapis.com.
 */
export async function googleHarness(label: string, fetch: FetchLike, o: { images?: (url: string) => Promise<Buffer>; youtube?: import("../../platforms/google/youtube").YouTubeClient; pages?: (url: string) => Promise<string> } = {}) {
  const db: Db = await testDb();
  const t = await seedTenant(db, label, "owner");
  const tenantId = t.tenant.id;
  const owner = t.user.id;
  const second = (await addUser(db, tenantId, "adm", "admin")).id;
  const accountId = (await seedAccount(db, tenantId, "google_ads")).id;
  const approvals = new ApprovalService(db);
  const http = new GoogleAdsHttp({ apiVersion: "v99", sleep: async () => {}, fetch: schemaChecked(fetch) });
  const deps: PipelineDeps = {
    db,
    registry: new ToolRegistry(loadInventory()).registerAll(googleTools),
    approvals,
    tenantLimiter: new RateLimiter(10_000, 10_000),
    accountLimiter: new RateLimiter(10_000, 10_000),
    createServices: createServicesFactory({ db, youtube: o.youtube, fetchPage: o.pages ?? (async () => { throw new Error("no test page fetcher"); }), fetchImage: o.images ?? (async () => { throw new Error("no test image fetcher"); }), google: { tokens: { getAccessToken: async () => "tok" } as unknown as GoogleTokenProvider, http } }),
  };
  return {
    db,
    tenantId,
    owner,
    second,
    accountId,
    approvals,
    deps,
    /** Calls a tool as the tenant owner with read and write scopes, against the connected account. */
    run: (name: string, args: Record<string, unknown>) =>
      runTool(deps, deps.registry.get(name)!, { account_id: accountId, ...args }, { tenantId, userId: owner, role: "owner", scopes: ["ads:read", "ads:write"] }),
    /** Approves (and executes) a pending request as `userId` (any owner or admin, the requester included). */
    approveAs: (approvalId: string, userId: string) =>
      approvals.decide({ tenantId, approvalId, decider: { userId, role: userId === owner ? "owner" : "admin" }, decision: "approve", execute: createExecutor(deps) }),
  };
}
export type GoogleHarness = Awaited<ReturnType<typeof googleHarness>>;
