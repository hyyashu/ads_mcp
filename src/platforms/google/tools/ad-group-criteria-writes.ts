import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change, Effect } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, pick } from "../gaql";
import { tailId } from "./campaign-reads";
import { accountId, idSchema, str } from "./common";
import { rn, stateWrite } from "./write-kit";

/**
 * Ad-group criteria writes: audiences, demographics, content keywords, placements and topics, plus campaign placement
 * exclusions and Demand Gen channel controls. Every criterion is identified by a stable key (type + value), so adding
 * skips what is already there and the result can be confirmed by re-reading.
 */
type Channel = "DISPLAY" | "DEMAND_GEN" | "SEARCH" | "VIDEO";
interface Crit {
  criterion_id: string;
  key: string;
  negative: boolean;
  label: string;
}
interface GroupState {
  ad_group: { id: string; name: string | null; campaign_id: string | null; channel: string | null };
  criteria: Crit[];
}
const change = (ref: { resource: string; id: string; name?: string | null }, field: string, before: string | null, after: string | null, effect: Effect): Change => ({ ...ref, field, before, after, unit: "text", effect });

const c = "ad_group_criterion";
const FIELDS = [`${c}.criterion_id`, `${c}.type`, `${c}.negative`, `${c}.user_list.user_list`, `${c}.user_interest.user_interest_category`, `${c}.custom_audience.custom_audience`, `${c}.age_range.type`, `${c}.gender.type`, `${c}.income_range.type`, `${c}.parental_status.type`, `${c}.keyword.text`, `${c}.keyword.match_type`, `${c}.placement.url`, `${c}.youtube_channel.channel_id`, `${c}.youtube_video.video_id`, `${c}.mobile_application.app_id`, `${c}.topic.topic_constant`];

/** The key of a criterion as read from Google. Keys are what requests are compared against. */
function keyOf(r: Row): string {
  const t = String(pick(r, `${c}.type`) ?? "");
  const v = (f: string) => String(pick(r, `${c}.${f}`) ?? "");
  switch (t) {
    case "USER_LIST": return `USER_LIST:${tailId(v("user_list.user_list"))}`;
    case "USER_INTEREST": return `USER_INTEREST:${tailId(v("user_interest.user_interest_category"))}`;
    case "CUSTOM_AUDIENCE": return `CUSTOM_AUDIENCE:${tailId(v("custom_audience.custom_audience"))}`;
    case "AGE_RANGE": return `AGE_RANGE:${v("age_range.type")}`;
    case "GENDER": return `GENDER:${v("gender.type")}`;
    case "INCOME_RANGE": return `INCOME_RANGE:${v("income_range.type")}`;
    case "PARENTAL_STATUS": return `PARENTAL_STATUS:${v("parental_status.type")}`;
    case "KEYWORD": return `KEYWORD:${v("keyword.text").toLowerCase()}|${v("keyword.match_type")}`;
    case "PLACEMENT": return `PLACEMENT:${v("placement.url").toLowerCase()}`;
    case "YOUTUBE_CHANNEL": return `YOUTUBE_CHANNEL:${v("youtube_channel.channel_id")}`;
    case "YOUTUBE_VIDEO": return `YOUTUBE_VIDEO:${v("youtube_video.video_id")}`;
    case "MOBILE_APPLICATION": return `MOBILE_APPLICATION:${v("mobile_application.app_id")}`;
    case "TOPIC": return `TOPIC:${tailId(v("topic.topic_constant"))}`;
    default: return `${t}:?`;
  }
}

