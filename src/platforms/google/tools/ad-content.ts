import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { GoogleAdsClient } from "../client";
import { canonicalJson } from "../../../security/canonical";
import { Gaql, lit, pick } from "../gaql";
import { accountId, googleWrite, idSchema as id, requireParent, str } from "./common";

// Checked against the Google Ads API docs on 2026-11-02:
//  - A responsive search ad has 3-15 headlines and 2-4 descriptions; headlines may be pinned only to HEADLINE_1..3 and
//    descriptions only to DESCRIPTION_1..2; path2 can only be set when path1 is set; every position must be fillable.
//  - AdService.MutateAds updates ads by resource name customers/{c}/ads/{ad_id} with an update_mask and does not support
//    TextAd, ExpandedDynamicSearchAd, GmailAd or ImageAd. New ads are created through AdGroupAdService (create).
//  - Automatically created assets cannot be removed through MutateAds.
// NOT confirmed by any page that was reachable: the character limits of headlines, descriptions and paths. They are therefore
// not hard-coded. plan() asks Google to validate the exact request with validate_only (which changes nothing), so Google's own
// limits and policy checks surface when the change is requested, before anyone is asked to approve it.

const clean = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters");
// 300 is an abuse bound, not Google's limit.
const headline = z.object({ text: clean(300), pinned_field: z.enum(["HEADLINE_1", "HEADLINE_2", "HEADLINE_3"]).optional() });
const description = z.object({ text: clean(300), pinned_field: z.enum(["DESCRIPTION_1", "DESCRIPTION_2"]).optional() });
const headlines = z.array(headline).min(3).max(15);
const descriptions = z.array(description).min(2).max(4);
const finalUrls = z.array(z.string().url().refine((u) => /^https?:\/\//i.test(u), "must be http(s)")).min(1).max(3);
const path = clean(30);

const assetOut = z.object({ text: z.string(), pinned_field: z.string().nullable() });
const contentOut = z.object({ ad_group_id: z.string(), ad_id: z.string(), headlines: z.array(assetOut), descriptions: z.array(assetOut), final_urls: z.array(z.string()), path1: z.string().nullable(), path2: z.string().nullable() });

interface Asset { text: string; pinned_field?: string | null }
interface Rsa { adGroupId: string; adId: string; status: string; type: string; adResource: string; finalUrls: string[]; headlines: Asset[]; descriptions: Asset[]; path1: string | null; path2: string | null }
interface Patch { headlines?: Asset[]; descriptions?: Asset[]; final_urls?: string[]; path1?: string | null; path2?: string | null }

/** URL as Google may store it: scheme and host lower-cased, a bare host given a trailing "/". Unparsable values are kept as-is. */
const normUrl = (u: string) => {
  try {
    return new URL(u.trim()).href;
  } catch {
    return u.trim();
  }
};
const sameUrls = (a: string[], b: string[]) => JSON.stringify(a.map(normUrl)) === JSON.stringify(b.map(normUrl));

const canon = (xs: Asset[]) => xs.map((x) => `${x.pinned_field ?? ""}|${x.text.trim()}`).sort();
const sameAssets = (a: Asset[], b: Asset[]) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const assets = (v: unknown): Asset[] => ((v as { text?: string; pinnedField?: string }[] | undefined) ?? []).filter((x) => typeof x.text === "string").map((x) => ({ text: String(x.text), pinned_field: x.pinnedField && !/^UNSPECIFIED$/.test(x.pinnedField) ? String(x.pinnedField) : null }));
const toApi = (xs: Asset[]) => xs.map((x) => ({ text: x.text.trim(), ...(x.pinned_field ? { pinnedField: x.pinned_field } : {}) }));

const RSA_FIELDS = ["ad_group.id", "ad_group_ad.ad.id", "ad_group_ad.status", "ad_group_ad.ad.type", "ad_group_ad.ad.resource_name", "ad_group_ad.ad.final_urls", "ad_group_ad.ad.responsive_search_ad.headlines", "ad_group_ad.ad.responsive_search_ad.descriptions", "ad_group_ad.ad.responsive_search_ad.path1", "ad_group_ad.ad.responsive_search_ad.path2"] as const;
const toRsa = (r: Record<string, unknown>, customerId: string): Rsa => ({
  adGroupId: String(pick(r, "ad_group.id") ?? ""),
  adId: String(pick(r, "ad_group_ad.ad.id") ?? ""),
  status: str(r, "ad_group_ad.status") ?? "",
  type: str(r, "ad_group_ad.ad.type") ?? "",
  adResource: str(r, "ad_group_ad.ad.resource_name") ?? `customers/${customerId}/ads/${pick(r, "ad_group_ad.ad.id")}`,
  finalUrls: ((pick(r, "ad_group_ad.ad.final_urls") as string[] | undefined) ?? []).map(String),
  headlines: assets(pick(r, "ad_group_ad.ad.responsive_search_ad.headlines")),
  descriptions: assets(pick(r, "ad_group_ad.ad.responsive_search_ad.descriptions")),
  path1: str(r, "ad_group_ad.ad.responsive_search_ad.path1"),
  path2: str(r, "ad_group_ad.ad.responsive_search_ad.path2"),
});

async function readRsa(ads: GoogleAdsClient, adGroupId: string, adId: string): Promise<Rsa> {
  const q = new Gaql().select(...RSA_FIELDS).from("ad_group_ad").where(`ad_group.id = ${lit.id(adGroupId)}`).where(`ad_group_ad.ad.id = ${lit.id(adId)}`).limit(1);
  const [r] = await ads.query(q, { maxRows: 1 });
  if (!r) throw new ToolError("not_found", `No ad ${adId} in ad group ${adGroupId} (an ad is identified by both ids).`);
  const ad = toRsa(r, ads.customerId);
  if (ad.status === "REMOVED") throw new ToolError("invalid_argument", "The ad is removed and cannot be changed.");
  if (ad.type !== "RESPONSIVE_SEARCH_AD") throw new ToolError("unsupported", `Only responsive search ads can be edited here; this ad is ${ad.type || "of an unknown type"}. Google's ad update service does not support text, expanded dynamic search, Gmail or image ads.`);
  return ad;
}

const patched = (cur: Rsa, p: Patch) => ({
  headlines: p.headlines ?? cur.headlines,
  descriptions: p.descriptions ?? cur.descriptions,
  final_urls: p.final_urls ?? cur.finalUrls,
  path1: p.path1 === undefined ? cur.path1 : p.path1,
  path2: p.path2 === undefined ? cur.path2 : p.path2,
});
const fieldsOf = (p: Patch) => (["headlines", "descriptions", "final_urls", "path1", "path2"] as const).filter((k) => p[k] !== undefined);
const same = (cur: Rsa, want: ReturnType<typeof patched>, keys: readonly string[]) =>
  keys.every((k) => (k === "headlines" ? sameAssets(cur.headlines, want.headlines) : k === "descriptions" ? sameAssets(cur.descriptions, want.descriptions) : k === "final_urls" ? sameUrls(cur.finalUrls, want.final_urls) : k === "path1" ? cur.path1 === want.path1 : cur.path2 === want.path2));
const snapOf = (cur: Rsa, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, k === "headlines" ? canon(cur.headlines) : k === "descriptions" ? canon(cur.descriptions) : k === "final_urls" ? cur.finalUrls.map(normUrl) : k === "path1" ? cur.path1 : cur.path2]));

