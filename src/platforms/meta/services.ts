import type { MetaAdsClient } from "./client";

/** What a Meta tool handler receives as `ctx.services`. Handlers never see tokens. */
export interface MetaServices {
  meta: MetaAdsClient;
  /** Changes attempted so far through this account's client. Zero means nothing has reached Meta. */
  mutationsSent(): number;
}
