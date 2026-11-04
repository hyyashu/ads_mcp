import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import { imageInfo } from "../../google/media";
import type { MetaRow } from "../client";
import { readImages, readVideos, toImage, toVideo } from "./assets";
import { EDGE_CAP, accountId, metaId, metaRead, s } from "./common";

// ------------------------------------------------------------------------------------------- select_meta_campaign_type
/**
 * Goal to ODAX objective. Source: Meta for Developers blog "Simplifying campaign objectives with Outcome-Driven Ad Experiences"
 * (2021-12-21, still the reference the docs search returns on 2026-11-05) and the Campaign reference `objective` field: the six
 * objectives OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS, OUTCOME_APP_PROMOTION, OUTCOME_SALES. (The blog
 * spells one of them "OUTCOME_TRAFFICE": a typo; the API value is OUTCOME_TRAFFIC.) Destination types per objective come from the
 * same post. Meta's docs checked here publish no complete objective -> optimization_goal / billing_event table, so the tool does
 * not invent one: it lists the combinations this ad account already runs with that objective, which Meta has accepted.
 */
export const OBJECTIVES = {
  sales: { objective: "OUTCOME_SALES", destination_types: [] as string[], note: "Conversions on a website, app or in messaging; needs a pixel or app events to optimize for sales." },
  leads: { objective: "OUTCOME_LEADS", destination_types: ["ON_AD (instant lead form)"], note: "Leads through instant forms, messaging, calls or a website." },
  traffic: { objective: "OUTCOME_TRAFFIC", destination_types: [], note: "Visits to a website, app, messaging or profile." },
  awareness: { objective: "OUTCOME_AWARENESS", destination_types: [], note: "Reach and ad recall among the target audience." },
  app_installs: { objective: "OUTCOME_APP_PROMOTION", destination_types: [], note: "App installs and app events." },
  engagement: { objective: "OUTCOME_ENGAGEMENT", destination_types: ["ON_POST", "ON_VIDEO", "ON_EVENT", "ON_PAGE"], note: "Post, video, event or Page engagement, and messages." },
} as const;
type Goal = keyof typeof OBJECTIVES;

export const selectMetaCampaignType = metaRead({
  name: "select_meta_campaign_type",
  title: "Choose a Meta campaign objective",
  description:
    "Maps a goal (sales, leads, traffic, awareness, app_installs, engagement) to Meta's outcome objective (OUTCOME_*) and the destination types Meta documents for it, and lists the optimization goal and billing event combinations this ad account already uses with that objective (from its own ad sets), plus how many pixels it has. Meta's documentation does not publish a full objective-to-optimization-goal table, so none is invented here. Read-only; changes nothing.",
  input: z.object({ account_id: accountId, goal: z.enum(Object.keys(OBJECTIVES) as [Goal, ...Goal[]]) }),
  output: z.object({
    goal: z.string(),
    objective: z.string(),
    note: z.string(),
    documented_destination_types: z.array(z.string()),
    used_in_this_account: z.array(z.object({ optimization_goal: z.string().nullable(), billing_event: z.string().nullable(), ad_sets: z.number() })).describe("Ordered by number of ad sets."),
    campaigns_with_objective: z.number(),
    pixels: z.number(),
    source: z.string(),
  }),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const o = OBJECTIVES[a.goal];
    const [camps, sets, pixels] = await Promise.all([
      m.list(`${m.adAccountId}/campaigns`, { fields: "id,objective" }, EDGE_CAP),
      m.list(`${m.adAccountId}/adsets`, { fields: "id,campaign_id,optimization_goal,billing_event" }, EDGE_CAP),
      m.list(`${m.adAccountId}/adspixels`, { fields: "id" }, 200),
    ]);
    const ids = new Set(camps.filter((c) => s(c, "objective") === o.objective).map((c) => String(c.id)));
    const combos = new Map<string, { optimization_goal: string | null; billing_event: string | null; ad_sets: number }>();
    for (const r of sets.filter((x) => ids.has(String(x.campaign_id)))) {
      const k = `${s(r, "optimization_goal")}|${s(r, "billing_event")}`;
      const cur = combos.get(k) ?? { optimization_goal: s(r, "optimization_goal"), billing_event: s(r, "billing_event"), ad_sets: 0 };
      cur.ad_sets++;
      combos.set(k, cur);
    }
    return {
      goal: a.goal,
      objective: o.objective,
      note: o.note,
      documented_destination_types: [...o.destination_types],
      used_in_this_account: [...combos.values()].sort((x, y) => y.ad_sets - x.ad_sets),
      campaigns_with_objective: ids.size,
      pixels: pixels.length,
      source: "Meta for Developers: Outcome-Driven Ad Experiences (objectives, destination types); this account's own ad sets (optimization goals, billing events).",
    };
  },
});

