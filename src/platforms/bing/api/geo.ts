import { type BingClient, type Row, asList, bingDate, num } from "../client";
import { SAMPLE_UNSET_DATE } from "./blocking";

/**
 * Country/region targeting ("Geo-Targeting" in the portal). Facts: docs/VERIFICATION.md, "Blocking, URL parameters and country
 * targeting (2026-11-10)".
 *
 * - GetCountryRegionSettings(siteUrl) GET → CountryRegionSettings[] {Date, TwoLetterIsoCountryCode, Type, Url}.
 *   CountryRegionSettingsType: Page 0, Directory 1, Domain 2, Subdomain 3.
 * - AddCountryRegionSettings / RemoveCountryRegionSettings(siteUrl, settings: CountryRegionSettings) POST. Their pages carry no
 *   JSON sample; the body follows the other data-contract samples ("__type": "<Name>:#Microsoft.Bing.Webmaster.Api").
 */
export const GEO_TYPES = { page: 0, directory: 1, domain: 2, subdomain: 3 } as const;
export type GeoType = keyof typeof GEO_TYPES;

/** ISO 3166-1 alpha-2 officially assigned codes (what TwoLetterIsoCountryCode names). Bing's own accepted subset is not documented. */
export const ISO_COUNTRIES = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI " +
    "CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR " +
    "GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU " +
    "LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL " +
    "PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO " +
    "TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
);

export interface CountrySetting {
  url: string;
  type: GeoType | null;
  typeValue: number | null;
  /** As Bing returned it. Compare without case: the expected case is not documented. */
  countryCode: string | null;
  date: string | null;
  /** The row exactly as Bing returned it: RemoveCountryRegionSettings gets it back unchanged. */
  raw: Row;
}

export function parseCountrySettings(d: unknown): CountrySetting[] {
  return asList(d, "the country/region settings")
    .filter((r) => typeof r.Url === "string" && r.Url !== "")
    .map((r) => {
      const n = num(r.Type);
      const type = (Object.entries(GEO_TYPES).find(([, v]) => v === n)?.[0] as GeoType | undefined) ?? null;
      return { url: r.Url as string, type, typeValue: n, countryCode: typeof r.TwoLetterIsoCountryCode === "string" ? r.TwoLetterIsoCountryCode : null, date: bingDate(r.Date), raw: r };
    });
}

/** GetCountryRegionSettings: the site's country/region targeting entries. */
export async function getCountrySettings(bing: BingClient): Promise<CountrySetting[]> {
  return parseCountrySettings(await bing.read("GetCountryRegionSettings"));
}

/** AddCountryRegionSettings with a new CountryRegionSettings. The country code is sent upper case (ISO 3166-1 form). */
export async function addCountrySetting(bing: BingClient, s: { url: string; type: GeoType; countryCode: string }): Promise<void> {
  await bing.send("AddCountryRegionSettings", {
    settings: { __type: "CountryRegionSettings:#Microsoft.Bing.Webmaster.Api", Date: SAMPLE_UNSET_DATE, TwoLetterIsoCountryCode: s.countryCode.toUpperCase(), Type: GEO_TYPES[s.type], Url: s.url },
  });
}

/** RemoveCountryRegionSettings with the stored settings exactly as GetCountryRegionSettings returned them. */
export async function removeCountrySetting(bing: BingClient, stored: Row): Promise<void> {
  await bing.send("RemoveCountryRegionSettings", { settings: stored });
}
