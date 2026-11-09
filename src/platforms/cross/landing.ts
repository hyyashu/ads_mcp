import { z } from "zod";
import { ToolError } from "../../mcp/errors";
import { fetchLandingPages, type Ga4Services } from "../ga4/api";
import type { GoogleServices } from "../google/services";
import { Gaql, fromMicros, num, pick } from "../google/gaql";
import { withinProperty } from "../gsc/tools/common";
import type { GscServices } from "../gsc/services";
import type { MetaServices } from "../meta/services";
import {
  ADS_ROW_CAP,
  ADWORDS,
  AccountOut,
  CoverageOut,
  GA4_READ,
  GSC_READ,
  META_AD_CAP,
  META_READ,
  PeriodOut,
  URL_RULE,
  type ZoneOf,
  accountInfo,
  adsBetween,
  capList,
  crossRead,
  datesMsg,
  datesOk,
  gaPath,
  idArg,
  landing,
  limitField,
  listOf,
  metaAds,
  newCoverage,
  optionalAccount,
  periodFields,
  r2,
  ratio,
  requiredAccount,
  resolveCrossPeriod,
  round,
} from "./common";

// audit_ad_landing_pages (design §5.5): ads' landing pages (Google Ads final URLs, optionally Meta creative links) joined
// with GA4 landing-page engagement and a quota-limited sample of Search Console URL inspections.

const GA4_CAP = 10_000;
const IndexOut = z.object({
  status: z.enum(["inspected", "not_sampled", "outside_site", "quota_reached", "error", "no_site"]),
  verdict: z.string().nullable(),
  coverage_state: z.string().nullable(),
  indexing_state: z.string().nullable(),
  page_fetch_state: z.string().nullable(),
  detail: z.string().nullable(),
});
const Ga4Page = z.object({ sessions: z.number().nullable(), engaged_sessions: z.number().nullable(), engagement_rate: z.number().nullable(), key_events: z.number().nullable(), session_key_event_rate: z.number().nullable().describe("GA4's own rate; null when several GA4 rows were merged into this page (rates cannot be added)."), total_revenue: z.number().nullable(), ga4_rows: z.number().int() });
const PageRow = z.object({
  url: z.string().describe("Landing URL without query string or fragment (untrusted text from the ad platforms)."),
  path: z.string(),
  google_ads: z.object({ ads: z.number().int(), impressions: z.number(), clicks: z.number(), cost: z.number() }).nullable(),
  meta_ads: z.object({ active_ads: z.number().int() }).nullable(),
  ga4: Ga4Page.nullable(),
  ga4_unmatched_reason: z.string().nullable(),
  path_shared_with_other_hosts: z.boolean().describe("Another host in this list has the same path, so they share GA4's figures (landingPage has no host)."),
  index: IndexOut,
});
type Page = z.infer<typeof PageRow>;

