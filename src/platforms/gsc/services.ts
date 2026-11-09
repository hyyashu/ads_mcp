import type { GscClient } from "./client";

/** What a Search Console tool handler receives as `ctx.services`. Handlers never see tokens. */
export interface GscServices {
  gsc: GscClient;
  /** Changes attempted so far through this site's client. Zero means nothing has reached Search Console. */
  mutationsSent(): number;
}
