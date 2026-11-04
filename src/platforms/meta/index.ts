import type { AnyTool } from "../../mcp/tool";
import { campaignTools } from "./tools/campaigns";
import { performanceTools } from "./tools/performance";
import { structureTools } from "./tools/structure";

/** Meta Ads tools. A tool is added here only when it has a real handler, schemas and tests. */
export const metaTools: AnyTool[] = [...campaignTools, ...structureTools, ...performanceTools] as AnyTool[];
