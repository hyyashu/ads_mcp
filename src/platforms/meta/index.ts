import type { AnyTool } from "../../mcp/tool";
import { campaignTools } from "./tools/campaigns";

/** Meta Ads tools. A tool is added here only when it has a real handler, schemas and tests. */
export const metaTools: AnyTool[] = [...campaignTools] as AnyTool[];