function updateOp(cur: Rsa, p: Patch) {
  const update: Record<string, unknown> = { resourceName: cur.adResource };
  const rsa: Record<string, unknown> = {};
  const mask: string[] = [];
  if (p.headlines) (rsa.headlines = toApi(p.headlines)), mask.push("responsive_search_ad.headlines");
  if (p.descriptions) (rsa.descriptions = toApi(p.descriptions)), mask.push("responsive_search_ad.descriptions");
  if (p.path1 !== undefined) (p.path1 !== null && (rsa.path1 = p.path1)), mask.push("responsive_search_ad.path1"); // in the mask but absent: cleared
  if (p.path2 !== undefined) (p.path2 !== null && (rsa.path2 = p.path2)), mask.push("responsive_search_ad.path2");
  if (Object.keys(rsa).length) update.responsiveSearchAd = rsa;
  if (p.final_urls) (update.finalUrls = p.final_urls), mask.push("final_urls");
  return { update, updateMask: mask.join(",") };
}

const diffText = (label: string, before: Asset[], after: Asset[]) => {
  const b = new Set(canon(before)), a = new Set(canon(after));
  const added = canon(after).filter((x) => !b.has(x)).map((x) => x.split("|").slice(1).join("|"));
  const removed = canon(before).filter((x) => !a.has(x)).map((x) => x.split("|").slice(1).join("|"));
  const pins = sameAssets(before, after) ? "" : added.length || removed.length ? "" : " (pinning changed)";
  return `${label}: ${before.length} -> ${after.length}${added.length ? `; adding ${added.slice(0, 5).map((t) => `"${t}"`).join(", ")}${added.length > 5 ? ", …" : ""}` : ""}${removed.length ? `; removing ${removed.slice(0, 5).map((t) => `"${t}"`).join(", ")}${removed.length > 5 ? ", …" : ""}` : ""}${pins}`;
};