async function readGroup(ads: GoogleAdsClient, adGroupId: string, types: readonly string[], channel?: Channel): Promise<GroupState> {
  const [g] = await ads.query(new Gaql().select("ad_group.id", "ad_group.name", "ad_group.status", "campaign.id", "campaign.advertising_channel_type").from("ad_group").where(`ad_group.id = ${lit.id(adGroupId)}`).limit(1), { maxRows: 1 });
  if (!g) throw new ToolError("not_found", `No ad group ${adGroupId} in this account.`);
  if (str(g, "ad_group.status") === "REMOVED") throw new ToolError("invalid_argument", "The ad group is removed and cannot be changed.");
  const ch = str(g, "campaign.advertising_channel_type");
  if (channel && ch !== channel) throw new ToolError("invalid_argument", `Ad group ${adGroupId} belongs to a ${ch} campaign; this tool is for ${channel} campaigns.`);
  const rows = await ads.query(new Gaql().select(...FIELDS).from(c).where(`ad_group.id = ${lit.id(adGroupId)}`).where(`${c}.type IN ${lit.list(types.map((t) => `'${t}'`))}`).where(`${c}.status != 'REMOVED'`), { maxRows: 10_000 });
  return {
    ad_group: { id: adGroupId, name: str(g, "ad_group.name"), campaign_id: str(g, "campaign.id"), channel: ch },
    criteria: rows.map((r) => ({ criterion_id: String(pick(r, `${c}.criterion_id`)), key: keyOf(r), negative: pick(r, `${c}.negative`) === true, label: keyOf(r) })).sort((x, y) => x.key.localeCompare(y.key) || x.criterion_id.localeCompare(y.criterion_id)),
  };
}
const agcRn = (ads: GoogleAdsClient, adGroupId: string, criterionId: string) => `customers/${ads.customerId}/adGroupCriteria/${adGroupId}~${criterionId}`;

// ----------------------------------------------------------------------------------------------------- audiences
const audience = z.object({ kind: z.enum(["user_list", "user_interest", "custom_audience"]), id: idSchema, exclude: z.boolean().default(false) });
type Audience = z.infer<typeof audience>;
const AUDIENCE_TYPES = ["USER_LIST", "USER_INTEREST", "CUSTOM_AUDIENCE"] as const;
const audienceKey = (a: Audience) => `${a.kind.toUpperCase()}:${a.id}`;
const audienceBody = (ads: GoogleAdsClient, a: Audience): Row =>
  a.kind === "user_list" ? { userList: { userList: rn(ads, "userLists", a.id) } } : a.kind === "user_interest" ? { userInterest: { userInterestCategory: rn(ads, "userInterests", a.id) } } : { customAudience: { customAudience: rn(ads, "customAudiences", a.id) } };

function addAudiencesTool(name: "add_ad_group_audiences" | "add_display_audiences", channel?: Channel) {
  return stateWrite({
    name,
    title: channel === "DISPLAY" ? "Add Display audiences" : "Add ad group audiences",
    risk: "write",
    description: `Adds audiences to ${channel === "DISPLAY" ? "a Display" : "an"} ad group (data segments, affinity/in-market user interests or custom audiences, ids from search_audiences), as targets or exclusions, after approval. Whether targets narrow reach or only observe depends on the ad group's targeting setting. Audiences already on the ad group are skipped. Applied atomically and confirmed by re-reading.`,
    input: z.object({ account_id: accountId, ad_group_id: idSchema, audiences: z.array(audience).min(1).max(50) }),
    output: z.object({ ad_group_id: z.string(), added: z.array(z.string()), skipped_existing: z.array(z.string()) }),
    read: (a, ads) => readGroup(ads, a.ad_group_id, AUDIENCE_TYPES, channel),
    build: (a, s, ads) => {
      const have = new Map(s.criteria.map((x) => [x.key, x]));
      const ops: Row[] = [];
      const changes: Change[] = [];
      for (const au of a.audiences) {
        const cur = have.get(audienceKey(au));
        if (cur && cur.negative === au.exclude) continue;
        if (cur) throw new ToolError("invalid_argument", `${audienceKey(au)} is already ${cur.negative ? "excluded" : "targeted"}; remove it first.`);
        ops.push({ adGroupCriterionOperation: { create: { adGroup: rn(ads, "adGroups", a.ad_group_id), ...(au.exclude ? { negative: true } : {}), ...audienceBody(ads, au) } } });
        changes.push(change({ resource: "ad_group", id: a.ad_group_id, name: s.ad_group.name }, au.exclude ? "excluded_audience" : "audience", null, audienceKey(au), "neutral"));
      }
      return { summary: `Ad group "${s.ad_group.name ?? a.ad_group_id}": add ${changes.map((x) => `${x.field === "excluded_audience" ? "exclusion " : ""}${x.after}`).join(", ")}`, changes, ops };
    },
    landed: (a, _b, after) => a.audiences.every((au) => after.criteria.some((x) => x.key === audienceKey(au) && x.negative === au.exclude)),
    result: (a, _after, _r, before) => {
      const had = new Set(before.criteria.map((x) => x.key));
      return { ad_group_id: a.ad_group_id, added: a.audiences.filter((au) => !had.has(audienceKey(au))).map(audienceKey), skipped_existing: a.audiences.filter((au) => had.has(audienceKey(au))).map(audienceKey) };
    },
  });
}
export const addAdGroupAudiences = addAudiencesTool("add_ad_group_audiences");
export const addDisplayAudiences = addAudiencesTool("add_display_audiences", "DISPLAY");

