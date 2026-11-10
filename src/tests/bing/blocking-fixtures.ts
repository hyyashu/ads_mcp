import { BING_ERROR } from "../../platforms/bing/http";
import { type FakeBing, SITE, bingErr, wcfDay } from "./fake-bing";

/**
 * Stateful fake data for the blocking, URL parameter and country targeting methods, shaped like Bing's documented JSON
 * samples ({"d": ...}, "__type", PascalCase fields, WCF dates). PagePreview and DeepLinkBlock have no documented shape:
 * their rows here use plausible field names on purpose, since the tools must not rely on any of them.
 */
type Row = Record<string, any>;
const T = (name: string, ns = "Microsoft.Bing.Webmaster.Api") => `${name}:#${ns}`;

export const blockedRow = (url: string, o: { entity?: number; request?: number; days?: number } = {}): Row => ({
  __type: T("BlockedUrl"),
  Date: wcfDay("2026-10-01"),
  DaysToExpire: o.days ?? 51,
  EntityType: o.entity ?? 0,
  RequestType: o.request ?? 1,
  Url: url,
});
export const previewRow = (url: string): Row => ({ __type: T("PagePreview", "Microsoft.Bing.Webmaster.Shared.DataContracts"), Url: url, BlockReason: 1, BlockDate: wcfDay("2026-10-05") });
export const deepLinkRow = (deepLink: string, searchUrl = "", market = ""): Row => ({
  __type: T("DeepLinkBlock", "Microsoft.Bing.Webmaster.Shared.DataContracts"),
  Market: market,
  SearchUrl: searchUrl,
  DeepLinkUrl: deepLink,
  BlockDate: wcfDay("2026-10-07"),
});
export const paramRow = (p: string, enabled = true, source = 1): Row => ({ __type: T("QueryParameter"), Date: "/Date(1314031258933)/", IsEnabled: enabled, Parameter: p, Source: source });
export const geoRow = (url: string, type: number, code: string): Row => ({ __type: T("CountryRegionSettings"), Date: wcfDay("2026-09-01"), TwoLetterIsoCountryCode: code, Type: type, Url: url });

const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x));

export class SectionState {
  blocked: Row[] = [];
  previews: Row[] = [];
  deepLinks: Row[] = [];
  params: Row[] = [];
  geo: Row[] = [];
  /** Accept changes with {"d": null} but do not apply them (for unknown_outcome tests). */
  ignoreWrites = false;

  reset() {
    this.blocked = [blockedRow(`${SITE}old-page`), blockedRow(`${SITE}private/`, { entity: 1, request: 0, days: 12 })];
    this.previews = [previewRow(`${SITE}leak`)];
    this.deepLinks = [deepLinkRow(`${SITE}about`), deepLinkRow(`${SITE}jobs`, SITE, "en-US")];
    this.params = [paramRow("sessionid"), paramRow("cart", false)];
    this.geo = [geoRow(`${SITE}de/`, 1, "DE"), geoRow(`${SITE}fr/landing`, 0, "FR")];
    this.ignoreWrites = false;
  }

  install(fake: FakeBing) {
    const h = fake.handlers;
    const write = (fn: () => unknown) => (this.ignoreWrites ? undefined : fn());
    h.GetBlockedUrls = () => clone(this.blocked);
    h.AddBlockedUrl = (c) =>
      write(() => {
        const b = c.body!.blockedUrl;
        if (this.blocked.some((x) => x.Url === b.Url)) return bingErr(BING_ERROR.AlreadyExists, "AlreadyExists");
        this.blocked.push({ ...b, Date: wcfDay("2026-11-10"), DaysToExpire: 90 });
      });
    h.RemoveBlockedUrl = (c) =>
      write(() => {
        const b = c.body!.blockedUrl;
        const i = this.blocked.findIndex((x) => x.Url === b.Url && x.EntityType === b.EntityType && x.RequestType === b.RequestType);
        if (i < 0) return bingErr(BING_ERROR.NotFound, "NotFound");
        this.blocked.splice(i, 1);
      });
    h.GetActivePagePreviewBlocks = () => clone(this.previews);
    h.RemovePagePreviewBlock = (c) => write(() => void (this.previews = this.previews.filter((x) => x.Url !== c.body!.url)));
    h.GetDeepLinkBlocks = () => clone(this.deepLinks);
    h.RemoveDeepLinkBlock = (c) =>
      write(() => {
        const { market, searchUrl, deepLinkUrl } = c.body!;
        this.deepLinks = this.deepLinks.filter((x) => !(x.DeepLinkUrl === deepLinkUrl && x.SearchUrl === searchUrl && x.Market === market));
      });
    h.GetQueryParameters = () => clone(this.params);
    h.AddQueryParameter = (c) => write(() => void this.params.push(paramRow(c.body!.queryParameter, true, 0)));
    h.EnableDisableQueryParameter = (c) =>
      write(() => {
        const p = this.params.find((x) => x.Parameter === c.body!.queryParameter);
        if (!p) return bingErr(BING_ERROR.NotFound, "NotFound");
        p.IsEnabled = c.body!.isEnabled;
      });
    h.RemoveQueryParameter = (c) => write(() => void (this.params = this.params.filter((x) => x.Parameter !== c.body!.queryParameter)));
    h.GetCountryRegionSettings = () => clone(this.geo);
    h.AddCountryRegionSettings = (c) => write(() => void this.geo.push({ ...c.body!.settings, Date: wcfDay("2026-11-10") }));
    h.RemoveCountryRegionSettings = (c) =>
      write(() => {
        const s = c.body!.settings;
        this.geo = this.geo.filter((x) => !(x.Url === s.Url && x.Type === s.Type && x.TwoLetterIsoCountryCode === s.TwoLetterIsoCountryCode));
      });
  }
}