function out(adGroupId: string, cur: Rsa) {
  return { ad_group_id: adGroupId, ad_id: cur.adId, headlines: cur.headlines.map((h) => ({ text: h.text, pinned_field: h.pinned_field ?? null })), descriptions: cur.descriptions.map((h) => ({ text: h.text, pinned_field: h.pinned_field ?? null })), final_urls: cur.finalUrls, path1: cur.path1, path2: cur.path2 };
}

/** Shared plan/execute/verify for the three edit tools. */
const editCore = {
  async plan(ads: GoogleAdsClient, adGroupId: string, adId: string, p: Patch) {
    const cur = await readRsa(ads, adGroupId, adId);
    const want = patched(cur, p);
    if (want.path2 && !want.path1) throw new ToolError("invalid_argument", "path2 can only be set when path1 is also set.");
    const keys = fieldsOf(p);
    if (same(cur, want, keys)) throw new ToolError("invalid_argument", "Nothing would change: the ad already has this content.");
    // Google validates the exact request (lengths, policy, pinning) without changing anything.
    await ads.mutate("ads", [updateOp(cur, p)], { validateOnly: true });
    const lines: string[] = [];
    if (p.headlines) lines.push(diffText("headlines", cur.headlines, p.headlines));
    if (p.descriptions) lines.push(diffText("descriptions", cur.descriptions, p.descriptions));
    if (p.final_urls) lines.push(`final URL ${cur.finalUrls.join(", ") || "none"} -> ${p.final_urls.join(", ")}`);
    if (p.path1 !== undefined) lines.push(`path1 ${cur.path1 ?? "none"} -> ${p.path1 ?? "none"}`);
    if (p.path2 !== undefined) lines.push(`path2 ${cur.path2 ?? "none"} -> ${p.path2 ?? "none"}`);
    const live = cur.status === "ENABLED" ? " This ad is live: Google may re-review a changed ad before it serves again." : "";
    return { summary: `Edit ad ${adId} in ad group ${adGroupId}: ${lines.join(" | ")}.${live}`, snapshot: snapOf(cur, keys) };
  },
  async verify(ads: GoogleAdsClient, adGroupId: string, adId: string, p: Patch, snapshot: unknown) {
    const cur = await readRsa(ads, adGroupId, adId);
    const keys = fieldsOf(p);
    if (same(cur, patched(cur, p), keys)) return { outcome: "applied" as const };
    // Snapshots round-trip through JSONB, which does not preserve key order: compare canonically.
    return canonicalJson(snapOf(cur, keys)) === canonicalJson(snapshot) ? { outcome: "not_applied" as const } : { outcome: "indeterminate" as const, detail: "the ad matches neither the old nor the requested content" };
  },
  async execute(ads: GoogleAdsClient, adGroupId: string, adId: string, p: Patch, snapshot: unknown) {
    const cur = await readRsa(ads, adGroupId, adId);
    const keys = fieldsOf(p);
    if (canonicalJson(snapOf(cur, keys)) !== canonicalJson(snapshot)) throw new ToolError("conflict", "The ad changed since this was requested.");
    await ads.mutate("ads", [updateOp(cur, p)]);
    const after = await readRsa(ads, adGroupId, adId);
    if (!same(after, patched(after, p), keys)) throw new ToolError("unknown_outcome", "Google accepted the request but the ad does not read back as requested.");
    return out(adGroupId, after);
  },
};

