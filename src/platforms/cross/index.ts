import type { AnyTool } from "../../mcp/tool";

/**
 * Combined tools: each joins data from more than one product (ads with Search Console, GA4 or Tag Manager). They obtain the
 * second product's clients through ctx.linked(platform) or ctx.accountFor(platform, id), never by building clients
 * themselves. A tool is added here only when it has a real handler, schemas and tests.
 */
export const crossTools: AnyTool[] = [] as AnyTool[];
