import type { AnyTool } from "../../mcp/tool";
import { getCampaignTraffic, getConversionEvents, getGoogleAdsTrafficInGa4, getLandingPagePerformance, getTrafficByChannel } from "./tools/fixed-reports";
import { runGa4FunnelReport } from "./tools/funnel";
import { getGa4Realtime, runGa4PivotReport } from "./tools/pivot-realtime";
import { getGa4Metadata, listGa4Properties } from "./tools/properties";
import { runGa4ReportTool } from "./tools/run-report";

/** GA4 tools. A tool is added here only when it has a real handler, schemas and tests. */
export const ga4Tools: AnyTool[] = [listGa4Properties, getGa4Metadata, runGa4ReportTool, getTrafficByChannel, getCampaignTraffic, getLandingPagePerformance, getGoogleAdsTrafficInGa4, getConversionEvents, runGa4PivotReport, getGa4Realtime, runGa4FunnelReport] as AnyTool[];