export const replaceDemandgenAudiences = stateWrite({
  name: "replace_demandgen_audiences",
  title: "Replace Demand Gen audiences",
  risk: "high_impact",
  description: "Replaces all audience targeting and exclusions on a Demand Gen ad group with the given set, in one atomic request, after a person approves it (it can change who sees the ads entirely). An empty list removes all audiences. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema, audiences: z.array(audience).max(50) }),
  output: z.object({ ad_group_id: z.string(), audiences: z.array(z.string()) }),
  read: (a, ads) => readGroup(ads, a.ad_group_id, AUDIENCE_TYPES, "DEMAND_GEN"),
  build: (a, s, ads) => {
    const want = new Map(a.audiences.map((au) => [`${audienceKey(au)}|${au.exclude}`, au]));
    const ops: Row[] = [];
    const changes: Change[] = [];
    const ref = { resource: "ad_group", id: a.ad_group_id, name: s.ad_group.name };
    for (const x of s.criteria) {
      if (want.has(`${x.key}|${x.negative}`)) continue;
      ops.push({ adGroupCriterionOperation: { remove: agcRn(ads, a.ad_group_id, x.criterion_id) } });
      changes.push(change(ref, x.negative ? "excluded_audience" : "audience", x.key, null, x.negative ? "enable" : "neutral"));
    }
    const have = new Set(s.criteria.map((x) => `${x.key}|${x.negative}`));
    for (const [k, au] of want) {
      if (have.has(k)) continue;
      ops.push({ adGroupCriterionOperation: { create: { adGroup: rn(ads, "adGroups", a.ad_group_id), ...(au.exclude ? { negative: true } : {}), ...audienceBody(ads, au) } } });
      // A new target in a replacement can reach people the old set did not: treated as widening.
      changes.push(change(ref, au.exclude ? "excluded_audience" : "audience", null, audienceKey(au), au.exclude ? "neutral" : "enable"));
    }
    return { summary: `Demand Gen ad group "${s.ad_group.name ?? a.ad_group_id}": audiences -> ${a.audiences.length ? a.audiences.map((au) => `${au.exclude ? "-" : ""}${audienceKey(au)}`).join(", ") : "none"}`, changes, ops };
  },
  landed: (a, _b, after) => JSON.stringify(after.criteria.map((x) => `${x.key}|${x.negative}`).sort()) === JSON.stringify([...new Set(a.audiences.map((au) => `${audienceKey(au)}|${au.exclude}`))].sort()),
  result: (a, after) => ({ ad_group_id: a.ad_group_id, audiences: after.criteria.map((x) => `${x.negative ? "-" : ""}${x.key}`) }),
});

