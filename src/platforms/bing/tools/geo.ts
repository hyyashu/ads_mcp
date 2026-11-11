import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { AnyTool } from "../../../mcp/tool";
import type { Change } from "../../../policy/change-set";
import type { Row } from "../client";
import { type CountrySetting, type GeoType, GEO_TYPES, ISO_COUNTRIES, addCountrySetting, getCountrySettings, removeCountrySetting } from "../api/geo";
import { accountId, bingRead, bingWrite, httpUrl, page, readBack, requireWithinSite } from "./common";

// Facts: docs/VERIFICATION.md, "Blocking, URL parameters and country targeting (2026-11-10)". What the levels mean and when to
// use them comes from Microsoft's help page "Geo-Targeting Your Website".

const LEVELS = Object.keys(GEO_TYPES) as [GeoType, ...GeoType[]];
const countryCode = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "two letters")
  .refine((s) => ISO_COUNTRIES.has(s.toUpperCase()), "not an assigned ISO 3166-1 alpha-2 country code")
  .describe("Two-letter ISO 3166-1 country code, e.g. DE or US.");
const sameCode = (a: string | null, b: string) => (a ?? "").toUpperCase() === b.toUpperCase();
const levelOut = (s: CountrySetting) => s.type ?? `unknown (${s.typeValue ?? "missing"})`;

const SettingSchema = z.object({
  url: z.string().describe("The page, directory, subdomain or domain targeted (untrusted text from Bing)."),
  level: z.string().describe("page, directory, subdomain or domain; 'unknown (n)' for a value Microsoft does not document."),
  country_code: z.string().nullable().describe("Two-letter ISO country code as Bing reports it."),
  added_at: z.string().nullable().describe("Bing's Date for the entry (ISO instant)."),
});
const settingOut = (s: CountrySetting): z.infer<typeof SettingSchema> => ({ url: s.url, level: levelOut(s), country_code: s.countryCode, added_at: s.date });

const LEVEL_WORDS: Record<GeoType, string> = {
  domain: "the whole domain",
  subdomain: "the whole subdomain",
  directory: "the directory and every page in it",
  page: "this one page",
};

// ------------------------------------------------------------------------------------- list_bing_country_targeting
export const listBingCountryTargeting = bingRead({
  name: "list_bing_country_targeting",
  title: "List Bing country targeting",
  description:
    "Lists the country/region targeting (geo-targeting) entries of a Bing Webmaster site: which domain, subdomain, directory or page is marked as meant for an audience in which country (two-letter ISO code). Bing uses each entry as a strong hint, together with its other signals.",
  input: z.object({ account_id: accountId, limit: z.number().int().min(1).max(1000).default(200).describe("Most entries to return (sorted by URL).") }),
  output: z.object({ site_url: z.string(), settings: z.array(SettingSchema), returned: z.number(), total: z.number(), truncated: z.boolean() }),
  handler: async (a, ctx) => {
    const all = (await getCountrySettings(ctx.services.bing)).sort((x, y) => x.url.localeCompare(y.url) || (x.typeValue ?? 0) - (y.typeValue ?? 0));
    const p = page(all, a.limit);
    return { site_url: ctx.services.bing.siteUrl, settings: p.rows.map(settingOut), returned: p.returned, total: p.total, truncated: p.truncated };
  },
});

