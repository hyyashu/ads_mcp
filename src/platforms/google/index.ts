import type { AnyTool } from "../../mcp/tool";
import { reportingTools } from "./tools/reporting";
import { keywordTools } from "./tools/keywords";
import { settingsTools } from "./tools/settings";
import { statusTools } from "./tools/status";

/** Google Ads tools. A tool is added here only when it has a real handler, schemas and tests. */
export const googleTools: AnyTool[] = [...reportingTools, ...statusTools, ...settingsTools, ...keywordTools] as AnyTool[];
