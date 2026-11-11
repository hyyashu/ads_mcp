import type { AnyTool } from "../../mcp/tool";
import { blockingTools } from "./tools/blocking";
import { crawlTools } from "./tools/crawl";
import { fetchTools } from "./tools/fetch";
import { geoTools } from "./tools/geo";
import { indexingTools } from "./tools/indexing";
import { keywordTools } from "./tools/keywords";
import { linkTools } from "./tools/links";
import { paramTools } from "./tools/params";
import { performanceTools } from "./tools/performance";
import { sitemapTools } from "./tools/sitemaps";
import { sitesTools } from "./tools/sites";

/**
 * Bing Webmaster tools. A tool is added here only when it has a real handler, schemas and tests. add_bing_preview_block and
 * add_bing_sitelink_block are documented limitations (inventory/limitations.json): Microsoft does not document values they need.
 */
export const bingTools: AnyTool[] = [...sitesTools, ...performanceTools, ...keywordTools, ...indexingTools, ...fetchTools, ...crawlTools, ...sitemapTools, ...linkTools, ...blockingTools, ...paramTools, ...geoTools];