// -------------------------------------------------------------------------------------- add_bing_country_targeting
export const addBingCountryTargeting = bingWrite({
  name: "add_bing_country_targeting",
  title: "Target a country on Bing",
  risk: "high_impact",
  description:
    "After approval by a person, tells Bing that part of a Bing Webmaster site is meant for an audience in one country: the whole domain, a subdomain, a directory (URL ending with '/') or one page. Microsoft's help: use it only for content dedicated to one country that is not already on that country's own top-level domain (e.g. .de); not for content aimed at several countries; domain level works only on 'geo-targetable' domains such as .com, .org, .net. The URL must be inside the site. Refuses a URL and level that already have a country.",
  input: z.object({
    account_id: accountId,
    url: httpUrl.describe("The page, directory (ending with '/'), subdomain or domain root (e.g. https://nl.example.com/) to target. Must be inside the site."),
    level: z.enum(LEVELS).describe("domain, subdomain, directory or page (Bing's CountryRegionSettingsType)."),
    country_code: countryCode,
  }),
  output: z.object({ site_url: z.string(), setting: SettingSchema }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    requireWithinSite(bing.siteUrl, a.url, "URL");
    const u = new URL(a.url);
    if ((a.level === "domain" || a.level === "subdomain") && (u.pathname !== "/" || u.search)) throw new ToolError("invalid_argument", `A ${a.level} entry is the root of the host, e.g. ${u.origin}/.`, { definite: true });
    if (a.level === "directory" && (!u.pathname.endsWith("/") || u.search)) throw new ToolError("invalid_argument", "A directory URL must end with '/' and have no query string.", { definite: true });
    const all = await getCountrySettings(bing);
    const same = all.find((s) => s.url === a.url && s.type === a.level);
    if (same)
      throw new ToolError("invalid_argument", `${a.url} already targets ${same.countryCode ?? "a country"} on Bing at ${a.level} level. Nothing to add; to change the country, remove it first with remove_bing_country_targeting.`, { definite: true });
    const other = all.filter((s) => s.url === a.url).map((s) => `${levelOut(s)} → ${s.countryCode ?? "?"}`);
    const summary = [
      `Tell Bing that ${LEVEL_WORDS[a.level]} ${a.url} (site ${bing.siteUrl}) is meant for an audience in country ${a.country_code.toUpperCase()}.`,
      "Per Microsoft's help, Bing takes this as a strong signal on top of its other signals, which can change in which countries' results these pages rank. Use it only for content dedicated to that one country; not for content aimed at several countries.",
      a.level === "domain" ? "Domain-level targeting works only on geo-targetable domains such as .com, .org or .net; most country-code domains keep their own country." : null,
      other.length ? `The same URL already has: ${other.join(", ")}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const changes: Change[] = [{ resource: "bing_country_targeting", id: `${a.level}:${a.url}`, name: null, field: "country", before: null, after: a.country_code.toUpperCase(), unit: "text", effect: "create" }];
    return { summary, changes, snapshot: { site_url: bing.siteUrl, url: a.url, level: a.level, present: false } };
  },
  execute: async (a, ctx) => {
    const bing = ctx.services.bing;
    await addCountrySetting(bing, { url: a.url, type: a.level, countryCode: a.country_code });
    const got = (await readBack(() => getCountrySettings(bing))).find((s) => s.url === a.url && s.type === a.level && sameCode(s.countryCode, a.country_code));
    if (!got) throw new ToolError("unknown_outcome", "Bing accepted the request but the entry is not in the country/region settings. Check list_bing_country_targeting before trying again.");
    return { site_url: bing.siteUrl, setting: settingOut(got) };
  },
  verify: async (a, ctx) =>
    (await getCountrySettings(ctx.services.bing)).some((s) => s.url === a.url && s.type === a.level && sameCode(s.countryCode, a.country_code)) ? { outcome: "applied" } : { outcome: "not_applied" },
});

// ----------------------------------------------------------------------------------- remove_bing_country_targeting
const sameRow = (s: CountrySetting, raw: Row) => s.url === raw.Url && s.raw.Type === raw.Type && s.raw.TwoLetterIsoCountryCode === raw.TwoLetterIsoCountryCode;

export const removeBingCountryTargeting = bingWrite({
  name: "remove_bing_country_targeting",
  title: "Remove Bing country targeting",
  risk: "destructive",
  description:
    "After approval by a person, removes one country/region targeting entry of a Bing Webmaster site, so Bing no longer has this hint about the intended country of that domain, subdomain, directory or page. The URL must match an entry of list_bing_country_targeting exactly; give level and country_code too when the URL has several entries. The stored entry is sent back to Bing unchanged.",
  input: z.object({
    account_id: accountId,
    url: httpUrl.describe("The targeted URL exactly as list_bing_country_targeting shows it."),
    level: z.enum(LEVELS).optional().describe("Only needed when the URL has several entries."),
    country_code: countryCode.optional().describe("Only needed when the URL has several entries."),
  }),
  output: z.object({ site_url: z.string(), url: z.string(), removed: z.literal(true) }),
  plan: async (a, ctx) => {
    const bing = ctx.services.bing;
    const hits = (await getCountrySettings(bing)).filter((s) => s.url === a.url && (a.level === undefined || s.type === a.level) && (a.country_code === undefined || sameCode(s.countryCode, a.country_code)));
    if (!hits.length) throw new ToolError("not_found", `${a.url} has no matching country/region targeting entry on ${bing.siteUrl}. Use list_bing_country_targeting for the exact entries.`, { definite: true });
    if (hits.length > 1) throw new ToolError("invalid_argument", `${a.url} has ${hits.length} country/region entries; say which one with level and country_code.`, { definite: true });
    const s = hits[0]!;
    const changes: Change[] = [{ resource: "bing_country_targeting", id: `${levelOut(s)}:${s.url}`, name: null, field: "country", before: s.countryCode, after: null, unit: "text", effect: "remove" }];
    return {
      summary: `Remove Bing's country targeting of ${s.type ? LEVEL_WORDS[s.type] : "the entry"} ${s.url} (level ${levelOut(s)}, country ${s.countryCode ?? "unknown"}) on ${bing.siteUrl}. Bing then judges the intended country from its other signals only, which can change in which countries' results these pages rank.`,
      changes,
      snapshot: { site_url: bing.siteUrl, stored: s.raw },
    };
  },
  execute: async (_a, ctx, run) => {
    const bing = ctx.services.bing;
    const stored = (run.snapshot as { stored: Row }).stored;
    await removeCountrySetting(bing, stored);
    if ((await readBack(() => getCountrySettings(bing))).some((s) => sameRow(s, stored))) throw new ToolError("unknown_outcome", "Bing accepted the request but the entry is still listed. Check list_bing_country_targeting before trying again.");
    return { site_url: bing.siteUrl, url: stored.Url as string, removed: true as const };
  },
  verify: async (_a, ctx, run) => {
    const stored = (run.snapshot as { stored?: Row } | null)?.stored;
    if (!stored) return { outcome: "indeterminate", detail: "no stored entry to compare with" };
    return (await getCountrySettings(ctx.services.bing)).some((s) => sameRow(s, stored)) ? { outcome: "not_applied" } : { outcome: "applied" };
  },
});

export const geoTools: AnyTool[] = [listBingCountryTargeting, addBingCountryTargeting, removeBingCountryTargeting];
