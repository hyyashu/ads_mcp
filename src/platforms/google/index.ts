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

/** Google Ads tools. A tool is added here only when it has a real handler, schemas and tests. */
export const googleTools: AnyTool[] = [...reportingTools, ...statusTools, ...settingsTools, ...keywordTools, ...negativeListTools, ...adTools, ...adContentTools, ...campaignReadTools, ...targetingReadTools, ...pmaxReadTools] as AnyTool[];
