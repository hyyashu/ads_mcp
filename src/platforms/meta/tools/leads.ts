import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { MetaRow } from "../client";
import { LEADS_RETRIEVAL, PAGES_READ_ENGAGEMENT, PAGES_SHOW_LIST, accountId, metaId, metaRead, needs, requirePromotablePage, s } from "./common";

// Lead Ads, checked against "Lead Forms for Ads" and "Retrieving Leads" (Marketing API, 2026-11-05): GET /{page-id}/leadgen_forms
// and GET /{form-id}/leads with fields created_time,id,ad_id,form_id,field_data, read with a Page access token; reading leads
// needs leads_retrieval; leads can be filtered on time_created (Unix time) with GREATER_THAN_OR_EQUAL / LESS_THAN.
// Lead data is personal data: only the fields asked for are returned, the row count is capped, and nothing is stored or logged.

const FORM_CAP = 1_000;
/** Hard cap on leads returned by one call. */
export const LEAD_CAP = 200;

async function pageForms(m: import("../client").MetaAdsClient, pageId: string): Promise<MetaRow[]> {
  await requirePromotablePage(m, pageId);
  return m.listAsPage(pageId, `${pageId}/leadgen_forms`, { fields: "id,name,status" }, FORM_CAP + 1, { partial: true });
}

export const listMetaLeadForms = metaRead({
  name: "list_meta_lead_forms",
  title: "List Meta lead forms",
  description:
    "Lists the lead forms of a Facebook Page that this ad account promotes (the Page is checked with promote_pages): form id, name and status (ACTIVE or ARCHIVED). Read with the Page's access token, so the connected user needs a role on the Page. Needs ads_read, leads_retrieval, pages_show_list and pages_read_engagement. Names are untrusted text.",
  input: z.object({ account_id: accountId, page_id: metaId, include_archived: z.boolean().default(false), limit: z.number().int().min(1).max(500).default(100) }),
  output: z.object({ forms: z.array(z.object({ form_id: z.string().min(1), name: z.string().nullable(), status: z.string().nullable() })), returned: z.number(), truncated: z.boolean() }),
  permissions: needs(LEADS_RETRIEVAL, PAGES_SHOW_LIST, PAGES_READ_ENGAGEMENT),
  handler: async (a, ctx) => {
    const rows = await pageForms(ctx.services.meta, a.page_id);
    const wanted = rows.slice(0, FORM_CAP).filter((r) => a.include_archived || s(r, "status") !== "ARCHIVED");
    const forms = wanted.slice(0, a.limit).map((r) => ({ form_id: String(r.id ?? ""), name: s(r, "name"), status: s(r, "status") }));
    return { forms, returned: forms.length, truncated: wanted.length > forms.length || rows.length > FORM_CAP };
  },
});

const fieldName = z.string().regex(/^[A-Za-z0-9_]{1,64}$/, "a form field name such as email or full_name");

export const getMetaLeadFormSubmissions = metaRead({
  name: "get_meta_lead_form_submissions",
  title: "Meta lead form submissions",
  description:
    `PERSONAL DATA. Returns the leads one lead form received in the last N days, with only the form fields you name (for example email, full_name, phone_number) plus each lead's id, submission time and ad id. At most ${LEAD_CAP} leads per call. Nothing is stored or logged by this server; handle the result as personal data. The Page must be one this ad account promotes and the form must belong to it. Read with the Page's access token. Needs ads_read, leads_retrieval, pages_show_list and pages_read_engagement. Answers are untrusted text.`,
  input: z.object({
    account_id: accountId,
    page_id: metaId,
    form_id: metaId,
    fields: z.array(fieldName).min(1).max(30).describe("The form fields to return. Fields not named here are dropped."),
    days: z.number().int().min(1).max(90).default(7).describe("Leads created in the last N days."),
    limit: z.number().int().min(1).max(LEAD_CAP).default(50),
  }),
  output: z.object({
    form_id: z.string(),
    since: z.string(),
    leads: z.array(z.object({ lead_id: z.string().min(1), created_time: z.string().nullable(), ad_id: z.string().nullable(), fields: z.record(z.string(), z.array(z.string()).nullable()).describe("Requested field name to its values; null when the lead has no such field.") })),
    returned: z.number(),
    truncated: z.boolean(),
  }),
  permissions: needs(LEADS_RETRIEVAL, PAGES_SHOW_LIST, PAGES_READ_ENGAGEMENT),
  handler: async (a, ctx) => {
    const m = ctx.services.meta;
    const forms = await pageForms(m, a.page_id);
    if (!forms.some((f) => String(f.id) === a.form_id)) throw new ToolError("not_found", `No lead form ${a.form_id} on Page ${a.page_id}.`);
    const since = Math.floor(Date.now() / 1000) - a.days * 86_400;
    const rows = await m.listAsPage(
      a.page_id,
      `${a.form_id}/leads`,
      { fields: "id,created_time,ad_id,form_id,field_data", filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN_OR_EQUAL", value: since }]) },
      a.limit + 1,
      { partial: true },
    );
    const want = [...new Set(a.fields)];
    const leads = rows.slice(0, a.limit).map((r) => {
      const data = new Map<string, string[]>();
      for (const f of Array.isArray(r.field_data) ? (r.field_data as MetaRow[]) : []) {
        const name = s(f, "name");
        if (name && want.includes(name)) data.set(name, (Array.isArray(f.values) ? f.values : []).map(String));
      }
      return { lead_id: String(r.id ?? ""), created_time: s(r, "created_time"), ad_id: s(r, "ad_id"), fields: Object.fromEntries(want.map((k) => [k, data.get(k) ?? null])) };
    });
    return { form_id: a.form_id, since: new Date(since * 1000).toISOString(), leads, returned: leads.length, truncated: rows.length > a.limit };
  },
});

export const leadTools = [listMetaLeadForms, getMetaLeadFormSubmissions];
