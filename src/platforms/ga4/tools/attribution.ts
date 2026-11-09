import { z } from "zod";
import { accountId, ga4Read } from "./common";

/**
 * get_ga4_attribution_settings: Admin API v1alpha properties.getAttributionSettings (alpha: Google may change it). Its own
 * file; combined tools must tolerate its absence. Enum values as listed on the v1alpha AttributionSettings page (2026-11-10).
 * An unknown value is passed through raw with null days, never a failure.
 */
const ACQ_DAYS: Record<string, number> = { ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_7_DAYS: 7, ACQUISITION_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS: 30 };
const OTHER_DAYS: Record<string, number> = { OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_30_DAYS: 30, OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_60_DAYS: 60, OTHER_CONVERSION_EVENT_LOOKBACK_WINDOW_90_DAYS: 90 };
const MODEL: Record<string, string> = {
  PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN: "Key events are credited by data-driven attribution across paid and organic channels",
  PAID_AND_ORGANIC_CHANNELS_LAST_CLICK: "Key events are credited to the last click across paid and organic channels",
  GOOGLE_PAID_CHANNELS_LAST_CLICK: "Key events are credited to the last click on a Google paid channel",
};
const EXPORT: Record<string, string> = {
  NOT_SELECTED_YET: "No channel scope has been chosen yet for conversions shared with linked Google Ads accounts",
  PAID_AND_ORGANIC_CHANNELS: "Linked Google Ads accounts receive conversions credited across paid and organic channels",
  GOOGLE_PAID_CHANNELS: "Linked Google Ads accounts receive only conversions credited to Google paid channels",
};

export const getGa4AttributionSettings = ga4Read({
  name: "get_ga4_attribution_settings",
  title: "GA4 attribution settings (alpha API)",
  description: "Fetched live from Google Analytics (Admin API v1alpha getAttributionSettings: Google's alpha API, may change). The property's reporting attribution model, key event lookback windows (acquisition and other) and which channels' conversions are shared with linked Google Ads accounts, with a plain-language explanation.",
  input: z.object({ account_id: accountId }),
  output: z.object({
    api_version: z.literal("v1alpha"),
    property: z.string(),
    reporting_attribution_model: z.string().nullable(),
    acquisition_lookback_days: z.number().int().nullable(),
    other_conversion_lookback_days: z.number().int().nullable(),
    ads_web_conversion_data_export_scope: z.string().nullable(),
    raw: z.object({ acquisition_lookback_window: z.string().nullable(), other_conversion_lookback_window: z.string().nullable() }),
    explanation: z.array(z.string()),
  }),
  handler: async (_a, ctx) => {
    const ga4 = ctx.services.ga4;
    const s = await ga4.getAttributionSettings();
    const acq = s.acquisitionConversionEventLookbackWindow ?? null;
    const other = s.otherConversionEventLookbackWindow ?? null;
    const acqDays = acq ? (ACQ_DAYS[acq] ?? null) : null;
    const otherDays = other ? (OTHER_DAYS[other] ?? null) : null;
    const model = s.reportingAttributionModel ?? null;
    const scope = s.adsWebConversionDataExportScope ?? null;
    const explanation: string[] = [];
    if (model) explanation.push(`${MODEL[model] ?? `Reporting attribution model: ${model}`}${otherDays ? `, looking back ${otherDays} days` : ""}.`);
    if (acqDays) explanation.push(`Acquisition key events look back ${acqDays} days.`);
    if (scope) explanation.push(`${EXPORT[scope] ?? `Ads conversion export scope: ${scope}`}.`);
    return {
      api_version: "v1alpha" as const,
      property: ga4.property,
      reporting_attribution_model: model,
      acquisition_lookback_days: acqDays,
      other_conversion_lookback_days: otherDays,
      ads_web_conversion_data_export_scope: scope,
      raw: { acquisition_lookback_window: acq, other_conversion_lookback_window: other },
      explanation,
    };
  },
});