const ref = { account_id: accountId, ad_group_id: id, ad_id: id };
const WARN = " Replaces the whole list: include every item you want to keep. Google validates the text (length limits, policy) before this is queued. Editing a live ad may trigger a new review. Assets Google created automatically cannot be removed this way.";

export const updateAdHeadlines = googleWrite({
  name: "update_ad_headlines",
  title: "Update responsive search ad headlines",
  risk: "write",
  description: `Replaces the headlines of a responsive search ad (3 to 15; pinning only to HEADLINE_1, HEADLINE_2 or HEADLINE_3) after approval.${WARN}`,
  input: z.object({ ...ref, headlines }),
  output: contentOut,
  plan: (a, ctx) => editCore.plan(ctx.services.ads, a.ad_group_id, a.ad_id, { headlines: a.headlines }),
  verify: (a, ctx, run) => editCore.verify(ctx.services.ads, a.ad_group_id, a.ad_id, { headlines: a.headlines }, run.snapshot),
  execute: (a, ctx, run) => editCore.execute(ctx.services.ads, a.ad_group_id, a.ad_id, { headlines: a.headlines }, run.snapshot),
});

export const updateAdDescriptions = googleWrite({
  name: "update_ad_descriptions",
  title: "Update responsive search ad descriptions",
  risk: "write",
  description: `Replaces the descriptions of a responsive search ad (2 to 4; pinning only to DESCRIPTION_1 or DESCRIPTION_2) after approval.${WARN}`,
  input: z.object({ ...ref, descriptions }),
  output: contentOut,
  plan: (a, ctx) => editCore.plan(ctx.services.ads, a.ad_group_id, a.ad_id, { descriptions: a.descriptions }),
  verify: (a, ctx, run) => editCore.verify(ctx.services.ads, a.ad_group_id, a.ad_id, { descriptions: a.descriptions }, run.snapshot),
  execute: (a, ctx, run) => editCore.execute(ctx.services.ads, a.ad_group_id, a.ad_id, { descriptions: a.descriptions }, run.snapshot),
});

const contentInput = z.object({ ...ref, headlines: headlines.optional(), descriptions: descriptions.optional(), final_urls: finalUrls.optional(), path1: path.nullable().optional().describe("Display path 1. null clears it."), path2: path.nullable().optional().describe("Display path 2. Needs path1. null clears it.") }).refine((v) => v.headlines || v.descriptions || v.final_urls || v.path1 !== undefined || v.path2 !== undefined, "give at least one of headlines, descriptions, final_urls, path1, path2");
const patchOf = (a: z.infer<typeof contentInput>): Patch => ({ headlines: a.headlines, descriptions: a.descriptions, final_urls: a.final_urls, path1: a.path1, path2: a.path2 });

export const updateAdContent = googleWrite({
  name: "update_ad_content",
  title: "Update responsive search ad content",
  risk: "write",
  description: `Changes any of a responsive search ad's headlines, descriptions, final URL and display paths in one request after approval. Fields you leave out are unchanged; headlines and descriptions are replaced as whole lists. path2 needs path1. Only responsive search ads are supported.${WARN.replace(" Replaces the whole list: include every item you want to keep.", "")}`,
  input: contentInput,
  output: contentOut,
  plan: (a, ctx) => editCore.plan(ctx.services.ads, a.ad_group_id, a.ad_id, patchOf(a)),
  verify: (a, ctx, run) => editCore.verify(ctx.services.ads, a.ad_group_id, a.ad_id, patchOf(a), run.snapshot),
  execute: (a, ctx, run) => editCore.execute(ctx.services.ads, a.ad_group_id, a.ad_id, patchOf(a), run.snapshot),
});

