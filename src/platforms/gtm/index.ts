import type { AnyTool } from "../../mcp/tool";
import { auditGtmContainer } from "./tools/audit";
import { getGtmLiveVersion, getGtmWorkspaceStatus, listGtmContainers, listGtmTags, listGtmTriggers, listGtmVariables } from "./tools/reads";
import { createGtmTag, updateGtmTag } from "./tools/tags";
import { createGtmTrigger } from "./tools/trigger";
import { createGtmVersion, publishGtmVersion } from "./tools/version";

/** Tag Manager tools. A tool is added here only when it has a real handler, schemas and tests. */
export const gtmTools: AnyTool[] = [
  listGtmContainers,
  getGtmLiveVersion,
  listGtmTags,
  listGtmTriggers,
  listGtmVariables,
  getGtmWorkspaceStatus,
  auditGtmContainer,
  createGtmTag,
  updateGtmTag,
  createGtmTrigger,
  createGtmVersion,
  publishGtmVersion,
] as AnyTool[];

/**
 * Audit helpers for the combined audit_tracking_setup tool (see the top of ./audit.ts for the API):
 * readLiveForAudit (containers.get + versions:live), recogniseGa4, recogniseGoogleAds, recogniseMetaPixel, customHtmlTags,
 * auditContainer. All recognition uses documented fields and snippets only.
 */
export { type AdsTag, type AuditResult, type LiveForAudit, type MetaPixelTag, auditContainer, customHtmlTags, readLiveForAudit, recogniseGa4, recogniseGoogleAds, recogniseMetaPixel } from "./audit";
export { measurementIds, metaPixel } from "./model";
