import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../../db/schema";
import { googleHarness } from "../support/harness";

const J = (b: unknown) => new Response(JSON.stringify(b));

describe("second review: failures before the platform client exists are definite", () => {
  it("stored arguments that no longer parse fail the request as 'failed' (re-requestable), never 'unknown_outcome'", async () => {
    let mutations = 0;
    const kit = await googleHarness("R2", async (url) => {
      if (url.endsWith("googleAds:search")) return J({ results: [{ campaign: { id: "11", name: "Brand", status: "ENABLED", resourceName: "customers/1234567890/campaigns/11" } }] });
      mutations++;
      return J({ results: [{}] });
    });
    const r = await kit.run("pause_campaign", { campaign_id: "11" });
    // Simulate a deploy that changed the tool's input schema after the request was queued.
    await kit.db.update(schema.approvalRequest).set({ args: { account_id: kit.accountId, campaign_id: "not-a-number" } }).where(eq(schema.approvalRequest.id, r.approval!.approval_id));
    const done = await kit.approveAs(r.approval!.approval_id, kit.owner);
    expect(done.status).toBe("failed");
    expect(mutations).toBe(0);
    // A failed request frees its key: the same change can be requested again.
    expect((await kit.run("pause_campaign", { campaign_id: "11" })).approval?.status).toBe("pending_approval");
  });
});
