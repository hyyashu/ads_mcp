import { describe, expect, it } from "vitest";
import { Gaql, lit } from "../../platforms/google/gaql";

/**
 * Experiment treatments are in-design (draft) campaigns, which Google returns only with PARAMETERS include_drafts = true
 * (experiments guide, system-managed). A query that names specific campaigns or ad groups must find them, so tools such as
 * update_campaign can make the change Google requires before an experiment can be scheduled. Lists stay as they were.
 */
describe("include_drafts on lookups", () => {
  const q = (g: Gaql) => g.toString();

  it("is added when a query names campaigns or ad groups by id or resource name", () => {
    expect(q(new Gaql().select("campaign.id").from("campaign").where(`campaign.id = ${lit.id("11")}`))).toMatch(/ PARAMETERS include_drafts = true$/);
    expect(q(new Gaql().select("campaign.id").from("campaign").where(`campaign.id IN ${lit.list(["11", "12"])}`))).toContain("PARAMETERS include_drafts = true");
    expect(q(new Gaql().select("ad_group.id").from("ad_group").where(`ad_group.id = ${lit.id("21")}`))).toContain("PARAMETERS include_drafts = true");
    expect(q(new Gaql().select("asset.id").from("campaign_asset").where(`campaign_asset.campaign = ${lit.str("customers/1/campaigns/11")}`))).toContain("PARAMETERS include_drafts = true");
    expect(q(new Gaql().select("ad_group_criterion.criterion_id").from("ad_group_criterion").where(`ad_group_criterion.ad_group = ${lit.str("customers/1/adGroups/21")}`))).toContain("PARAMETERS include_drafts = true");
  });

  it("is not added to reports (metrics or segments) or to the change history", () => {
    expect(q(new Gaql().select("campaign.id", "metrics.clicks").from("campaign").where(`campaign.id = ${lit.id("11")}`))).not.toContain("PARAMETERS");
    expect(q(new Gaql().select("campaign.id", "segments.device").from("campaign").where(`campaign.id = ${lit.id("11")}`))).not.toContain("PARAMETERS");
    expect(q(new Gaql().select("change_event.campaign").from("change_event").where(`change_event.campaign IN ${lit.list([lit.str("customers/1/campaigns/11")])}`))).not.toContain("PARAMETERS");
  });

  it("is not added to lists, or to lookups of other resources", () => {
    expect(q(new Gaql().select("campaign.id").from("campaign").where("campaign.status != 'REMOVED'"))).not.toContain("PARAMETERS");
    expect(q(new Gaql().select("label.id").from("label").where(`label.id = ${lit.id("5")}`))).not.toContain("PARAMETERS");
    // A campaign *name* in a string is not a lookup.
    expect(q(new Gaql().select("campaign.id").from("campaign").where(`campaign.name = ${lit.str("campaign.id = 1")}`))).not.toContain("PARAMETERS");
  });

  it("is not duplicated, and sits after LIMIT as the grammar requires", () => {
    const s = q(new Gaql().select("campaign.id").from("campaign").where(`campaign.id = ${lit.id("11")}`).limit(1).parameters("include_drafts = true"));
    expect(s.match(/include_drafts/g)).toHaveLength(1);
    expect(s).toMatch(/LIMIT 1 PARAMETERS include_drafts = true$/);
    expect(q(new Gaql().select("campaign.id").from("campaign").where(`campaign.id = ${lit.id("11")}`).parameters("omit_unselected_resource_names = true"))).toMatch(/PARAMETERS omit_unselected_resource_names = true, include_drafts = true$/);
  });
});
