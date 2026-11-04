import type { AnyTool } from "../../mcp/tool";
import { reportingTools } from "./tools/reporting";
import { adContentTools } from "./tools/ad-content";
import { adTools } from "./tools/ads";
import { negativeListTools } from "./tools/negative-lists";
import { keywordTools } from "./tools/keywords";
import { settingsTools } from "./tools/settings";
import { statusTools } from "./tools/status";
import { campaignReadTools } from "./tools/campaign-reads";
import { targetingReadTools } from "./tools/targeting-reads";
import { pmaxReadTools } from "./tools/pmax-reads";
import { assetWriteTools } from "./tools/asset-writes";
import { campaignTargetingWriteTools } from "./tools/campaign-targeting-writes";
import { adGroupCriteriaWriteTools } from "./tools/ad-group-criteria-writes";
import { accountWriteTools } from "./tools/account-writes";
import { pmaxWriteTools } from "./tools/pmax-writes";
import { campaignCreateTools } from "./tools/campaign-create";
import { adGroupAdTools } from "./tools/ad-groups-ads";
import { listingTreeTools } from "./tools/listing-trees";

/** Google Ads tools. A tool is added here only when it has a real handler, schemas and tests. */
export const googleTools: AnyTool[] = [...reportingTools, ...statusTools, ...settingsTools, ...keywordTools, ...negativeListTools, ...adTools, ...adContentTools, ...campaignReadTools, ...targetingReadTools, ...pmaxReadTools, ...assetWriteTools, ...campaignTargetingWriteTools, ...adGroupCriteriaWriteTools, ...accountWriteTools, ...pmaxWriteTools, ...campaignCreateTools, ...adGroupAdTools, ...listingTreeTools] as AnyTool[];
