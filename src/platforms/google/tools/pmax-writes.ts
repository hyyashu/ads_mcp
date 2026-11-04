import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change, Effect } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, pick } from "../gaql";
import { type ImageFieldType } from "../media";
import { tailId } from "./campaign-reads";
import { accountId, idSchema, str } from "./common";
import { imageData, rn, stateWrite, temp, withImages } from "./write-kit";

/**
 * Performance Max writes. Counts and text limits from "Performance Max asset requirements" (v26 docs, checked
 * 2026-11-04): HEADLINE 3-15 (30 chars), LONG_HEADLINE 1-5 (90), DESCRIPTION 2-5 (90), BUSINESS_NAME 1 (25),
 * MARKETING_IMAGE and SQUARE_MARKETING_IMAGE 1-20, PORTRAIT_MARKETING_IMAGE up to 20, LOGO 1-5, LANDSCAPE_LOGO up to 20,
 * YOUTUBE_VIDEO up to 15. With brand guidelines enabled, BUSINESS_NAME, LOGO and LANDSCAPE_LOGO are campaign assets.
 */
const LIMITS: Record<string, { min: number; max: number; chars?: number }> = {
  HEADLINE: { min: 3, max: 15, chars: 30 },
  LONG_HEADLINE: { min: 1, max: 5, chars: 90 },
  DESCRIPTION: { min: 2, max: 5, chars: 90 },
  BUSINESS_NAME: { min: 1, max: 1, chars: 25 },
  MARKETING_IMAGE: { min: 1, max: 20 },
  SQUARE_MARKETING_IMAGE: { min: 1, max: 20 },
  PORTRAIT_MARKETING_IMAGE: { min: 0, max: 20 },
  LOGO: { min: 1, max: 5 },
  LANDSCAPE_LOGO: { min: 0, max: 20 },
  YOUTUBE_VIDEO: { min: 0, max: 15 },
};
const BRAND_FIELDS = new Set(["BUSINESS_NAME", "LOGO", "LANDSCAPE_LOGO"]);
const change = (ref: { resource: string; id: string; name?: string | null }, field: string, before: string | null, after: string | null, effect: Effect): Change => ({ ...ref, field, before, after, unit: "text", effect });
const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters");
const httpsUrl = z.string().url().max(2048).refine((u) => u.startsWith("https://"), "https URL");
const imageField = z.enum(["MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "PORTRAIT_MARKETING_IMAGE", "LOGO", "LANDSCAPE_LOGO"]);

interface Linked {
  asset_id: string;
  field_type: string;
  key: string;
}
interface GroupState {
  group: { id: string; name: string | null; status: string; campaign_id: string; final_urls: string[]; path1: string | null; path2: string | null };
  brand_guidelines: boolean;
  assets: Linked[];
}

async function pmaxCampaign(ads: GoogleAdsClient, campaignId: string) {
  const [c] = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type", "campaign.brand_guidelines_enabled").from("campaign").where(`campaign.id = ${lit.id(campaignId)}`).limit(1), { maxRows: 1 });
  if (!c) throw new ToolError("not_found", `No campaign ${campaignId} in this account.`);
  if (str(c, "campaign.advertising_channel_type") !== "PERFORMANCE_MAX") throw new ToolError("invalid_argument", `Campaign ${campaignId} is not a Performance Max campaign.`);
  if (str(c, "campaign.status") === "REMOVED") throw new ToolError("invalid_argument", "The campaign is removed and cannot be changed.");
  return { name: str(c, "campaign.name"), brand_guidelines: pick(c, "campaign.brand_guidelines_enabled") === true };
}

/** Identity of a linked asset: text for text assets, video id for videos, asset name (content hash) for images. */
const linkedKey = (r: Row) => {
  const t = str(r, "asset.type");
  if (t === "TEXT") return `text:${(str(r, "asset.text_asset.text") ?? "").toLowerCase()}`;
  if (t === "YOUTUBE_VIDEO") return `video:${str(r, "asset.youtube_video_asset.youtube_video_id")}`;
  return `asset:${str(r, "asset.name") ?? str(r, "asset.id")}`;
};

async function readGroup(ads: GoogleAdsClient, assetGroupId: string): Promise<GroupState> {
  const [g] = await ads.query(new Gaql().select("asset_group.id", "asset_group.name", "asset_group.status", "asset_group.final_urls", "asset_group.path1", "asset_group.path2", "campaign.id").from("asset_group").where(`asset_group.id = ${lit.id(assetGroupId)}`).limit(1), { maxRows: 1 });
  if (!g) throw new ToolError("not_found", `No asset group ${assetGroupId} in this account.`);
  const campaignId = String(pick(g, "campaign.id"));
  const camp = await pmaxCampaign(ads, campaignId);
  const rows = await ads.query(
    new Gaql().select("asset.id", "asset.type", "asset.name", "asset.text_asset.text", "asset.youtube_video_asset.youtube_video_id", "asset_group_asset.field_type").from("asset_group_asset").where(`asset_group.id = ${lit.id(assetGroupId)}`).where("asset_group_asset.status != 'REMOVED'"),
    { maxRows: 1000 },
  );
  return {
    group: { id: assetGroupId, name: str(g, "asset_group.name"), status: str(g, "asset_group.status") ?? "", campaign_id: campaignId, final_urls: (pick(g, "asset_group.final_urls") as string[] | undefined) ?? [], path1: str(g, "asset_group.path1"), path2: str(g, "asset_group.path2") },
    brand_guidelines: camp.brand_guidelines,
    assets: rows.map((r) => ({ asset_id: String(pick(r, "asset.id")), field_type: str(r, "asset_group_asset.field_type") ?? "", key: linkedKey(r) })).sort((x, y) => `${x.field_type}${x.asset_id}`.localeCompare(`${y.field_type}${y.asset_id}`)),
  };
}
const count = (s: GroupState, field: string) => s.assets.filter((x) => x.field_type === field).length;
const notRemoved = (s: GroupState) => {
  if (s.group.status === "REMOVED") throw new ToolError("invalid_argument", "The asset group is removed and cannot be changed.");
};
/**
 * Image assets are named after their content hash and their target, so an identical image is recognised when it is
 * added again to the same target, and names never collide across targets (in case Google requires unique asset names
 * [not stated in the docs checked]).
 */
const imageName = (field: string, sha: string, target: string) => `${field.toLowerCase()}-${sha.slice(0, 16)}-${target}`;

// ------------------------------------------------------------------------------------------- add_pmax_asset_group
export const addPmaxAssetGroup = stateWrite({
  name: "add_pmax_asset_group",
  title: "Create Performance Max asset group",
  risk: "write",
  description:
    "Creates a Performance Max asset group with its required assets in one atomic request, after approval from a second person (a new asset group can start serving): final URL, 3-15 headlines (30 chars), 1-5 long headlines (90), 2-5 descriptions (90), and https image URLs for at least one landscape (1.91:1) and one square (1:1) image. Business name and logo are also required unless the campaign has brand guidelines enabled (then they are campaign assets). Images are downloaded and checked against Google's specs; the exact bytes are pinned at approval. Created PAUSED unless status ENABLED is given. Confirmed by re-reading.",
  input: z.object({
    account_id: accountId,
    campaign_id: idSchema,
    name: text(255),
    final_url: httpsUrl,
    headlines: z.array(text(30)).min(3).max(15),
    long_headlines: z.array(text(90)).min(1).max(5),
    descriptions: z.array(text(90)).min(2).max(5),
    business_name: text(25).optional(),
    images: z.array(z.object({ url: httpsUrl, field_type: imageField })).min(2).max(40),
    youtube_video_ids: z.array(z.string().regex(/^[\w-]{11}$/, "an 11-character YouTube video id")).max(15).default([]),
    path1: text(15).optional(),
    path2: text(15).optional(),
    status: z.enum(["ENABLED", "PAUSED"]).default("PAUSED"),
  }),
  output: z.object({ asset_group_id: z.string(), campaign_id: z.string(), status: z.string(), assets: z.number() }),
  timeoutMs: 120_000,
  read: async (a, ads, svc) => {
    const camp = await pmaxCampaign(ads, a.campaign_id);
    const groups = await ads.query(new Gaql().select("asset_group.id", "asset_group.name").from("asset_group").where(`campaign.id = ${lit.id(a.campaign_id)}`).where("asset_group.status != 'REMOVED'"), { maxRows: 1000 });
    return withImages({ campaign: { id: a.campaign_id, name: camp.name }, brand_guidelines: camp.brand_guidelines, groups: groups.map((g) => ({ id: String(pick(g, "asset_group.id")), name: str(g, "asset_group.name") ?? "" })).sort((x, y) => x.id.localeCompare(y.id)) }, svc, a.images.map((i) => ({ url: i.url, field: i.field_type as ImageFieldType })));
  },
  build: (a, s, ads) => {
    if (s.groups.some((g) => g.name.toLowerCase() === a.name.toLowerCase())) throw new ToolError("invalid_argument", `The campaign already has an asset group named "${a.name}".`);
    const per = (f: string) => a.images.filter((i) => i.field_type === f).length;
    for (const f of ["MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE"]) if (per(f) < 1) throw new ToolError("invalid_argument", `At least one ${f} is required.`);
    if (!s.brand_guidelines) {
      if (!a.business_name) throw new ToolError("invalid_argument", "business_name is required (the campaign does not use brand guidelines).");
      if (per("LOGO") < 1) throw new ToolError("invalid_argument", "At least one LOGO image is required (the campaign does not use brand guidelines).");
    } else if (a.business_name || per("LOGO") || per("LANDSCAPE_LOGO")) throw new ToolError("invalid_argument", "This campaign uses brand guidelines: business name and logos are campaign assets (use add_pmax_campaign_logo), not asset group assets.");
    for (const [f, l] of Object.entries(LIMITS)) if (per(f) > l.max) throw new ToolError("invalid_argument", `At most ${l.max} ${f} per asset group.`);
    const group = temp(ads, "assetGroups", 1);
    let n = 2;
    const assetOps: Row[] = [];
    const linkOps: Row[] = [];
    const link = (asset: Row, fieldType: string) => {
      const t = temp(ads, "assets", n++);
      assetOps.push({ assetOperation: { create: { resourceName: t, ...asset } } });
      linkOps.push({ assetGroupAssetOperation: { create: { assetGroup: group, asset: t, fieldType } } });
    };
    for (const h of a.headlines) link({ textAsset: { text: h } }, "HEADLINE");
    for (const h of a.long_headlines) link({ textAsset: { text: h } }, "LONG_HEADLINE");
    for (const d of a.descriptions) link({ textAsset: { text: d } }, "DESCRIPTION");
    if (a.business_name) link({ textAsset: { text: a.business_name } }, "BUSINESS_NAME");
    for (const im of a.images) {
      const d = imageData(s, im.url);
      link({ name: imageName(im.field_type, s.image_sha256[im.url]!, `new-${Date.now().toString(36)}`), imageAsset: { data: d.data } }, im.field_type);
    }
    for (const v of a.youtube_video_ids) link({ youtubeVideoAsset: { youtubeVideoId: v } }, "YOUTUBE_VIDEO");
    const ops: Row[] = [
      ...assetOps,
      { assetGroupOperation: { create: { resourceName: group, campaign: rn(ads, "campaigns", a.campaign_id), name: a.name, finalUrls: [a.final_url], status: a.status, ...(a.path1 ? { path1: a.path1 } : {}), ...(a.path2 ? { path2: a.path2 } : {}) } } },
      ...linkOps,
    ];
    return {
      summary: `Create asset group "${a.name}" (${a.status}) in campaign "${s.campaign.name ?? a.campaign_id}" with ${linkOps.length} assets: ${a.headlines.length} headlines, ${a.long_headlines.length} long headlines, ${a.descriptions.length} descriptions, ${a.images.length} images${a.youtube_video_ids.length ? `, ${a.youtube_video_ids.length} videos` : ""}; final URL ${a.final_url}`,
      changes: [change({ resource: "campaign", id: a.campaign_id, name: s.campaign.name }, "asset_group", null, `${a.name} (${a.status})`, a.status === "ENABLED" ? "create" : "neutral"), change({ resource: "asset_group", id: "new", name: a.name }, "status", null, a.status, a.status === "ENABLED" ? "enable" : "pause")],
      ops,
    };
  },
  landed: (a, _b, after) => after.groups.some((g) => g.name.toLowerCase() === a.name.toLowerCase()),
  result: (a, after) => ({ asset_group_id: after.groups.find((g) => g.name.toLowerCase() === a.name.toLowerCase())!.id, campaign_id: a.campaign_id, status: a.status, assets: a.headlines.length + a.long_headlines.length + a.descriptions.length + (a.business_name ? 1 : 0) + a.images.length + a.youtube_video_ids.length }),
});

// ---------------------------------------------------------------------------------------- update / remove asset group
export const updatePmaxAssetGroup = stateWrite({
  name: "update_pmax_asset_group",
  title: "Update asset group",
  risk: "write",
  description: "Changes a Performance Max asset group's name, final URL, display paths or status (ENABLED or PAUSED), after approval. Enabling needs a second approver. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, asset_group_id: idSchema, name: text(255).optional(), final_url: httpsUrl.optional(), path1: text(15).optional(), path2: text(15).optional(), status: z.enum(["ENABLED", "PAUSED"]).optional() }).refine((v) => v.name || v.final_url || v.path1 || v.path2 || v.status, "give at least one setting"),
  output: z.object({ asset_group_id: z.string(), name: z.string().nullable(), status: z.string(), final_urls: z.array(z.string()), path1: z.string().nullable(), path2: z.string().nullable() }),
  read: (a, ads) => readGroup(ads, a.asset_group_id),
  build: (a, s, ads) => {
    notRemoved(s);
    const g = s.group;
    const update: Row = { resourceName: rn(ads, "assetGroups", a.asset_group_id) };
    const mask: string[] = [];
    const changes: Change[] = [];
    const ref = { resource: "asset_group", id: a.asset_group_id, name: g.name };
    if (a.name && a.name !== g.name) (update.name = a.name), mask.push("name"), changes.push(change(ref, "name", g.name, a.name, "neutral"));
    if (a.final_url && !(g.final_urls.length === 1 && g.final_urls[0] === a.final_url)) (update.finalUrls = [a.final_url]), mask.push("final_urls"), changes.push(change(ref, "final_url", g.final_urls[0] ?? null, a.final_url, "neutral"));
    if (a.path1 && a.path1 !== g.path1) (update.path1 = a.path1), mask.push("path1"), changes.push(change(ref, "path1", g.path1, a.path1, "neutral"));
    if (a.path2 && a.path2 !== g.path2) (update.path2 = a.path2), mask.push("path2"), changes.push(change(ref, "path2", g.path2, a.path2, "neutral"));
    if (a.status && a.status !== g.status) (update.status = a.status), mask.push("status"), changes.push(change(ref, "status", g.status, a.status, a.status === "ENABLED" ? "enable" : "pause"));
    if (!mask.length) throw new ToolError("invalid_argument", "Nothing would change.");
    return { summary: `Asset group "${g.name ?? a.asset_group_id}": ${changes.map((c) => `${c.field} ${c.before ?? "none"} -> ${c.after}`).join("; ")}`, changes, ops: [{ assetGroupOperation: { update, updateMask: mask.join(",") } }] };
  },
  landed: (a, _b, x) => (!a.name || x.group.name === a.name) && (!a.final_url || x.group.final_urls[0] === a.final_url) && (!a.path1 || x.group.path1 === a.path1) && (!a.path2 || x.group.path2 === a.path2) && (!a.status || x.group.status === a.status),
  result: (a, x) => ({ asset_group_id: a.asset_group_id, name: x.group.name, status: x.group.status, final_urls: x.group.final_urls, path1: x.group.path1, path2: x.group.path2 }),
});

export const removePmaxAssetGroup = stateWrite({
  name: "remove_pmax_asset_group",
  title: "Remove asset group",
  risk: "destructive",
  description: "Permanently removes a Performance Max asset group (its asset links and signals go with it; the assets stay in the library), after approval from a second person. Removal cannot be undone; pause it with update_pmax_asset_group to keep its history. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, asset_group_id: idSchema }),
  output: z.object({ asset_group_id: z.string(), status: z.literal("REMOVED") }),
  read: async (a, ads) => {
    const [g] = await ads.query(new Gaql().select("asset_group.id", "asset_group.name", "asset_group.status", "campaign.advertising_channel_type").from("asset_group").where(`asset_group.id = ${lit.id(a.asset_group_id)}`).limit(1), { maxRows: 1 });
    if (!g) throw new ToolError("not_found", `No asset group ${a.asset_group_id} in this account.`);
    return { name: str(g, "asset_group.name"), status: str(g, "asset_group.status") ?? "" };
  },
  build: (a, s, ads) => {
    if (s.status === "REMOVED") throw new ToolError("invalid_argument", "Nothing would change: the asset group is already removed.");
    return { summary: `Permanently remove asset group "${s.name ?? a.asset_group_id}" (currently ${s.status}). This cannot be undone.`, changes: [change({ resource: "asset_group", id: a.asset_group_id, name: s.name }, "status", s.status, "REMOVED", "remove")], ops: [{ assetGroupOperation: { remove: rn(ads, "assetGroups", a.asset_group_id) } }] };
  },
  landed: (_a, _b, after) => after.status === "REMOVED",
  result: (a) => ({ asset_group_id: a.asset_group_id, status: "REMOVED" as const }),
});

// -------------------------------------------------------------------------------------- asset group assets (text/video)
const textField = z.enum(["HEADLINE", "LONG_HEADLINE", "DESCRIPTION", "BUSINESS_NAME", "YOUTUBE_VIDEO"]);
const assetItem = z.object({ field_type: textField, text: z.string().trim().min(1).max(90).optional(), youtube_video_id: z.string().regex(/^[\w-]{11}$/).optional() }).refine((i) => (i.field_type === "YOUTUBE_VIDEO") === !!i.youtube_video_id && (i.field_type === "YOUTUBE_VIDEO") !== !!i.text, "text for text fields, youtube_video_id for YOUTUBE_VIDEO");
const itemKey = (i: z.infer<typeof assetItem>) => (i.field_type === "YOUTUBE_VIDEO" ? `video:${i.youtube_video_id}` : `text:${i.text!.toLowerCase()}`);

export const addPmaxAssetGroupAsset = stateWrite({
  name: "add_pmax_asset_group_asset",
  title: "Add asset group text or video assets",
  risk: "write",
  description: "Adds headlines (30 chars), long headlines (90), descriptions (90), a business name (25) or YouTube videos (video id) to a Performance Max asset group, after approval. Google's per-group maximums are enforced and duplicates are skipped. Applied atomically and confirmed by re-reading.",
  input: z.object({ account_id: accountId, asset_group_id: idSchema, assets: z.array(assetItem).min(1).max(30) }),
  output: z.object({ asset_group_id: z.string(), added: z.array(z.string()), skipped_existing: z.array(z.string()) }),
  read: (a, ads) => readGroup(ads, a.asset_group_id),
  build: (a, s, ads) => {
    notRemoved(s);
    const have = new Set(s.assets.map((x) => `${x.field_type}|${x.key}`));
    const fresh = [...new Map(a.assets.map((i) => [`${i.field_type}|${itemKey(i)}`, i])).values()].filter((i) => !have.has(`${i.field_type}|${itemKey(i)}`));
    if (!fresh.length) throw new ToolError("invalid_argument", "Nothing would change: every asset is already in the asset group.");
    for (const i of fresh) {
      const l = LIMITS[i.field_type]!;
      if (l.chars && i.text!.length > l.chars) throw new ToolError("invalid_argument", `${i.field_type} "${i.text}" is longer than ${l.chars} characters.`);
      if (s.brand_guidelines && BRAND_FIELDS.has(i.field_type)) throw new ToolError("invalid_argument", `This campaign uses brand guidelines: ${i.field_type} is a campaign asset, not an asset group asset.`);
    }
    for (const f of new Set(fresh.map((i) => i.field_type))) {
      const total = count(s, f) + fresh.filter((i) => i.field_type === f).length;
      if (total > LIMITS[f]!.max) throw new ToolError("invalid_argument", `This would make ${total} ${f} assets; the maximum is ${LIMITS[f]!.max}.`);
    }
    const ops: Row[] = [];
    fresh.forEach((i, k) => {
      const t = temp(ads, "assets", k + 1);
      ops.push({ assetOperation: { create: { resourceName: t, ...(i.field_type === "YOUTUBE_VIDEO" ? { youtubeVideoAsset: { youtubeVideoId: i.youtube_video_id } } : { textAsset: { text: i.text } }) } } });
      ops.push({ assetGroupAssetOperation: { create: { assetGroup: rn(ads, "assetGroups", a.asset_group_id), asset: t, fieldType: i.field_type } } });
    });
    return { summary: `Asset group "${s.group.name ?? a.asset_group_id}": add ${fresh.map((i) => `${i.field_type} ${i.text ?? i.youtube_video_id}`).join("; ")}`, changes: fresh.map((i) => change({ resource: "asset_group", id: a.asset_group_id, name: s.group.name }, i.field_type.toLowerCase(), null, i.text ?? i.youtube_video_id!, "neutral")), ops };
  },
  landed: (a, _b, after) => a.assets.every((i) => after.assets.some((x) => x.field_type === i.field_type && x.key === itemKey(i))),
  result: (a, _x, _r, before) => {
    const had = new Set(before.assets.map((x) => `${x.field_type}|${x.key}`));
    return { asset_group_id: a.asset_group_id, added: a.assets.filter((i) => !had.has(`${i.field_type}|${itemKey(i)}`)).map(itemKey), skipped_existing: a.assets.filter((i) => had.has(`${i.field_type}|${itemKey(i)}`)).map(itemKey) };
  },
});

function removeGroupAssetsTool(name: "remove_pmax_asset_group_asset" | "remove_pmax_asset_group_image", images: boolean) {
  return stateWrite({
    name,
    title: images ? "Remove asset group images" : "Remove asset group assets",
    risk: "destructive",
    description: `Unlinks ${images ? "images and logos" : "text and video assets"} from a Performance Max asset group (the assets stay in the library), after approval from a second person. Refused when it would drop below Google's minimum for that asset type. Give asset ids and field types from list_pmax_asset_group_${images ? "images" : "assets"}. Confirmed by re-reading.`,
    input: z.object({ account_id: accountId, asset_group_id: idSchema, assets: z.array(z.object({ asset_id: idSchema, field_type: images ? imageField : textField })).min(1).max(50) }),
    output: z.object({ asset_group_id: z.string(), removed: z.array(z.string()) }),
    read: (a, ads) => readGroup(ads, a.asset_group_id),
    build: (a, s, ads) => {
      notRemoved(s);
      const list = [...new Map(a.assets.map((x) => [`${x.asset_id}~${x.field_type}`, x])).values()];
      const missing = list.filter((x) => !s.assets.some((y) => y.asset_id === x.asset_id && y.field_type === x.field_type));
      if (missing.length) throw new ToolError("invalid_argument", `Not linked to this asset group: ${missing.map((x) => `${x.asset_id} as ${x.field_type}`).join(", ")}`);
      for (const f of new Set(list.map((x) => x.field_type))) {
        const left = count(s, f) - list.filter((x) => x.field_type === f).length;
        const min = BRAND_FIELDS.has(f) && s.brand_guidelines ? 0 : LIMITS[f]!.min;
        if (left < min) throw new ToolError("invalid_argument", `This would leave ${left} ${f} assets; Google requires at least ${min}. Add a replacement first.`);
      }
      return {
        summary: `Asset group "${s.group.name ?? a.asset_group_id}": unlink ${list.map((x) => `${x.field_type} ${x.asset_id}`).join(", ")}`,
        changes: list.map((x) => change({ resource: "asset_group", id: a.asset_group_id, name: s.group.name }, x.field_type.toLowerCase(), x.asset_id, null, "remove")),
        ops: list.map((x) => ({ assetGroupAssetOperation: { remove: `customers/${ads.customerId}/assetGroupAssets/${a.asset_group_id}~${x.asset_id}~${x.field_type}` } })),
      };
    },
    landed: (a, _b, after) => a.assets.every((x) => !after.assets.some((y) => y.asset_id === x.asset_id && y.field_type === x.field_type)),
    result: (a) => ({ asset_group_id: a.asset_group_id, removed: [...new Set(a.assets.map((x) => `${x.asset_id}~${x.field_type}`))].sort() }),
  });
}
export const removePmaxAssetGroupAsset = removeGroupAssetsTool("remove_pmax_asset_group_asset", false);
export const removePmaxAssetGroupImage = removeGroupAssetsTool("remove_pmax_asset_group_image", true);

// --------------------------------------------------------------------------------------------- asset group images
export const addPmaxAssetGroupImage = stateWrite({
  name: "add_pmax_asset_group_image",
  title: "Add asset group images",
  risk: "write",
  description: "Uploads images from https URLs and adds them to a Performance Max asset group as landscape (1.91:1), square (1:1) or portrait (4:5) marketing images, or (without brand guidelines) logos (1:1) and landscape logos (4:1), after approval. Each image is downloaded and checked against Google's specs (PNG, JPEG or GIF, at most 5120 KB, minimum sizes); the exact bytes are pinned at approval. Identical images are skipped. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, asset_group_id: idSchema, images: z.array(z.object({ url: httpsUrl, field_type: imageField })).min(1).max(20) }),
  output: z.object({ asset_group_id: z.string(), added: z.array(z.object({ url: z.string(), field_type: z.string(), asset_id: z.string().nullable() })) }),
  timeoutMs: 120_000,
  read: async (a, ads, svc) => withImages(await readGroup(ads, a.asset_group_id), svc, a.images.map((i) => ({ url: i.url, field: i.field_type as ImageFieldType }))),
  build: (a, s, ads) => {
    notRemoved(s);
    const fresh = a.images.filter((i) => !s.assets.some((x) => x.field_type === i.field_type && x.key === `asset:${imageName(i.field_type, s.image_sha256[i.url]!, `ag${a.asset_group_id}`)}`));
    if (!fresh.length) throw new ToolError("invalid_argument", "Nothing would change: these images are already in the asset group.");
    for (const i of fresh) if (s.brand_guidelines && BRAND_FIELDS.has(i.field_type)) throw new ToolError("invalid_argument", `This campaign uses brand guidelines: ${i.field_type} is a campaign asset (use add_pmax_campaign_logo).`);
    for (const f of new Set(fresh.map((i) => i.field_type))) {
      const total = count(s, f) + fresh.filter((i) => i.field_type === f).length;
      if (total > LIMITS[f]!.max) throw new ToolError("invalid_argument", `This would make ${total} ${f} images; the maximum is ${LIMITS[f]!.max}.`);
    }
    const ops: Row[] = [];
    fresh.forEach((i, k) => {
      const t = temp(ads, "assets", k + 1);
      ops.push({ assetOperation: { create: { resourceName: t, name: imageName(i.field_type, s.image_sha256[i.url]!, `ag${a.asset_group_id}`), imageAsset: { data: imageData(s, i.url).data } } } });
      ops.push({ assetGroupAssetOperation: { create: { assetGroup: rn(ads, "assetGroups", a.asset_group_id), asset: t, fieldType: i.field_type } } });
    });
    return { summary: `Asset group "${s.group.name ?? a.asset_group_id}": add ${fresh.map((i) => `${i.field_type} from ${i.url} (sha256 ${s.image_sha256[i.url]!.slice(0, 12)})`).join("; ")}`, changes: fresh.map((i) => change({ resource: "asset_group", id: a.asset_group_id, name: s.group.name }, i.field_type.toLowerCase(), null, `${i.url} sha256:${s.image_sha256[i.url]!.slice(0, 12)}`, "neutral")), ops };
  },
  landed: (a, _b, after) => a.images.every((i) => after.assets.some((x) => x.field_type === i.field_type && x.key === `asset:${imageName(i.field_type, after.image_sha256[i.url]!, `ag${a.asset_group_id}`)}`)),
  result: (a, after) => ({ asset_group_id: a.asset_group_id, added: a.images.map((i) => ({ url: i.url, field_type: i.field_type, asset_id: after.assets.find((x) => x.field_type === i.field_type && x.key === `asset:${imageName(i.field_type, after.image_sha256[i.url]!, `ag${a.asset_group_id}`)}`)?.asset_id ?? null })) }),
});

// ------------------------------------------------------------------------------------- campaign-level images (logos, Search)
async function readCampaignImages(ads: GoogleAdsClient, campaignId: string, fields: string[]) {
  const rows = await ads.query(new Gaql().select("asset.id", "asset.name", "asset.type", "campaign_asset.field_type").from("campaign_asset").where(`campaign_asset.campaign = ${lit.str(rn(ads, "campaigns", campaignId))}`).where(`campaign_asset.field_type IN ${lit.list(fields.map((f) => `'${f}'`))}`).where("campaign_asset.status != 'REMOVED'"), { maxRows: 500 });
  return rows.map((r) => ({ asset_id: String(pick(r, "asset.id")), field_type: str(r, "campaign_asset.field_type") ?? "", key: linkedKey(r) })).sort((x, y) => `${x.field_type}${x.asset_id}`.localeCompare(`${y.field_type}${y.asset_id}`));
}
export const addPmaxCampaignLogo = stateWrite({
  name: "add_pmax_campaign_logo",
  title: "Add Performance Max campaign logo",
  risk: "write",
  description: "Uploads a logo (square 1:1, at least 128x128) or landscape logo (4:1, at least 512x128) from an https URL and links it to a Performance Max campaign that uses brand guidelines, after approval. Without brand guidelines, logos belong in asset groups (add_pmax_asset_group_image). Checked against Google's specs; the exact bytes are pinned at approval. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, campaign_id: idSchema, url: httpsUrl, field_type: z.enum(["LOGO", "LANDSCAPE_LOGO"]) }),
  output: z.object({ campaign_id: z.string(), field_type: z.string(), asset_id: z.string().nullable() }),
  timeoutMs: 120_000,
  read: async (a, ads, svc) => {
    const camp = await pmaxCampaign(ads, a.campaign_id);
    if (!camp.brand_guidelines) throw new ToolError("invalid_argument", "This campaign does not use brand guidelines: add logos to its asset groups with add_pmax_asset_group_image.");
    return withImages({ campaign: { id: a.campaign_id, name: camp.name }, assets: await readCampaignImages(ads, a.campaign_id, ["LOGO", "LANDSCAPE_LOGO"]) }, svc, [{ url: a.url, field: a.field_type }]);
  },
  build: (a, s, ads) => {
    const name = imageName(a.field_type, s.image_sha256[a.url]!, `c${a.campaign_id}`);
    if (s.assets.some((x) => x.field_type === a.field_type && x.key === `asset:${name}`)) throw new ToolError("invalid_argument", "Nothing would change: this logo is already linked.");
    if (s.assets.filter((x) => x.field_type === a.field_type).length + 1 > LIMITS[a.field_type]!.max) throw new ToolError("invalid_argument", `At most ${LIMITS[a.field_type]!.max} ${a.field_type} assets.`);
    const t = temp(ads, "assets", 1);
    return {
      summary: `Campaign "${s.campaign.name ?? a.campaign_id}": add ${a.field_type} from ${a.url} (sha256 ${s.image_sha256[a.url]!.slice(0, 12)})`,
      changes: [change({ resource: "campaign", id: a.campaign_id, name: s.campaign.name }, a.field_type.toLowerCase(), null, a.url, "neutral")],
      ops: [{ assetOperation: { create: { resourceName: t, name, imageAsset: { data: imageData(s, a.url).data } } } }, { campaignAssetOperation: { create: { campaign: rn(ads, "campaigns", a.campaign_id), asset: t, fieldType: a.field_type } } }],
    };
  },
  landed: (a, _b, after) => after.assets.some((x) => x.field_type === a.field_type && x.key === `asset:${imageName(a.field_type, after.image_sha256[a.url]!, `c${a.campaign_id}`)}`),
  result: (a, after) => ({ campaign_id: a.campaign_id, field_type: a.field_type, asset_id: after.assets.find((x) => x.field_type === a.field_type && x.key === `asset:${imageName(a.field_type, after.image_sha256[a.url]!, `c${a.campaign_id}`)}`)?.asset_id ?? null }),
});

export const addSearchCampaignImage = stateWrite({
  name: "add_search_campaign_image",
  title: "Add image to a Search campaign",
  risk: "write",
  description: "Uploads an image from an https URL and adds it to a Search campaign as an image extension (AD_IMAGE), after approval. The image must be square (1:1, at least 300x300) or landscape (1.91:1, at least 600x314), PNG, JPEG or GIF, at most 5120 KB; the exact bytes are pinned at approval. Image extensions need an eligible account (Google Ads policy). Confirmed by re-reading.",
  input: z.object({ account_id: accountId, campaign_id: idSchema, url: httpsUrl, shape: z.enum(["square", "landscape"]) }),
  output: z.object({ campaign_id: z.string(), asset_id: z.string().nullable() }),
  timeoutMs: 120_000,
  read: async (a, ads, svc) => {
    const [c] = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status", "campaign.advertising_channel_type").from("campaign").where(`campaign.id = ${lit.id(a.campaign_id)}`).limit(1), { maxRows: 1 });
    if (!c) throw new ToolError("not_found", `No campaign ${a.campaign_id} in this account.`);
    if (str(c, "campaign.advertising_channel_type") !== "SEARCH") throw new ToolError("invalid_argument", `Campaign ${a.campaign_id} is not a Search campaign.`);
    return withImages({ campaign: { id: a.campaign_id, name: str(c, "campaign.name") }, assets: await readCampaignImages(ads, a.campaign_id, ["AD_IMAGE"]) }, svc, [{ url: a.url, field: a.shape === "square" ? "SQUARE_MARKETING_IMAGE" : "MARKETING_IMAGE" }]);
  },
  build: (a, s, ads) => {
    const name = imageName("AD_IMAGE", s.image_sha256[a.url]!, `c${a.campaign_id}`);
    if (s.assets.some((x) => x.key === `asset:${name}`)) throw new ToolError("invalid_argument", "Nothing would change: this image is already on the campaign.");
    const t = temp(ads, "assets", 1);
    return {
      summary: `Search campaign "${s.campaign.name ?? a.campaign_id}": add ${a.shape} image from ${a.url} (sha256 ${s.image_sha256[a.url]!.slice(0, 12)})`,
      changes: [change({ resource: "campaign", id: a.campaign_id, name: s.campaign.name }, "ad_image", null, a.url, "neutral")],
      ops: [{ assetOperation: { create: { resourceName: t, name, imageAsset: { data: imageData(s, a.url).data } } } }, { campaignAssetOperation: { create: { campaign: rn(ads, "campaigns", a.campaign_id), asset: t, fieldType: "AD_IMAGE" } } }],
    };
  },
  landed: (a, _b, after) => after.assets.some((x) => x.key === `asset:${imageName("AD_IMAGE", after.image_sha256[a.url]!, `c${a.campaign_id}`)}`),
  result: (a, after) => ({ campaign_id: a.campaign_id, asset_id: after.assets.find((x) => x.key === `asset:${imageName("AD_IMAGE", after.image_sha256[a.url]!, `c${a.campaign_id}`)}`)?.asset_id ?? null }),
});

// ----------------------------------------------------------------------------------------- signals: audiences, themes
interface Signals {
  group: { id: string; name: string | null };
  audiences: { resource: string; audience_id: string }[];
  themes: { resource: string; text: string }[];
}
async function readSignals(ads: GoogleAdsClient, assetGroupId: string): Promise<Signals> {
  const g = await readGroup(ads, assetGroupId);
  notRemoved(g);
  const rows = await ads.query(new Gaql().select("asset_group_signal.resource_name", "asset_group_signal.audience.audience", "asset_group_signal.search_theme.text").from("asset_group_signal").where(`asset_group.id = ${lit.id(assetGroupId)}`), { maxRows: 1000 });
  const audiences = rows.filter((r) => pick(r, "asset_group_signal.audience.audience")).map((r) => ({ resource: String(pick(r, "asset_group_signal.resource_name")), audience_id: tailId(pick(r, "asset_group_signal.audience.audience")) ?? "" })).sort((x, y) => x.audience_id.localeCompare(y.audience_id));
  const themes = rows.filter((r) => pick(r, "asset_group_signal.search_theme.text")).map((r) => ({ resource: String(pick(r, "asset_group_signal.resource_name")), text: String(pick(r, "asset_group_signal.search_theme.text")) })).sort((x, y) => x.text.localeCompare(y.text));
  return { group: { id: assetGroupId, name: g.group.name }, audiences, themes };
}
const signalCreate = (ads: GoogleAdsClient, assetGroupId: string, body: Row) => ({ assetGroupSignalOperation: { create: { assetGroup: rn(ads, "assetGroups", assetGroupId), ...body } } });

export const addPmaxAudienceSignal = stateWrite({
  name: "add_pmax_audience_signal",
  title: "Add audience signal",
  risk: "write",
  description: "Adds an audience signal (an audience id, created in Google Ads' audience manager) to a Performance Max asset group, after approval. Signals guide Google's targeting but do not restrict it. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, asset_group_id: idSchema, audience_id: idSchema }),
  output: z.object({ asset_group_id: z.string(), audience_ids: z.array(z.string()) }),
  read: (a, ads) => readSignals(ads, a.asset_group_id),
  build: (a, s, ads) => {
    if (s.audiences.some((x) => x.audience_id === a.audience_id)) throw new ToolError("invalid_argument", "Nothing would change: this audience is already a signal.");
    return { summary: `Asset group "${s.group.name ?? a.asset_group_id}": add audience signal ${a.audience_id}`, changes: [change({ resource: "asset_group", id: a.asset_group_id, name: s.group.name }, "audience_signal", null, a.audience_id, "neutral")], ops: [signalCreate(ads, a.asset_group_id, { audience: { audience: rn(ads, "audiences", a.audience_id) } })] };
  },
  landed: (a, _b, after) => after.audiences.some((x) => x.audience_id === a.audience_id),
  result: (a, after) => ({ asset_group_id: a.asset_group_id, audience_ids: after.audiences.map((x) => x.audience_id) }),
});
export const updatePmaxAudienceSignal = stateWrite({
  name: "update_pmax_audience_signal",
  title: "Replace audience signal",
  risk: "write",
  description: "Replaces one audience signal on a Performance Max asset group with another audience, in one atomic request, after approval (signals cannot be edited in place). Confirmed by re-reading.",
  input: z.object({ account_id: accountId, asset_group_id: idSchema, from_audience_id: idSchema, to_audience_id: idSchema }).refine((v) => v.from_audience_id !== v.to_audience_id, "from and to must differ"),
  output: z.object({ asset_group_id: z.string(), audience_ids: z.array(z.string()) }),
  read: (a, ads) => readSignals(ads, a.asset_group_id),
  build: (a, s, ads) => {
    const cur = s.audiences.find((x) => x.audience_id === a.from_audience_id);
    if (!cur) throw new ToolError("invalid_argument", `Audience ${a.from_audience_id} is not a signal on this asset group.`);
    if (s.audiences.some((x) => x.audience_id === a.to_audience_id)) throw new ToolError("invalid_argument", `Audience ${a.to_audience_id} is already a signal.`);
    return { summary: `Asset group "${s.group.name ?? a.asset_group_id}": audience signal ${a.from_audience_id} -> ${a.to_audience_id}`, changes: [change({ resource: "asset_group", id: a.asset_group_id, name: s.group.name }, "audience_signal", a.from_audience_id, a.to_audience_id, "neutral")], ops: [{ assetGroupSignalOperation: { remove: cur.resource } }, signalCreate(ads, a.asset_group_id, { audience: { audience: rn(ads, "audiences", a.to_audience_id) } })] };
  },
  landed: (a, _b, after) => after.audiences.some((x) => x.audience_id === a.to_audience_id) && !after.audiences.some((x) => x.audience_id === a.from_audience_id),
  result: (a, after) => ({ asset_group_id: a.asset_group_id, audience_ids: after.audiences.map((x) => x.audience_id) }),
});
export const removePmaxAudienceSignal = stateWrite({
  name: "remove_pmax_audience_signal",
  title: "Remove audience signal",
  risk: "destructive",
  description: "Removes an audience signal from a Performance Max asset group, after approval from a second person. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, asset_group_id: idSchema, audience_id: idSchema }),
  output: z.object({ asset_group_id: z.string(), audience_ids: z.array(z.string()) }),
  read: (a, ads) => readSignals(ads, a.asset_group_id),
  build: (a, s) => {
    const cur = s.audiences.find((x) => x.audience_id === a.audience_id);
    if (!cur) throw new ToolError("invalid_argument", `Audience ${a.audience_id} is not a signal on this asset group.`);
    return { summary: `Asset group "${s.group.name ?? a.asset_group_id}": remove audience signal ${a.audience_id}`, changes: [change({ resource: "asset_group", id: a.asset_group_id, name: s.group.name }, "audience_signal", a.audience_id, null, "remove")], ops: [{ assetGroupSignalOperation: { remove: cur.resource } }] };
  },
  landed: (a, _b, after) => !after.audiences.some((x) => x.audience_id === a.audience_id),
  result: (a, after) => ({ asset_group_id: a.asset_group_id, audience_ids: after.audiences.map((x) => x.audience_id) }),
});

const theme = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f]+$/);
export const addPmaxSearchThemes = stateWrite({
  name: "add_pmax_search_themes",
  title: "Add search themes",
  risk: "write",
  description: "Adds search themes (words or phrases people search for, max 80 characters each) to a Performance Max asset group as signals, after approval. Existing themes are skipped (case-insensitive). Confirmed by re-reading.",
  input: z.object({ account_id: accountId, asset_group_id: idSchema, themes: z.array(theme).min(1).max(50) }),
  output: z.object({ asset_group_id: z.string(), themes: z.array(z.string()), skipped_existing: z.array(z.string()) }),
  read: (a, ads) => readSignals(ads, a.asset_group_id),
  build: (a, s, ads) => {
    const have = new Set(s.themes.map((t) => t.text.toLowerCase()));
    const fresh = [...new Map(a.themes.map((t) => [t.toLowerCase(), t])).values()].filter((t) => !have.has(t.toLowerCase()));
    if (!fresh.length) throw new ToolError("invalid_argument", "Nothing would change: every theme is already there.");
    return { summary: `Asset group "${s.group.name ?? a.asset_group_id}": add search themes ${fresh.join(", ")}`, changes: fresh.map((t) => change({ resource: "asset_group", id: a.asset_group_id, name: s.group.name }, "search_theme", null, t, "neutral")), ops: fresh.map((t) => signalCreate(ads, a.asset_group_id, { searchTheme: { text: t } })) };
  },
  landed: (a, _b, after) => a.themes.every((t) => after.themes.some((x) => x.text.toLowerCase() === t.toLowerCase())),
  result: (a, after, _r, before) => ({ asset_group_id: a.asset_group_id, themes: after.themes.map((t) => t.text), skipped_existing: a.themes.filter((t) => before.themes.some((x) => x.text.toLowerCase() === t.toLowerCase())) }),
});
export const removePmaxSearchThemes = stateWrite({
  name: "remove_pmax_search_themes",
  title: "Remove search themes",
  risk: "destructive",
  description: "Removes search themes from a Performance Max asset group, after approval from a second person. Matching is case-insensitive. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, asset_group_id: idSchema, themes: z.array(theme).min(1).max(50) }),
  output: z.object({ asset_group_id: z.string(), themes: z.array(z.string()) }),
  read: (a, ads) => readSignals(ads, a.asset_group_id),
  build: (a, s) => {
    const want = [...new Set(a.themes.map((t) => t.toLowerCase()))];
    const missing = want.filter((t) => !s.themes.some((x) => x.text.toLowerCase() === t));
    if (missing.length) throw new ToolError("invalid_argument", `Not a search theme here: ${missing.join(", ")}`);
    const hit = s.themes.filter((x) => want.includes(x.text.toLowerCase()));
    return { summary: `Asset group "${s.group.name ?? a.asset_group_id}": remove search themes ${hit.map((x) => x.text).join(", ")}`, changes: hit.map((x) => change({ resource: "asset_group", id: a.asset_group_id, name: s.group.name }, "search_theme", x.text, null, "remove")), ops: hit.map((x) => ({ assetGroupSignalOperation: { remove: x.resource } })) };
  },
  landed: (a, _b, after) => a.themes.every((t) => !after.themes.some((x) => x.text.toLowerCase() === t.toLowerCase())),
  result: (a, after) => ({ asset_group_id: a.asset_group_id, themes: after.themes.map((t) => t.text) }),
});

export const pmaxWriteTools = [addPmaxAssetGroup, updatePmaxAssetGroup, removePmaxAssetGroup, addPmaxAssetGroupAsset, removePmaxAssetGroupAsset, addPmaxAssetGroupImage, removePmaxAssetGroupImage, addPmaxCampaignLogo, addSearchCampaignImage, addPmaxAudienceSignal, updatePmaxAudienceSignal, removePmaxAudienceSignal, addPmaxSearchThemes, removePmaxSearchThemes];