// ---------------------------------------------------------------------------------------------------- create_ad
async function findIdentical(ads: GoogleAdsClient, agId: string, h: Asset[], d: Asset[]): Promise<Rsa | null> {
  const q = new Gaql().select(...RSA_FIELDS).from("ad_group_ad").where(`ad_group.id = ${lit.id(agId)}`).where("ad_group_ad.status != 'REMOVED'").where("ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'");
  const rows = await ads.query(q, { maxRows: 1000 });
  return rows.map((r) => toRsa(r, ads.customerId)).find((x) => sameAssets(x.headlines, h) && sameAssets(x.descriptions, d)) ?? null;
}

export const createAd = googleWrite({
  name: "create_ad",
  title: "Create responsive search ad",
  risk: "write",
  description: "Creates a responsive search ad in an ad group after approval. The ad is always created PAUSED, so it cannot spend until it is resumed with resume_ad (high impact). Needs 3 to 15 headlines, 2 to 4 descriptions and a final URL; path2 needs path1. Google validates the text (length limits, policy) before this is queued. Refuses an exact copy of an existing ad in the ad group. Only responsive search ads are supported here.",
  input: z.object({ account_id: accountId, ad_group_id: id.describe("An ad group id (not a campaign id)."), final_urls: finalUrls, headlines, descriptions, path1: path.optional(), path2: path.optional() }).refine((v) => !v.path2 || !!v.path1, "path2 can only be set when path1 is also set"),
  output: z.object({ ad_group_id: z.string(), ad_id: z.string(), status: z.literal("PAUSED"), headline_count: z.number(), description_count: z.number() }),
  plan: async (a, ctx) => {
    const ads = ctx.services.ads;
    const state = await requireParent(ads, "ad_group", a.ad_group_id, "Ads");
    const dup = await findIdentical(ads, a.ad_group_id, a.headlines, a.descriptions);
    if (dup) throw new ToolError("invalid_argument", `An ad with exactly these headlines and descriptions already exists in this ad group (ad ${dup.adId}).`);
    await ads.mutate("adGroupAds", [createOp(ads.customerId, a)], { validateOnly: true });
    return { summary: `Create a PAUSED responsive search ad in ad group ${a.ad_group_id} with ${a.headlines.length} headlines (e.g. ${a.headlines.slice(0, 3).map((h) => `"${h.text}"`).join(", ")}), ${a.descriptions.length} descriptions, final URL ${a.final_urls[0]}. It will not run until resumed.`, snapshot: { adGroupStatus: state } };
  },
  verify: async (a, ctx) => ((await findIdentical(ctx.services.ads, a.ad_group_id, a.headlines, a.descriptions)) ? { outcome: "applied" } : { outcome: "not_applied" }),
  execute: async (a, ctx) => {
    const ads = ctx.services.ads;
    if (await findIdentical(ads, a.ad_group_id, a.headlines, a.descriptions)) throw new ToolError("conflict", "An identical ad now exists in this ad group.");
    await ads.mutate("adGroupAds", [createOp(ads.customerId, a)]);
    const made = await findIdentical(ads, a.ad_group_id, a.headlines, a.descriptions);
    if (!made) throw new ToolError("unknown_outcome", "Google accepted the request but the new ad does not read back.");
    if (made.status !== "PAUSED") throw new ToolError("unknown_outcome", `The ad was created but reads ${made.status}, not PAUSED. Check it in Google Ads.`);
    return { ad_group_id: a.ad_group_id, ad_id: made.adId, status: "PAUSED" as const, headline_count: made.headlines.length, description_count: made.descriptions.length };
  },
});

function createOp(customerId: string, a: { ad_group_id: string; final_urls: string[]; headlines: Asset[]; descriptions: Asset[]; path1?: string; path2?: string }) {
  return {
    create: {
      adGroup: `customers/${customerId}/adGroups/${a.ad_group_id}`,
      status: "PAUSED",
      ad: { finalUrls: a.final_urls, responsiveSearchAd: { headlines: toApi(a.headlines), descriptions: toApi(a.descriptions), ...(a.path1 ? { path1: a.path1 } : {}), ...(a.path2 ? { path2: a.path2 } : {}) } },
    },
  };
}

export const adContentTools = [createAd, updateAdHeadlines, updateAdDescriptions, updateAdContent];
