import type { AnyTool } from "../mcp/tool";
import { crossTools } from "./cross";
import { propertyLinkTools } from "./cross/property-links";
import { ga4Tools } from "./ga4";
import { googleTools } from "./google";
import { gscTools } from "./gsc";
import { gtmTools } from "./gtm";
import { metaTools } from "./meta";

export const allTools = (): AnyTool[] => [...googleTools, ...metaTools, ...gscTools, ...ga4Tools, ...gtmTools, ...propertyLinkTools, ...crossTools];
