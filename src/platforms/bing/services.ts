import type { BingClient } from "./client";

/** What a Bing Webmaster tool handler receives as `ctx.services`. Handlers never see tokens. */
export interface BingServices {
  bing: BingClient;
  /** Changes attempted so far through this site's client. Zero means nothing has reached Bing. */
  mutationsSent(): number;
}
