import type { AnyTool } from "../mcp/tool";
import { googleTools } from "./google";
import { metaTools } from "./meta";

export const allTools = (): AnyTool[] => [...googleTools, ...metaTools];
