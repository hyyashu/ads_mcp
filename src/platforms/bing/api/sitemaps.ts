import { type BingClient, asList, bingDate, bool, num, str } from "../client";

/**
 * Sitemaps ("feeds" in the Bing API). Facts: docs/VERIFICATION.md, "Crawl, sitemaps and backlinks (2026-11-10)".
 *
 * - GetFeeds(siteUrl) → Feed[]: "Return all top-level feeds for the site".
 * - GetFeedDetails(siteUrl, feedUrl) → Feed[]: "Get feed details for sitemap indices".
 * - Feed {Compressed bool, FileSize Int64, LastCrawled DateTime, Status string, Submitted DateTime, Type string, Url string,
 *   UrlCount Int32}. No descriptions; sample Status "Success", Type "Sitemap".
 * - SubmitFeed(siteUrl, feedUrl) POST, {"d": null}. "Supported formats: Sitemap, RSS 2.0, Atom 0.3, Atom 1.0 and text files."
 * - RemoveFeed(siteUrl, feedUrl) POST, {"d": null}.
 *
 * feedUrl in a GET goes as a plain query value (the XML sample's form, and how siteUrl travels in every sample); the JSON
 * sample's JSON-quoted form is not used (see VERIFICATION.md).
 */
export interface BingFeed {
  url: string;
  type: string | null;
  status: string | null;
  urlCount: number | null;
  fileSize: number | null;
  compressed: boolean | null;
  submitted: string | null;
  lastCrawled: string | null;
}

export const parseFeeds = (d: unknown, what: string): BingFeed[] =>
  asList(d, what)
    .filter((f) => typeof f.Url === "string" && f.Url !== "")
    .map((f) => ({ url: f.Url as string, type: str(f.Type), status: str(f.Status), urlCount: num(f.UrlCount), fileSize: num(f.FileSize), compressed: bool(f.Compressed), submitted: bingDate(f.Submitted), lastCrawled: bingDate(f.LastCrawled) }));

/** GetFeeds: the site's top-level sitemaps and feeds. */
export async function getFeeds(bing: BingClient): Promise<BingFeed[]> {
  return parseFeeds(await bing.read("GetFeeds"), "the sitemap list");
}

/** GetFeedDetails: the entries Bing reports for one sitemap (for a sitemap index, the sitemaps inside it). */
export async function getFeedDetails(bing: BingClient, feedUrl: string): Promise<BingFeed[]> {
  return parseFeeds(await bing.read("GetFeedDetails", { feedUrl }), "the sitemap details");
}

/** SubmitFeed: one POST, never retried. */
export async function submitFeed(bing: BingClient, feedUrl: string): Promise<void> {
  await bing.send("SubmitFeed", { feedUrl });
}

/** RemoveFeed: one POST, never retried. */
export async function removeFeed(bing: BingClient, feedUrl: string): Promise<void> {
  await bing.send("RemoveFeed", { feedUrl });
}
