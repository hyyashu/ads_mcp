import { describe, expect, it } from "vitest";
import { drainSchemaProblems, schemaChecked } from "./support/schema-guard";
import { SCHEMA_VERSION, checkBody, checkGaql, checkRequest, requestSchemaFor, resolveField } from "./support/google-schema";

describe("Google Ads v26 schema checker", () => {
  it("is built from v26", () => expect(SCHEMA_VERSION).toBe("v26"));

  it("resolves real fields and rejects invented ones", () => {
    expect(resolveField("campaign.advertising_channel_type")?.enum).toContain("SEARCH");
    expect(resolveField("campaign.network_settings.target_search_network")).not.toBeNull();
    expect(resolveField("metrics.cost_micros")).not.toBeNull();
    expect(resolveField("ad_group_criterion.keyword.match_type")?.enum).toContain("PHRASE");
    expect(resolveField("campaign.made_up_field")).toBeNull();
    expect(resolveField("not_a_resource.id")).toBeNull();
  });

  it("checks GAQL fields, resources and enum literals", () => {
    expect(checkGaql("SELECT campaign.id, metrics.clicks FROM campaign WHERE campaign.status != 'REMOVED' AND segments.date DURING LAST_7_DAYS")).toEqual([]);
    expect(checkGaql("SELECT campaign.id FROM campaign WHERE campaign.status = 'RUNNING'")).toEqual(["campaign.status: 'RUNNING' is not a valid value"]);
    expect(checkGaql("SELECT campaign.budget FROM campaign")).toEqual(["unknown field: campaign.budget"]);
    expect(checkGaql("SELECT x.id FROM nope")).toContain("unknown FROM resource: nope");
    // values inside string literals are not mistaken for fields
    expect(checkGaql("SELECT campaign.id FROM campaign WHERE campaign.name LIKE '%a.b%'")).toEqual([]);
  });

  it("checks which fields may be used with the FROM resource", () => {
    expect(checkGaql("SELECT ad_group.id, campaign.name, metrics.clicks FROM ad_group")).toEqual([]); // campaign is attributed to ad_group
    expect(checkGaql("SELECT campaign.id, ad_group.name FROM campaign")).toEqual(["ad_group.name cannot be used with FROM campaign"]);
    expect(checkGaql("SELECT label.id, metrics.clicks FROM label")).toEqual(["metrics.clicks cannot be used with FROM label"]);
    expect(checkGaql("SELECT hotel_group_view.resource_name FROM hotel_group_view")).toEqual(["no GAQL rules recorded for hotel_group_view: run scripts/fetch-google-gaql-rules.py v26 hotel_group_view"]);
  });

  it("checks mutate bodies recursively", () => {
    expect(requestSchemaFor("customers/1/campaigns:mutate")).toBe("Services__MutateCampaignsRequest");
    expect(requestSchemaFor("geoTargetConstants:suggest")).toBe("Services__SuggestGeoTargetConstantsRequest");
    expect(requestSchemaFor("customers/1:generateKeywordIdeas")).toBe("Services__GenerateKeywordIdeasRequest");
    expect(checkBody("Services__MutateCampaignsRequest", { operations: [{ update: { resourceName: "x", status: "PAUSED" }, updateMask: "status" }] })).toEqual([]);
    expect(checkBody("Services__MutateCampaignsRequest", { operations: [{ update: { resourceName: "x", status: "STOPPED" }, updateMask: "status" }] })).toEqual(["operations.update.status: 'STOPPED' is not a valid value"]);
    expect(checkBody("Services__MutateCampaignsRequest", { operations: [{ update: { budget: 5 } }] })).toEqual(["operations.update.budget: not a field of Resources__Campaign"]);
    expect(checkRequest("customers/1/notAService:mutate", {})).toEqual(["no request schema for customers/1/notAService:mutate"]);
  });

  it("the harness guard records bad requests and unrealistic fixture rows", async () => {
    const f = schemaChecked(async () => new Response(JSON.stringify({ results: [{ campaign: { id: "1", status: "RUNNING" } }] })));
    await (f as (u: string, i?: RequestInit) => Promise<Response>)("https://googleads.googleapis.com/v26/customers/1/googleAds:search", { method: "POST", body: JSON.stringify({ query: "SELECT campaign.nope FROM campaign" }) });
    expect(drainSchemaProblems()).toEqual(["GAQL: unknown field: campaign.nope", "fixture row: campaign.status: 'RUNNING' is not a valid value"]);
  });
});
