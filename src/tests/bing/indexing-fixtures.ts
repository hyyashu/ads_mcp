import type { FakeBing } from "./fake-bing";
import { SITE, wcfDay } from "./fake-bing";

/**
 * A stateful stand-in for the index, submission and Fetch as Bingbot methods, answering in the shapes of Microsoft's JSON
 * samples ({"d": ...}, "__type", PascalCase, WCF dates). Quotas go down as submissions arrive; FetchUrl adds to the fetched list.
 */
export interface IndexState {
  urlInfo: Record<string, Record<string, unknown>>;
  traffic: Record<string, Record<string, unknown>>;
  /** Directory URL → pages of children (UrlInfo rows) and of traffic rows. */
  children: Record<string, { info: Record<string, unknown>[][]; traffic: Record<string, unknown>[][] }>;
  urlQuota: { DailyQuota: number; MonthlyQuota: number };
  contentQuota: { DailyQuota: number; MonthlyQuota: number };
  fetched: { Url: string; Date: string; Fetched: boolean; Expired: boolean }[];
  details: Record<string, { Url: string; Date: string; Status: string; Headers: string; Document: string }>;
  /** When true, FetchUrl answers success but records nothing (for unknown_outcome tests). */
  ignoreFetch: boolean;
  /** Submissions received, in order. */
  submitted: string[][];
  content: Record<string, unknown>[];
}

export const info = (url: string, o: Record<string, unknown> = {}) => ({
  __type: "UrlInfo:#Microsoft.Bing.Webmaster.Api",
  AnchorCount: 12,
  DiscoveryDate: wcfDay("2026-09-01"),
  DocumentSize: 5120,
  HttpStatus: 200,
  IsPage: true,
  LastCrawledDate: wcfDay("2026-11-01"),
  TotalChildUrlCount: 0,
  Url: url,
  ...o,
});
export const traffic = (url: string, clicks: number, impressions: number, isPage = true) => ({ __type: "UrlTrafficInfo:#Microsoft.Bing.Webmaster.Api", Clicks: clicks, Impressions: impressions, IsPage: isPage, Url: url });

export function newIndexState(): IndexState {
  return {
    urlInfo: {},
    traffic: {},
    children: {},
    urlQuota: { DailyQuota: 10, MonthlyQuota: 300 },
    contentQuota: { DailyQuota: 100, MonthlyQuota: 3000 },
    fetched: [],
    details: {},
    ignoreFetch: false,
    submitted: [],
    content: [],
  };
}

let clock = Date.parse("2026-11-10T08:00:00Z");
/** A WCF instant that increases on every call, like a server clock. */
export const wcfNow = () => `/Date(${(clock += 60_000)}-0700)/`;

export function installIndexHandlers(fake: FakeBing, s: IndexState) {
  const h = fake.handlers;
  h.GetUrlInfo = (c) => s.urlInfo[c.params.get("url") ?? ""];
  h.GetUrlTrafficInfo = (c) => s.traffic[c.params.get("url") ?? ""];
  h.GetChildrenUrlInfo = (c) => s.children[c.body!.url]?.info[c.body!.page] ?? [];
  h.GetChildrenUrlTrafficInfo = (c) => s.children[c.params.get("url") ?? ""]?.traffic[Number(c.params.get("page"))] ?? [];
  h.GetUrlSubmissionQuota = () => ({ __type: "UrlSubmissionQuota:#Microsoft.Bing.Webmaster.Api", ...s.urlQuota });
  h.GetContentSubmissionQuota = () => ({ __type: "ContentSubmissionQuota:#Microsoft.Bing.Webmaster.Api", ...s.contentQuota });
  const take = (q: { DailyQuota: number; MonthlyQuota: number }, n: number) => {
    q.DailyQuota -= n;
    q.MonthlyQuota -= n;
  };
  h.SubmitUrl = (c) => {
    s.submitted.push([c.body!.url]);
    take(s.urlQuota, 1);
  };
  h.SubmitUrlBatch = (c) => {
    s.submitted.push(c.body!.urlList);
    take(s.urlQuota, c.body!.urlList.length);
  };
  h.SubmitContent = (c) => {
    s.content.push(c.body!);
    take(s.contentQuota, 1);
  };
  h.FetchUrl = (c) => {
    if (!s.ignoreFetch) s.fetched.push({ Url: c.body!.url, Date: wcfNow(), Fetched: false, Expired: false });
  };
  h.GetFetchedUrls = () => s.fetched.map((f) => ({ __type: "FetchedUrl:#Microsoft.Bing.Webmaster.Api", ...f }));
  h.GetFetchedUrlDetails = (c) => {
    const d = s.details[c.params.get("url") ?? ""];
    return d ? { __type: "FetchedUrlDetails:#Microsoft.Bing.Webmaster.Api", ...d } : undefined;
  };
}

export const P = (path: string) => `${SITE}${path}`;
