import type { GtmClient } from "./client";

/** What a Tag Manager tool handler receives as `ctx.services`. Handlers never see tokens. */
export interface GtmServices {
  gtm: GtmClient;
  /** Changes attempted so far through this container's client. Zero means nothing has reached Tag Manager. */
  mutationsSent(): number;
}
