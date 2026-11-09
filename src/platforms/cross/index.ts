import type { AnyTool } from "../../mcp/tool";
import { analyzeBrandSearchTrend, analyzePaidOrganicOverlap, findConvertingTermsWithoutContent, findOrganicKeywordGaps } from "./search";
import { auditAdLandingPages } from "./landing";

/**
 * Combined tools: each joins data from more than one product (ads with Search Console, GA4 or Tag Manager). They obtain the
 * second product's clients through ctx.linked(platform) or ctx.accountFor(platform, id), never by building clients
 * themselves. Rules, joins and caps: docs/superpowers/plans/2026-11-10-cross-plan.md.
 */
export const crossTools: AnyTool[] = [
  analyzePaidOrganicOverlap,
  findOrganicKeywordGaps,
  findConvertingTermsWithoutContent,
  analyzeBrandSearchTrend,
  auditAdLandingPages,
] as AnyTool[];
