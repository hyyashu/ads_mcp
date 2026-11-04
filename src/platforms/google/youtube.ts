import type { FetchLike } from "../../auth/token-providers";
import { ToolError } from "../../mcp/errors";

/**
 * YouTube Data API v3 videos.list (developers.google.com/youtube/v3/docs/videos, checked 2026-11-04): duration
 * (contentDetails.duration, ISO 8601), status.uploadStatus / privacyStatus / embeddable / madeForKids,
 * contentDetails.regionRestriction, and player.embedWidth / embedHeight when maxWidth is given (used for the aspect
 * ratio). The API key is sent in the x-goog-api-key header (Google Cloud "Use API keys" guide), never in the URL.
 */
export interface YouTubeVideo {
  id: string;
  title: string | null;
  channel: string | null;
  duration_seconds: number | null;
  upload_status: string | null;
  privacy_status: string | null;
  embeddable: boolean | null;
  made_for_kids: boolean | null;
  region_blocked: string[];
  region_allowed: string[] | null;
  aspect_ratio: number | null;
}

/** ISO 8601 duration (PT1H2M3S, P1DT2H) to seconds. */
export function isoDurationSeconds(d: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(d);
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

export class YouTubeClient {
  private f: FetchLike;
  constructor(private o: { apiKey: string; fetch?: FetchLike }) {
    this.f = o.fetch ?? fetch;
  }

  async videos(ids: string[]): Promise<YouTubeVideo[]> {
    const qs = new URLSearchParams({ part: "snippet,contentDetails,status,player", id: ids.join(","), maxWidth: "1000", maxResults: "50" });
    let res: Response;
    try {
      res = await this.f(`https://www.googleapis.com/youtube/v3/videos?${qs}`, { headers: { "x-goog-api-key": this.o.apiKey, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new ToolError("transient", "Could not reach the YouTube Data API.", { retryable: true });
    }
    const body = (await res.json().catch(() => ({}))) as { items?: Record<string, any>[]; error?: { code?: number; message?: string } };
    if (res.status === 403 || res.status === 400) throw new ToolError("platform_permission_denied", `YouTube Data API refused the request: ${(body.error?.message ?? "").replace(/key=[^&\s]+/gi, "key=[redacted]").slice(0, 200)}`);
    if (res.status === 429) throw new ToolError("quota_exceeded", "YouTube Data API quota reached.", { retryAfterSeconds: 3600 });
    if (!res.ok) throw new ToolError("transient", "YouTube Data API is temporarily unavailable.", { retryable: true });
    return (body.items ?? []).map((v) => {
      const w = Number(v.player?.embedWidth), h = Number(v.player?.embedHeight);
      return {
        id: String(v.id),
        title: v.snippet?.title ?? null,
        channel: v.snippet?.channelTitle ?? null,
        duration_seconds: v.contentDetails?.duration ? isoDurationSeconds(v.contentDetails.duration) : null,
        upload_status: v.status?.uploadStatus ?? null,
        privacy_status: v.status?.privacyStatus ?? null,
        embeddable: typeof v.status?.embeddable === "boolean" ? v.status.embeddable : null,
        made_for_kids: typeof v.status?.madeForKids === "boolean" ? v.status.madeForKids : null,
        region_blocked: v.contentDetails?.regionRestriction?.blocked ?? [],
        region_allowed: v.contentDetails?.regionRestriction?.allowed ?? null,
        aspect_ratio: w > 0 && h > 0 ? Math.round((w / h) * 1000) / 1000 : null,
      };
    });
  }
}
