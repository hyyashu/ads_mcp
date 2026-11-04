import type { AnyTool } from "../../mcp/tool";
import { analysisTools } from "./tools/analysis";
import { assetTools } from "./tools/assets";
import { campaignTools } from "./tools/campaigns";
import { createTools } from "./tools/create";
import { editTools } from "./tools/edits";
import { helperTools } from "./tools/helpers";
import { leadTools } from "./tools/leads";
import { segmentTools } from "./tools/segments";
import { targetingTools } from "./tools/targeting";
import { performanceTools } from "./tools/performance";
import { structureTools } from "./tools/structure";

/** Meta Ads tools. A tool is added here only when it has a real handler, schemas and tests. */
export const metaTools: AnyTool[] = [...campaignTools, ...structureTools, ...performanceTools, ...assetTools, ...leadTools, ...targetingTools, ...segmentTools, ...analysisTools, ...helperTools, ...editTools, ...createTools] as AnyTool[];