// ---------------------------------------------------------------------------------------- validate_and_prepare_meta_assets
/**
 * Specs from Meta's "Media Requirements" (Marketing API, Instagram Ads API reference, updated 2025-07-29; checked 2026-11-05):
 * - every image and video at least 600 px wide, "independent of the ad's placement";
 * - Instagram stream (feed) and Explore: aspect ratio from 4:5 to 1.91:1; video length 3 to 60 seconds; video file at most 2.3 GB;
 *   images outside the range are centre-cropped by Meta (a warning, not an error);
 * - Instagram Stories: images and videos from 4:5 to 1.91:1, or 9:16 and taller for videos (videos cannot be cropped); 9:16 recommended;
 * - Facebook: 1080x1080 or larger recommended (a warning only; no Facebook-specific hard limit was found in the docs checked).
 * Aspect ratios are compared with a 1% tolerance because Meta states them rounded (1.91:1 is 1200x628 = 1.911).
 */
const PLACEMENTS = ["facebook_feed", "instagram_feed", "instagram_explore", "instagram_stories"] as const;
type Placement = (typeof PLACEMENTS)[number];
const MIN_WIDTH = 600;
const MAX_VIDEO_BYTES = 2.3 * 1024 ** 3;
const TOL = 0.01;
const within = (r: number, lo: number, hi: number) => r >= lo * (1 - TOL) && r <= hi * (1 + TOL);

export function checkMedia(kind: "image" | "video", m: { width: number | null; height: number | null; duration_seconds?: number | null; bytes?: number | null }, placements: readonly Placement[]) {
  const problems: string[] = [];
  const warnings: string[] = [];
  const unchecked: string[] = [];
  if (m.width === null || m.height === null) unchecked.push("dimensions unknown: width and aspect ratio not checked");
  else {
    if (m.width < MIN_WIDTH) problems.push(`width is ${m.width}px; Meta requires at least ${MIN_WIDTH}px for every placement`);
    const r = m.width / m.height;
    for (const p of placements) {
      if (p === "instagram_feed" || p === "instagram_explore") {
        if (!within(r, 0.8, 1.91)) (kind === "image" ? warnings : problems).push(`${p}: aspect ratio ${r.toFixed(3)}:1 is outside 4:5 to 1.91:1${kind === "image" ? "; Meta will centre-crop it" : ""}`);
      } else if (p === "instagram_stories") {
        const ok = within(r, 0.8, 1.91) || (kind === "video" && r <= (9 / 16) * (1 + TOL));
        if (!ok) (kind === "image" ? warnings : problems).push(`${p}: aspect ratio ${r.toFixed(3)}:1 is not 4:5 to 1.91:1${kind === "video" ? " or 9:16 and taller (videos cannot be cropped)" : "; Meta will crop it"}`);
      } else if (p === "facebook_feed" && kind === "image" && (m.width < 1080 || m.height < 1080)) warnings.push(`${p}: Meta recommends 1080x1080 or larger`);
    }
  }
  if (kind === "video") {
    const ig = placements.some((p) => p === "instagram_feed" || p === "instagram_explore");
    if (ig && m.duration_seconds != null && (m.duration_seconds < 3 || m.duration_seconds > 60)) problems.push(`duration is ${m.duration_seconds}s; Instagram feed and Explore videos must be 3 to 60 seconds`);
    if (ig && m.duration_seconds == null) unchecked.push("duration unknown: give duration_seconds to check the 3-60 second rule");
    if (m.bytes != null && m.bytes > MAX_VIDEO_BYTES) problems.push("file is larger than Meta's 2.3 GB video limit");
  }
  return { problems, warnings, unchecked };
}

const httpsUrl = z.string().url().max(2048).refine((u) => u.startsWith("https://"), "must be an https URL");
const result = z.object({
  source: z.string().describe("The URL, image hash or video id checked."),
  ok: z.boolean().describe("True when no problem was found. Warnings and unchecked items do not make it false."),
  problems: z.array(z.string()),
  warnings: z.array(z.string()),
  unchecked: z.array(z.string()),
  width: z.number().nullable(),
  height: z.number().nullable(),
  bytes: z.number().nullable(),
  mime: z.string().nullable(),
  sha256: z.string().nullable(),
});