// -------------------------------------------------------------------------------------------------- demographics
const AGE = ["AGE_RANGE_18_24", "AGE_RANGE_25_34", "AGE_RANGE_35_44", "AGE_RANGE_45_54", "AGE_RANGE_55_64", "AGE_RANGE_65_UP", "AGE_RANGE_UNDETERMINED"] as const;
const GENDER = ["MALE", "FEMALE", "UNDETERMINED"] as const;
const INCOME = ["INCOME_RANGE_0_50", "INCOME_RANGE_50_60", "INCOME_RANGE_60_70", "INCOME_RANGE_70_80", "INCOME_RANGE_80_90", "INCOME_RANGE_90_UP", "INCOME_RANGE_UNDETERMINED"] as const;
const PARENTAL = ["PARENT", "NOT_A_PARENT", "UNDETERMINED"] as const;
const demo = z.object({ age_ranges: z.array(z.enum(AGE)).max(7).default([]), genders: z.array(z.enum(GENDER)).max(3).default([]), income_ranges: z.array(z.enum(INCOME)).max(7).default([]), parental_statuses: z.array(z.enum(PARENTAL)).max(3).default([]) });
type Demo = z.infer<typeof demo>;
const demoKeys = (d: Demo) => [...d.age_ranges.map((v) => `AGE_RANGE:${v}`), ...d.genders.map((v) => `GENDER:${v}`), ...d.income_ranges.map((v) => `INCOME_RANGE:${v}`), ...d.parental_statuses.map((v) => `PARENTAL_STATUS:${v}`)];
const demoBody = (key: string): Row => {
  const [t, v] = key.split(":") as [string, string];
  return t === "AGE_RANGE" ? { ageRange: { type: v } } : t === "GENDER" ? { gender: { type: v } } : t === "INCOME_RANGE" ? { incomeRange: { type: v } } : { parentalStatus: { type: v } };
};
function demographicsTool(name: "update_ad_group_demographics" | "update_display_demographics", channel?: Channel) {
  return stateWrite({
    name,
    title: channel ? "Update Display demographics" : "Update ad group demographics",
    risk: "write",
    description: `Excludes demographic groups from ${channel ? "a Display" : "an"} ad group, or includes previously excluded ones again (age ranges, genders, household income, parental status), after approval. By default every group is reached; excluding narrows reach, including again widens it and needs a second approver. Applied atomically and confirmed by re-reading.`,
    input: z.object({ account_id: accountId, ad_group_id: idSchema, exclude: demo.default({ age_ranges: [], genders: [], income_ranges: [], parental_statuses: [] }), include_again: demo.default({ age_ranges: [], genders: [], income_ranges: [], parental_statuses: [] }) }),
    output: z.object({ ad_group_id: z.string(), excluded: z.array(z.string()) }),
    read: (a, ads) => readGroup(ads, a.ad_group_id, ["AGE_RANGE", "GENDER", "INCOME_RANGE", "PARENTAL_STATUS"], channel),
    build: (a, s, ads) => {
      const ex = demoKeys(a.exclude);
      const inc = demoKeys(a.include_again);
      if (ex.some((k) => inc.includes(k))) throw new ToolError("invalid_argument", "The same group cannot be excluded and included again.");
      const ops: Row[] = [];
      const changes: Change[] = [];
      const ref = { resource: "ad_group", id: a.ad_group_id, name: s.ad_group.name };
      for (const k of ex) {
        const cur = s.criteria.find((x) => x.key === k);
        if (cur?.negative) continue;
        if (cur) ops.push({ adGroupCriterionOperation: { remove: agcRn(ads, a.ad_group_id, cur.criterion_id) } }); // a positive criterion is replaced by the exclusion
        ops.push({ adGroupCriterionOperation: { create: { adGroup: rn(ads, "adGroups", a.ad_group_id), negative: true, ...demoBody(k) } } });
        changes.push(change(ref, "demographic", k, "excluded", "pause"));
      }
      for (const k of inc) {
        const cur = s.criteria.find((x) => x.key === k && x.negative);
        if (!cur) continue;
        ops.push({ adGroupCriterionOperation: { remove: agcRn(ads, a.ad_group_id, cur.criterion_id) } });
        changes.push(change(ref, "demographic", `${k} excluded`, k, "enable"));
      }
      return { summary: `Ad group "${s.ad_group.name ?? a.ad_group_id}" demographics: ${changes.map((x) => (x.after === "excluded" ? `exclude ${x.before}` : `include ${x.after}`)).join(", ")}`, changes, ops };
    },
    landed: (a, _b, after) => demoKeys(a.exclude).every((k) => after.criteria.some((x) => x.key === k && x.negative)) && demoKeys(a.include_again).every((k) => !after.criteria.some((x) => x.key === k && x.negative)),
    result: (a, after) => ({ ad_group_id: a.ad_group_id, excluded: after.criteria.filter((x) => x.negative).map((x) => x.key) }),
  });
}
export const updateAdGroupDemographics = demographicsTool("update_ad_group_demographics");
export const updateDisplayDemographics = demographicsTool("update_display_demographics", "DISPLAY");

