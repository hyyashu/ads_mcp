import type { AnyTool } from "../../../mcp/tool";
import { biddingAdjustmentTools } from "./bidding-adjustments";
import { biddingPortfolioTools } from "./bidding-portfolio";
import { experimentTools } from "./experiments";

/**
 * Google Ads tools: list_bid_strategies, create_bid_strategy, assign_bid_strategy, remove_bid_strategy, list_bidding_adjustments, create_seasonality_adjustment, create_data_exclusion, remove_bidding_adjustment, list_experiments, create_experiment, schedule_experiment, end_experiment, promote_experiment.
 * Approved by the owner on 2026-11-11 (inventory/tool-registry.json); API surfaces in inventory/mapping.ts.
 * Portfolio strategies: bidding-portfolio.ts; seasonality adjustments and data exclusions: bidding-adjustments.ts; experiments: experiments.ts.
 */
export const biddingExperimentTools: AnyTool[] = [...biddingPortfolioTools, ...biddingAdjustmentTools, ...experimentTools] as AnyTool[];
