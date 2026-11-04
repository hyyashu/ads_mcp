import type { ImageFetcher } from "../google/media";
import type { MetaAdsClient } from "./client";

/** What a Meta tool handler receives as `ctx.services`. Handlers never see tokens. */
export interface MetaServices {
  meta: MetaAdsClient;
  /** Changes attempted so far through this account's client. Zero means nothing has reached Meta. */
  mutationsSent(): number;
  /** SSRF-safe image download for validate_and_prepare_meta_assets (https only, public hosts, size cap). */
  fetchImage: ImageFetcher;
}
