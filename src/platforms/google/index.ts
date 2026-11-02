import type { AnyTool } from "../../mcp/tool";
import { reportingTools } from "./tools/reporting";

/** Google Ads tools. A tool is added here only when it has a real handler, schemas and tests. */
export const googleTools: AnyTool[] = [...reportingTools] as AnyTool[];