const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export const auditAdLandingPages = crossRead<GoogleServices>()("google_ads", [ADWORDS, GA4_READ, GSC_READ, META_READ], {
  name: "audit_ad_landing_pages",
  title: "Audit ad landing pages",
  description:
    "Lists the landing pages of this Google Ads account's ads (final URLs of ads with impressions in the period; optionally the links of a named Meta ad account's active ads) with what GA4 reports for each page (sessions, engagement rate, key events) and, for a sample, whether Google has the page indexed (Search Console URL inspection). URL inspection allows 2,000 calls per site per day, so only the top inspect_max pages by ad clicks are inspected and the rest are marked not_sampled. Says which pages GA4 has no data for and why.",
  input: z
    .object({
      account_id: z.string().min(1),
      property_account_id: idArg("GA4 property"),
      site_account_id: idArg("Search Console site for URL inspection (optional: without one, index status is skipped)"),
      meta_account_id: idArg("Meta ad account whose active ads' links to include (only when named: links do not connect a Meta account to a Google Ads account)"),
      ...periodFields,
      channel: z.string().min(1).max(100).optional().describe("Only GA4 sessions of this default channel group, e.g. 'Paid Search' (exact GA4 value). Default: all sessions."),
      inspect_max: z.number().int().min(0).max(50).default(10).describe("Most URLs to inspect (each uses one of the site's 2,000 daily inspections)."),
      limit: limitField,
    })
    .refine(datesOk, datesMsg),
  output: z.object({
    period: PeriodOut,
    accounts: z.array(AccountOut),
    rules: z.array(z.string()),
    coverage: CoverageOut,
    summary: z.object({ pages: z.number().int(), with_ga4_data: z.number().int(), without_ga4_data: z.number().int(), inspected: z.number().int(), not_indexed: z.number().int().describe("Inspected pages whose verdict is not PASS."), currency_code: z.string().nullable() }),
    pages: listOf(PageRow),
    unmatched: z.object({ urls_not_parsed: z.array(z.string()).max(50) }),
  }),
  handler: async (a, ctx) => {
    const own = ctx.account!;
    const prop = await requiredAccount<Ga4Services>(ctx, "google_analytics", a.property_account_id, "property_account_id");
    const site = await optionalAccount<GscServices>(ctx, "google_search_console", a.site_account_id, "site_account_id");
    const meta = a.meta_account_id ? await ctx.accountFor<MetaServices>("meta_ads", a.meta_account_id) : null;
    const zones: ZoneOf[] = [
      { source: "google_ads", account: own.externalId, time_zone: own.timeZone },
      { source: "google_analytics", account: prop.account.externalId, time_zone: prop.services.ga4.timeZone ?? prop.account.timeZone },
      ...(meta ? [{ source: "meta_ads", account: meta.account.externalId, time_zone: meta.account.timeZone }] : []),
    ];
    const period = await resolveCrossPeriod(a, zones);
    const coverage = newCoverage();
    const adsQ = new Gaql().select("ad_group_ad.ad.id", "ad_group_ad.ad.final_urls", "metrics.impressions", "metrics.clicks", "metrics.cost_micros").from("ad_group_ad").where(adsBetween(period)).where("ad_group_ad.status != 'REMOVED'").orderBy("metrics.clicks", "DESC").limit(ADS_ROW_CAP);
    const [adRows, ga4, metaRes] = await Promise.all([
      ctx.services.ads.query(adsQ, { maxRows: ADS_ROW_CAP }),
      fetchLandingPages(prop.services.ga4, { period: { date_range: "LAST_28_DAYS", start_date: period.start_date, end_date: period.end_date }, ...(a.channel ? { channel: a.channel } : {}), limit: GA4_CAP }),
      meta ? metaAds(meta.services.meta) : Promise.resolve(null),
    ]);

    const pages = new Map<string, Page>();
    const unparsed = new Set<string>();
    const pageFor = (url: string): Page | null => {
      const l = landing(url);
      if (!l) {
        unparsed.add(url.slice(0, 300));
        return null;
      }
      const key = `${l.host}${l.path}`;
      let p = pages.get(key);
      if (!p) {
        p = { url: l.clean_url, path: l.path, google_ads: null, meta_ads: null, ga4: null, ga4_unmatched_reason: null, path_shared_with_other_hosts: false, index: { status: "no_site", verdict: null, coverage_state: null, indexing_state: null, page_fetch_state: null, detail: null } };
        pages.set(key, p);
      }
      return p;
    };
    for (const r of adRows) {
      const urls = (pick(r, "ad_group_ad.ad.final_urls") as unknown[] | undefined) ?? [];
      // An ad's clicks are counted once, on its first final URL (the one Google uses unless a mobile URL or experiment applies).
      const first = urls.find((u): u is string => typeof u === "string");
      if (!first) continue;
      const p = pageFor(first);
      if (!p) continue;
      p.google_ads ??= { ads: 0, impressions: 0, clicks: 0, cost: 0 };
      p.google_ads.ads++;
      p.google_ads.impressions += num(pick(r, "metrics.impressions"));
      p.google_ads.clicks += num(pick(r, "metrics.clicks"));
      p.google_ads.cost = r2(p.google_ads.cost + fromMicros(pick(r, "metrics.cost_micros")));
    }
    coverage.sources.push({ source: "google_ads ads (final URLs)", rows_read: adRows.length, complete: adRows.length < ADS_ROW_CAP, note: adRows.length < ADS_ROW_CAP ? null : "Only the 10,000 ads with the most clicks were read." });
    if (metaRes) {
      let active = 0;
      for (const ad of metaRes.ads) {
        if (ad.effective_status !== "ACTIVE" || !ad.link) continue;
        active++;
        const p = pageFor(ad.link);
        if (!p) continue;
        p.meta_ads ??= { active_ads: 0 };
        p.meta_ads.active_ads++;
      }
      coverage.sources.push({ source: "meta_ads ads (creative links)", rows_read: metaRes.ads.length, complete: !metaRes.truncated, note: `${active} ads are ACTIVE now with a link (status today, not over the period).${metaRes.truncated ? ` Only the first ${META_AD_CAP} ads were read.` : ""}` });
    } else coverage.not_checked.push({ source: "meta_ads", reason: "No meta_account_id given (a Meta ad account is not linked to a Google Ads account, so it must be named)." });

    // GA4 rows by normalised path (several rows can fold into one: trailing slash, encoding)
    const byPath = new Map<string, NonNullable<Page["ga4"]>>();
    for (const r of ga4.rows) {
      const p = gaPath(r.landing_page);
      if (!p) continue;
      const cur = byPath.get(p);
      if (!cur) {
        byPath.set(p, { sessions: r.sessions, engaged_sessions: r.engaged_sessions, engagement_rate: r.engagement_rate, key_events: r.key_events, session_key_event_rate: r.session_key_event_rate, total_revenue: r.total_revenue, ga4_rows: 1 });
        continue;
      }
      const add = (x: number | null, y: number | null) => (x === null || y === null ? null : x + y);
      cur.sessions = add(cur.sessions, r.sessions);
      cur.engaged_sessions = add(cur.engaged_sessions, r.engaged_sessions);
      cur.key_events = add(cur.key_events, r.key_events);
      cur.total_revenue = add(cur.total_revenue, r.total_revenue);
      cur.engagement_rate = cur.sessions !== null && cur.engaged_sessions !== null ? round(ratio(cur.engaged_sessions, cur.sessions)) : null;
      cur.session_key_event_rate = null;
      cur.ga4_rows++;
    }
    coverage.sources.push({ source: "google_analytics landing pages", rows_read: ga4.returned, complete: !ga4.truncated, note: ga4.truncated ? `GA4 has ${ga4.row_count} landing-page rows; the ${ga4.returned} with the most sessions were read, so a page past them shows as without GA4 data.` : null });
    coverage.notes.push(...ga4.data_quality.notes, ...(ga4.note ? [ga4.note] : []));

    const list = [...pages.values()];
    const pathCount = new Map<string, number>();
    for (const p of list) pathCount.set(p.path, (pathCount.get(p.path) ?? 0) + 1);
    for (const p of list) {
      p.path_shared_with_other_hosts = (pathCount.get(p.path) ?? 0) > 1;
      p.ga4 = byPath.get(p.path) ?? null;
      if (!p.ga4) p.ga4_unmatched_reason = ga4.truncated ? "No GA4 row among the rows read (GA4 has more landing pages than were read)." : `GA4 recorded no session starting on this path in the period${a.channel ? ` in channel "${a.channel}"` : ""} (or the site records a different path, e.g. after a redirect).`;
    }
    list.sort((x, y) => (y.google_ads?.clicks ?? 0) - (x.google_ads?.clicks ?? 0) || (y.meta_ads?.active_ads ?? 0) - (x.meta_ads?.active_ads ?? 0) || x.url.localeCompare(y.url));
    if (list.some((p) => p.path_shared_with_other_hosts)) coverage.notes.push("Some paths appear on more than one host; GA4's landingPage has no host, so those pages show the same GA4 figures.");

    // URL inspection sample
    let inspected = 0;
    if (!site) coverage.not_checked.push({ source: "google_search_console URL inspection", reason: "No Search Console site is linked to this Google Ads account (or named)." });
    else {
      const gsc = site.services.gsc;
      let budget = a.inspect_max;
      let stop: "quota_reached" | "error" | null = null;
      let stopDetail: string | null = null;
      for (const p of list) {
        if (!withinProperty(gsc.siteUrl, p.url)) {
          p.index = { ...p.index, status: "outside_site", detail: `Not part of ${gsc.siteUrl}.` };
          continue;
        }
        if (stop) {
          p.index = { ...p.index, status: stop, detail: stopDetail };
          continue;
        }
        if (budget <= 0) {
          p.index = { ...p.index, status: "not_sampled", detail: null };
          continue;
        }
        budget--;
        try {
          const r = await gsc.inspectUrl(p.url);
          const idx = o(r.indexStatusResult);
          p.index = { status: "inspected", verdict: s(idx.verdict), coverage_state: s(idx.coverageState), indexing_state: s(idx.indexingState), page_fetch_state: s(idx.pageFetchState), detail: null };
          inspected++;
        } catch (e) {
          if (!(e instanceof ToolError)) throw e;
          if (e.code === "quota_exceeded") {
            stop = "quota_reached";
            stopDetail = "Search Console's URL inspection quota (2,000 per site per day, 600 per minute) was reached; not inspected.";
            p.index = { ...p.index, status: stop, detail: stopDetail };
          } else if (e.code === "platform_permission_denied" || e.code === "auth_expired") {
            stop = "error";
            stopDetail = `Inspection stopped: ${e.message}`;
            p.index = { ...p.index, status: stop, detail: stopDetail };
          } else p.index = { ...p.index, status: "error", detail: e.message };
        }
      }
      coverage.sources.push({ source: "google_search_console URL inspection (sample)", rows_read: inspected, complete: false, note: `Sampled: the top ${a.inspect_max} pages inside the site by ad clicks are inspected; ${list.filter((p) => p.index.status === "not_sampled").length} were not sampled.${stop === "quota_reached" ? " The inspection quota was reached during this call." : ""}` });
    }
    return {
      period,
      accounts: [accountInfo("google_ads", own), accountInfo("ga4_property", prop.account), ...(site ? [accountInfo("search_console_site", site.account)] : []), ...(meta ? [accountInfo("meta_ads", meta.account)] : [])],
      rules: [
        URL_RULE,
        "Google Ads: ads not removed with impressions in the period; each ad counts once, on its first final URL.",
        ...(meta ? ["Meta: ads whose status is ACTIVE now, with a link in object_story_spec or asset_feed_spec."] : []),
        `GA4: landingPage rows for the period${a.channel ? `, channel group "${a.channel}"` : ", all channels"}; folded rows add sessions, engaged sessions, key events and revenue, and recompute engagement rate as engaged / sessions.`,
        "Index status: Search Console's indexed version (not a live test); verdict PASS means indexed.",
      ],
      coverage,
      summary: { pages: list.length, with_ga4_data: list.filter((p) => p.ga4).length, without_ga4_data: list.filter((p) => !p.ga4).length, inspected, not_indexed: list.filter((p) => p.index.status === "inspected" && p.index.verdict !== "PASS").length, currency_code: own.currencyCode },
      pages: capList(list, a.limit),
      unmatched: { urls_not_parsed: [...unparsed].slice(0, 50) },
    };
  },
});
