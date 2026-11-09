import type { AnyTool } from "../../mcp/tool";
import { getGa4Metadata, listGa4Properties } from "./tools/properties";
import { runGa4ReportTool } from "./tools/run-report";

/** GA4 tools. A tool is added here only when it has a real handler, schemas and tests. */
export const ga4Tools: AnyTool[] = [listGa4Properties, getGa4Metadata, runGa4ReportTool] as AnyTool[];