export const validateAndPrepareMetaAssets = metaRead({
  name: "validate_and_prepare_meta_assets",
  title: "Validate Meta images and videos",
  description:
    "Checks images and videos against Meta's documented media requirements for the chosen placements, before they are used in ads. Images come from https URLs (downloaded with the server's SSRF-safe fetcher: public hosts only, no redirects, PNG/JPEG/GIF) or from image hashes already in this ad account's library; videos from this account's video library (video_id) or from given dimensions. Rules: at least 600px wide everywhere; Instagram feed and Explore 4:5 to 1.91:1 (images outside are cropped by Meta, videos are refused), videos 3 to 60 seconds and at most 2.3 GB; Instagram Stories 4:5 to 1.91:1, or 9:16 and taller for videos; Facebook feed 1080x1080 recommended. Aspect ratios allow 1% for Meta's rounding. Nothing is uploaded or changed.",
  input: z
    .object({
      account_id: accountId,
      placements: z.array(z.enum(PLACEMENTS)).min(1).max(4),
      images: z.array(z.object({ url: httpsUrl.optional(), image_hash: z.string().regex(/^[A-Za-z0-9]{8,64}$/).optional() }).refine((v) => (v.url === undefined) !== (v.image_hash === undefined), "give url or image_hash")).max(20).default([]),
      videos: z
        .array(
          z
            .object({
              video_id: metaId.optional(),
              width: z.number().int().min(1).max(20_000).optional(),
              height: z.number().int().min(1).max(20_000).optional(),
              duration_seconds: z.number().min(0).max(86_400).optional(),
              bytes: z.number().int().min(0).optional(),
            })
            .refine((v) => v.video_id !== undefined || (v.width !== undefined && v.height !== undefined), "give video_id, or width and height"),
        )
        .max(20)
        .default([]),
    })
    .refine((v) => v.images.length + v.videos.length > 0, "give images or videos"),
  output: z.object({ ok: z.boolean(), placements: z.array(z.string()), images: z.array(result), videos: z.array(result), spec_source: z.string() }),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const placements = [...new Set(a.placements)];
    const needLib = a.images.some((i) => i.image_hash);
    const lib = needLib ? new Map((await readImages(m, EDGE_CAP)).map((r: MetaRow) => [String(r.hash ?? ""), toImage(r)])) : new Map();
    const images = [];
    for (const im of a.images) {
      const source = im.url ?? im.image_hash!;
      try {
        if (im.url) {
          const info = imageInfo(await ctx.services.fetchImage(im.url));
          images.push({ source, ...checkMedia("image", info, placements), ok: false, width: info.width, height: info.height, bytes: info.bytes, mime: info.mime, sha256: info.sha256 });
        } else {
          const r = lib.get(im.image_hash!);
          if (!r) throw new ToolError("not_found", `No image with hash ${im.image_hash} in this ad account's library.`);
          images.push({ source, ...checkMedia("image", { width: r.original_width ?? r.width, height: r.original_height ?? r.height }, placements), ok: false, width: r.original_width ?? r.width, height: r.original_height ?? r.height, bytes: null, mime: null, sha256: null });
        }
      } catch (e) {
        images.push({ source, problems: [e instanceof ToolError ? e.message : "could not be read"], warnings: [], unchecked: [], ok: false, width: null, height: null, bytes: null, mime: null, sha256: null });
      }
    }
    const needVids = a.videos.some((v) => v.video_id);
    const vlib = needVids ? new Map((await readVideos(m, EDGE_CAP)).map((r: MetaRow) => [String(r.id ?? ""), toVideo(r)])) : new Map();
    const videos = a.videos.map((v) => {
      const lv = v.video_id ? vlib.get(v.video_id) : undefined;
      if (v.video_id && !lv) return { source: v.video_id, problems: [`No video ${v.video_id} in this ad account's library.`], warnings: [], unchecked: [], ok: false, width: null, height: null, bytes: null, mime: null, sha256: null };
      const width = v.width ?? lv?.width ?? null;
      const height = v.height ?? lv?.height ?? null;
      return { source: v.video_id ?? `${width}x${height}`, ...checkMedia("video", { width, height, duration_seconds: v.duration_seconds ?? null, bytes: v.bytes ?? null }, placements), ok: false, width, height, bytes: v.bytes ?? null, mime: null, sha256: null };
    });
    for (const x of [...images, ...videos]) x.ok = x.problems.length === 0;
    return { ok: [...images, ...videos].every((x) => x.ok), placements, images, videos, spec_source: "Meta for Developers, Marketing API: Instagram Ads API Media Requirements (updated 2025-07-29)." };
  },
});

export const helperTools = [selectMetaCampaignType, validateAndPrepareMetaAssets];
