import type { Ga4Client } from "./client";

/** What a GA4 tool handler receives as `ctx.services`. Handlers never see tokens. */
export interface Ga4Services {
  ga4: Ga4Client;
  /** Changes attempted so far through this property's client. Zero means nothing has reached Google Analytics. */
  mutationsSent(): number;
}
