import type { AnyTool } from "../../mcp/tool";
import { inspectUrl } from "./tools/inspection";
import { listSitemaps } from "./tools/sitemaps";
import { listGscSites } from "./tools/sites";

/** Search Console tools. A tool is added here only when it has a real handler, schemas and tests. */
export const gscTools: AnyTool[] = [listGscSites, listSitemaps, inspectUrl] as AnyTool[];