// ------------------------------------------------------------------------------- Display keywords, placements, topics
function addDisplayCriteriaTool<T>(o: { name: string; title: string; description: string; types: readonly string[]; item: z.ZodType<T>; key: (it: T) => string; body: (it: T) => Row }) {
  return stateWrite({
    name: o.name,
    title: o.title,
    risk: "write",
    description: o.description,
    input: z.object({ account_id: accountId, ad_group_id: idSchema, items: z.array(o.item).min(1).max(100) }),
    output: z.object({ ad_group_id: z.string(), added: z.array(z.string()), skipped_existing: z.array(z.string()) }),
    read: (a, ads) => readGroup(ads, a.ad_group_id, o.types, "DISPLAY"),
    build: (a, s, ads) => {
      const have = new Set(s.criteria.filter((x) => !x.negative).map((x) => x.key));
      const seen = new Set<string>();
      const fresh = (a.items as T[]).filter((it) => {
        const k = o.key(it);
        if (have.has(k) || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (!fresh.length) throw new ToolError("invalid_argument", "Nothing would change: every item is already on the ad group.");
      return {
        summary: `Display ad group "${s.ad_group.name ?? a.ad_group_id}": target ${fresh.map(o.key).join(", ")}`,
        changes: fresh.map((it) => change({ resource: "ad_group", id: a.ad_group_id, name: s.ad_group.name }, o.types[0]!.toLowerCase(), null, o.key(it), "neutral")),
        ops: fresh.map((it) => ({ adGroupCriterionOperation: { create: { adGroup: rn(ads, "adGroups", a.ad_group_id), ...o.body(it) } } })),
      };
    },
    landed: (a, _b, after) => (a.items as T[]).every((it) => after.criteria.some((x) => x.key === o.key(it) && !x.negative)),
    result: (a, _after, _r, before) => {
      const had = new Set(before.criteria.filter((x) => !x.negative).map((x) => x.key));
      const items = a.items as T[];
      return { ad_group_id: a.ad_group_id, added: [...new Set(items.filter((it) => !had.has(o.key(it))).map(o.key))], skipped_existing: items.filter((it) => had.has(o.key(it))).map(o.key) };
    },
  });
}
const placement = z.object({ type: z.enum(["website", "youtube_channel", "youtube_video", "mobile_app"]), value: z.string().trim().min(1).max(255).regex(/^[^\s\u0000-\u001f]+$/, "no spaces or control characters") });
type Placement = z.infer<typeof placement>;
const placementKey = (p: Placement) => (p.type === "website" ? `PLACEMENT:${p.value.toLowerCase()}` : p.type === "youtube_channel" ? `YOUTUBE_CHANNEL:${p.value}` : p.type === "youtube_video" ? `YOUTUBE_VIDEO:${p.value}` : `MOBILE_APPLICATION:${p.value}`);
const placementBody = (p: Placement): Row => (p.type === "website" ? { placement: { url: p.value } } : p.type === "youtube_channel" ? { youtubeChannel: { channelId: p.value } } : p.type === "youtube_video" ? { youtubeVideo: { videoId: p.value } } : { mobileApplication: { appId: p.value } });

export const addDisplayKeywords = addDisplayCriteriaTool({
  name: "add_display_keywords",
  title: "Add Display keywords",
  description: "Adds content keywords to a Display ad group after approval: Google shows the ads on pages, apps and videos about these words (not on searches). Match type is always broad for Display. Keywords already on the ad group are skipped. Confirmed by re-reading.",
  types: ["KEYWORD"],
  item: z.object({ text: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f]+$/).refine((t) => t.split(/\s+/).length <= 10, "at most 10 words") }),
  key: (k) => `KEYWORD:${k.text.toLowerCase()}|BROAD`,
  body: (k) => ({ keyword: { text: k.text, matchType: "BROAD" } }),
});
export const addDisplayPlacements = addDisplayCriteriaTool({
  name: "add_display_placements",
  title: "Add Display placements",
  description: "Adds managed placements to a Display ad group after approval: websites (domain), YouTube channels (channel id), YouTube videos (video id) or mobile apps (for example 1-com.example.app for Android, 2-123456 for iOS). Placements already on the ad group are skipped. Confirmed by re-reading.",
  types: ["PLACEMENT", "YOUTUBE_CHANNEL", "YOUTUBE_VIDEO", "MOBILE_APPLICATION"],
  item: placement,
  key: placementKey,
  body: placementBody,
});
export const addDisplayTopics = addDisplayCriteriaTool({
  name: "add_display_topics",
  title: "Add Display topics",
  description: "Adds topics (Google's content categories, by topic constant id) to a Display ad group after approval, so ads show on content about those topics. Topics already on the ad group are skipped. Confirmed by re-reading.",
  types: ["TOPIC"],
  item: z.object({ topic_id: idSchema }),
  key: (t) => `TOPIC:${t.topic_id}`,
  body: (t) => ({ topic: { topicConstant: `topicConstants/${t.topic_id}` } }),
});

// --------------------------------------------------------------------------------------- remove_display_criteria
export const removeDisplayCriteria = stateWrite({
  name: "remove_display_criteria",
  title: "Remove Display targeting",
  risk: "destructive",
  description: "Removes targeting criteria (audiences, demographics, keywords, placements, topics) from a Display ad group by criterion id, after a person approves it. Removing a target can widen reach; removing an exclusion widens it too. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema, criterion_ids: z.array(idSchema).min(1).max(100) }),
  output: z.object({ ad_group_id: z.string(), removed: z.array(z.string()) }),
  read: (a, ads) => readGroup(ads, a.ad_group_id, ["USER_LIST", "USER_INTEREST", "CUSTOM_AUDIENCE", "AGE_RANGE", "GENDER", "INCOME_RANGE", "PARENTAL_STATUS", "KEYWORD", "PLACEMENT", "YOUTUBE_CHANNEL", "YOUTUBE_VIDEO", "MOBILE_APPLICATION", "TOPIC"], "DISPLAY"),
  build: (a, s, ads) => {
    const ids = [...new Set(a.criterion_ids)].sort();
    const missing = ids.filter((id) => !s.criteria.some((x) => x.criterion_id === id));
    if (missing.length) throw new ToolError("invalid_argument", `Not on this Display ad group: ${missing.join(", ")}`);
    const crit = (id: string) => s.criteria.find((x) => x.criterion_id === id)!;
    return {
      summary: `Display ad group "${s.ad_group.name ?? a.ad_group_id}": remove ${ids.map((id) => `${crit(id).negative ? "exclusion " : ""}${crit(id).key}`).join(", ")}`,
      changes: ids.map((id) => change({ resource: "ad_group", id: a.ad_group_id, name: s.ad_group.name }, crit(id).negative ? "exclusion" : "targeting", crit(id).key, null, "remove")),
      ops: ids.map((id) => ({ adGroupCriterionOperation: { remove: agcRn(ads, a.ad_group_id, id) } })),
    };
  },
  landed: (a, _b, after) => a.criterion_ids.every((id) => !after.criteria.some((x) => x.criterion_id === id)),
  result: (a) => ({ ad_group_id: a.ad_group_id, removed: [...new Set(a.criterion_ids)].sort() }),
});

// -------------------------------------------------------------------------------------- add_placement_exclusions
export const addPlacementExclusions = stateWrite({
  name: "add_placement_exclusions",
  title: "Exclude placements",
  risk: "write",
  description: "Excludes placements (websites, YouTube channels, YouTube videos, mobile apps) from a whole campaign after approval, so its ads stop showing there. Use get_placement_performance to find poor placements. Exclusions already present are skipped. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, campaign_id: idSchema, placements: z.array(placement).min(1).max(200) }),
  output: z.object({ campaign_id: z.string(), excluded: z.array(z.string()), skipped_existing: z.array(z.string()) }),
  read: async (a, ads) => {
    const [cp] = await ads.query(new Gaql().select("campaign.id", "campaign.name", "campaign.status").from("campaign").where(`campaign.id = ${lit.id(a.campaign_id)}`).limit(1), { maxRows: 1 });
    if (!cp) throw new ToolError("not_found", `No campaign ${a.campaign_id} in this account.`);
    if (str(cp, "campaign.status") === "REMOVED") throw new ToolError("invalid_argument", "The campaign is removed and cannot be changed.");
    const cc = "campaign_criterion";
    const rows = await ads.query(new Gaql().select(`${cc}.criterion_id`, `${cc}.type`, `${cc}.placement.url`, `${cc}.youtube_channel.channel_id`, `${cc}.youtube_video.video_id`, `${cc}.mobile_application.app_id`).from(cc).where(`campaign.id = ${lit.id(a.campaign_id)}`).where(`${cc}.negative = TRUE`).where(`${cc}.type IN ('PLACEMENT', 'YOUTUBE_CHANNEL', 'YOUTUBE_VIDEO', 'MOBILE_APPLICATION')`).where(`${cc}.status != 'REMOVED'`), { maxRows: 10_000 });
    const key = (r: Row) => {
      const t = String(pick(r, `${cc}.type`));
      return t === "PLACEMENT" ? `PLACEMENT:${String(pick(r, `${cc}.placement.url`) ?? "").toLowerCase()}` : t === "YOUTUBE_CHANNEL" ? `YOUTUBE_CHANNEL:${pick(r, `${cc}.youtube_channel.channel_id`)}` : t === "YOUTUBE_VIDEO" ? `YOUTUBE_VIDEO:${pick(r, `${cc}.youtube_video.video_id`)}` : `MOBILE_APPLICATION:${pick(r, `${cc}.mobile_application.app_id`)}`;
    };
    return { campaign: { id: a.campaign_id, name: str(cp, "campaign.name") }, excluded: rows.map(key).sort() };
  },
  build: (a, s, ads) => {
    const fresh = [...new Map(a.placements.map((p) => [placementKey(p), p])).values()].filter((p) => !s.excluded.includes(placementKey(p)));
    if (!fresh.length) throw new ToolError("invalid_argument", "Nothing would change: every placement is already excluded.");
    return {
      summary: `Campaign "${s.campaign.name ?? a.campaign_id}": exclude ${fresh.map(placementKey).join(", ")}`,
      changes: fresh.map((p) => change({ resource: "campaign", id: a.campaign_id, name: s.campaign.name }, "placement_exclusion", null, placementKey(p), "pause")),
      ops: fresh.map((p) => ({ campaignCriterionOperation: { create: { campaign: rn(ads, "campaigns", a.campaign_id), negative: true, ...placementBody(p) } } })),
    };
  },
  landed: (a, _b, after) => a.placements.every((p) => after.excluded.includes(placementKey(p))),
  result: (a, after, _r, before) => ({ campaign_id: a.campaign_id, excluded: after.excluded, skipped_existing: a.placements.map(placementKey).filter((k) => before.excluded.includes(k)) }),
});

// ------------------------------------------------------------------------------- update_demandgen_channel_controls
// v26 DemandGenChannelControls: channel_config chooses the mode (CHANNEL_STRATEGY or SELECTED_CHANNELS); with
// CHANNEL_STRATEGY, channel_strategy is ALL_CHANNELS or ALL_OWNED_AND_OPERATED_CHANNELS (Google-owned surfaces only).
const CHANNELS = ["youtube_in_stream", "youtube_in_feed", "youtube_shorts", "discover", "gmail", "display", "maps"] as const;
const camel = (s: string) => s.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase());
type Mode = "all_channels" | "google_owned_only" | "selected";
const modeOf = (config: string | null, strategy: string | null): Mode | null => (config === "SELECTED_CHANNELS" ? "selected" : strategy === "ALL_OWNED_AND_OPERATED_CHANNELS" ? "google_owned_only" : strategy === "ALL_CHANNELS" || config === "CHANNEL_STRATEGY" ? "all_channels" : null);
const reach: Record<Mode, number> = { selected: 0, google_owned_only: 1, all_channels: 2 };
export const updateDemandgenChannelControls = stateWrite({
  name: "update_demandgen_channel_controls",
  title: "Update Demand Gen channels",
  risk: "write",
  description: "Sets where a Demand Gen ad group serves: all_channels (every eligible Google channel and partners), google_owned_only (YouTube, Discover, Gmail and other Google-owned surfaces), or selected (only the listed channels: YouTube in-stream, in-feed, Shorts, Discover, Gmail, Display, Maps), after approval. Widening needs a second approver. Confirmed by re-reading.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema, mode: z.enum(["all_channels", "google_owned_only", "selected"]), channels: z.array(z.enum(CHANNELS)).max(7).default([]) }).refine((v) => (v.mode === "selected") === v.channels.length > 0, "give channels only (and always) with mode: selected"),
  output: z.object({ ad_group_id: z.string(), mode: z.string().nullable(), selected: z.array(z.string()) }),
  read: async (a, ads) => {
    const p = "ad_group.demand_gen_ad_group_settings.channel_controls";
    const [g] = await ads.query(new Gaql().select("ad_group.id", "ad_group.name", "ad_group.status", "campaign.advertising_channel_type", `${p}.channel_config`, `${p}.channel_strategy`, ...CHANNELS.map((ch) => `${p}.selected_channels.${ch}`)).from("ad_group").where(`ad_group.id = ${lit.id(a.ad_group_id)}`).limit(1), { maxRows: 1 });
    if (!g) throw new ToolError("not_found", `No ad group ${a.ad_group_id} in this account.`);
    if (str(g, "campaign.advertising_channel_type") !== "DEMAND_GEN") throw new ToolError("invalid_argument", "This ad group is not in a Demand Gen campaign.");
    const mode = modeOf(str(g, `${p}.channel_config`), str(g, `${p}.channel_strategy`));
    return { name: str(g, "ad_group.name"), mode, selected: mode === "selected" ? (CHANNELS.filter((ch) => pick(g, `${p}.selected_channels.${ch}`) === true) as string[]) : [] };
  },
  build: (a, s, ads) => {
    const want = a.mode === "selected" ? [...new Set(a.channels)].sort() : [];
    if (s.mode === a.mode && JSON.stringify(want) === JSON.stringify([...s.selected].sort())) throw new ToolError("invalid_argument", "Nothing would change: these channels are already set.");
    const controls: Row =
      a.mode === "selected"
        ? { channelConfig: "SELECTED_CHANNELS", selectedChannels: Object.fromEntries(CHANNELS.map((ch) => [camel(ch), want.includes(ch)])) }
        : { channelConfig: "CHANNEL_STRATEGY", channelStrategy: a.mode === "all_channels" ? "ALL_CHANNELS" : "ALL_OWNED_AND_OPERATED_CHANNELS" };
    const before = s.mode ?? "all_channels";
    const widening = reach[a.mode] > reach[before] || (a.mode === "selected" && before === "selected" && want.some((ch) => !s.selected.includes(ch)));
    const label = (m: string | null, sel: string[]) => (m === "selected" ? `selected: ${sel.join(", ")}` : m ?? "unknown");
    return {
      summary: `Demand Gen ad group "${s.name ?? a.ad_group_id}": channels ${label(s.mode, s.selected)} -> ${label(a.mode, want)}`,
      changes: [change({ resource: "ad_group", id: a.ad_group_id, name: s.name }, "channels", label(s.mode, s.selected), label(a.mode, want), widening ? "enable" : "pause")],
      ops: [{ adGroupOperation: { update: { resourceName: rn(ads, "adGroups", a.ad_group_id), demandGenAdGroupSettings: { channelControls: controls } }, updateMask: "demand_gen_ad_group_settings.channel_controls" } }],
    };
  },
  landed: (a, _b, after) => after.mode === a.mode && (a.mode !== "selected" || JSON.stringify([...after.selected].sort()) === JSON.stringify([...new Set(a.channels)].sort())),
  result: (a, after) => ({ ad_group_id: a.ad_group_id, mode: after.mode, selected: after.selected }),
});

export const adGroupCriteriaWriteTools = [addAdGroupAudiences, addDisplayAudiences, replaceDemandgenAudiences, updateAdGroupDemographics, updateDisplayDemographics, addDisplayKeywords, addDisplayPlacements, addDisplayTopics, removeDisplayCriteria, addPlacementExclusions, updateDemandgenChannelControls];
