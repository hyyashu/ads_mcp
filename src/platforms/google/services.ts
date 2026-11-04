import type { GoogleAdsClient } from "./client";
import type { ImageFetcher } from "./media";
import type { YouTubeClient } from "./youtube";
/** What a Google tool handler receives as `ctx.services`. */
export interface GoogleServices {
  ads: GoogleAdsClient;
  /** Changes attempted so far through this account's client. Zero means nothing has reached Google Ads. */
  mutationsSent(): number;
  /** Downloads an image for an image asset (SSRF-safe in production; injectable for tests). */
  fetchImage: ImageFetcher;
  /** YouTube Data API client; absent when YOUTUBE_API_KEY is not configured. */
  youtube?: YouTubeClient;
  /** Fetches a public web page (SSRF-safe, text/html, 512 KB) for reading its title and description. */
  fetchPage: (url: string) => Promise<string>;
}

