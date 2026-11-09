/** One account found at connect time, in the shape PlatformOAuth stores. */
export interface DiscoveredAccount {
  externalId: string;
  displayName: string;
  loginCustomerId: null;
  currencyCode: string | null;
  timeZone: string | null;
}
export interface Discovery {
  accounts: DiscoveredAccount[];
  /** Found but not connected (no data access, unreadable, or past the per-connection limit). */
  skipped: number;
}
/** At most this many accounts per connection (same limit as the ads connections). */
export const MAX_DISCOVERED = 500;
