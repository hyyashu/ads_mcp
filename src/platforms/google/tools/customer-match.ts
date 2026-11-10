import { createHash } from "node:crypto";
import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, pick } from "../gaql";
import { accountId, googleWrite, idSchema, str } from "./common";
import { rn } from "./write-kit";

/**
 * Customer Match member uploads (OfflineUserDataJobService), following
 * https://developers.google.com/google-ads/api/docs/remarketing/audience-segments/customer-match/get-started and
 * .../customer-match/manage.
 *
 * Privacy: raw emails and phone numbers never leave the input parser. The input schema normalizes and SHA-256 hashes
 * them while it parses, so the arguments that are stored with the approval, compared, logged or sent to Google contain
 * only the hashes. Summaries, change sets and results carry counts and the list name, never identifiers.
 */

// ------------------------------------------------------------------------------------------------ normalization
// Google's rules (get-started guide, "Upload user contact information" and "Email address formatting"): trim leading and
// trailing whitespace, lowercase, phone numbers in E.164; for gmail.com and googlemail.com also remove every "." and
// everything from the first "+" in the username. The digest is SHA-256 of the UTF-8 bytes as 64 lowercase hex characters.
const ASCII_SPACE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The normalized email Google hashes, or null when the value is not an email address. */
export function normalizeEmail(raw: string): string | null {
  const e = raw.replace(ASCII_SPACE, "").toLowerCase();
  if (!EMAIL.test(e)) return null;
  const at = e.indexOf("@");
  let user = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") user = user.replace(/\./g, "").replace(/\+.*$/, "");
  return user ? `${user}@${domain}` : null;
}

/**
 * The E.164 form of a phone number ("+" and 7 to 15 digits, no leading zero), or null. Spaces, dashes, dots and
 * parentheses used as formatting are removed; anything else is refused rather than guessed (a number without its
 * country code cannot be converted to E.164 reliably).
 */
export function normalizePhone(raw: string): string | null {
  const p = raw.replace(/[\s\-().]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(p) ? p : null;
}

/** SHA-256 of the UTF-8 bytes, as 64 lowercase hex characters. */
export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "a SHA-256 digest as 64 lowercase hex characters");
/** A member as stored: hashes only. Callers may also send hashes they computed with Google's normalization rules. */
const hashedMember = z
  .object({
    hashed_email: hex64.optional().describe("SHA-256 of the normalized email (see the tool description), lowercase hex."),
    hashed_phone_number: hex64.optional().describe("SHA-256 of the E.164 phone number, lowercase hex."),
  })
  .strict()
  .refine((m) => m.hashed_email !== undefined || m.hashed_phone_number !== undefined, "give at least one identifier");
/** A member as a person gives it. Normalized and hashed while the input is parsed; the raw values are not kept. */
const rawMember = z
  .object({
    email: z.string().max(320).optional().describe("Email address. Normalized and hashed on the server before anything is stored or sent."),
    phone: z.string().max(40).optional().describe("Phone number in E.164 form with country code, e.g. +14155550123 (spaces, dashes and parentheses are ignored). Hashed on the server."),
  })
  .strict()
  .superRefine((m, ctx) => {
    // Messages never include the value: these inputs are personal data.
    if (m.email === undefined && m.phone === undefined) ctx.addIssue({ code: "custom", message: "give an email, a phone number or both" });
    if (m.email !== undefined && normalizeEmail(m.email) === null) ctx.addIssue({ code: "custom", path: ["email"], message: "not a valid email address" });
    if (m.phone !== undefined && normalizePhone(m.phone) === null) ctx.addIssue({ code: "custom", path: ["phone"], message: "not an E.164 phone number (+ country code and number)" });
  })
  .transform((m) => ({
    ...(m.email !== undefined ? { hashed_email: sha256Hex(normalizeEmail(m.email)!) } : {}),
    ...(m.phone !== undefined ? { hashed_phone_number: sha256Hex(normalizePhone(m.phone)!) } : {}),
  }));
/** Hashed first, so stored arguments (hashes only) parse again unchanged when the approved change is executed. */
export const memberSchema = z.union([hashedMember, rawMember]);
type Member = { hashed_email?: string | undefined; hashed_phone_number?: string | undefined };

// --------------------------------------------------------------------------------------------------- the list
interface CrmList {
  id: string;
  name: string;
  type: string | null;
  upload_key_type: string | null;
  access_reason: string | null;
  read_only: boolean;
  membership_status: string | null;
}
async function readCrmList(ads: GoogleAdsClient, id: string): Promise<CrmList> {
  const [r] = await ads.query(
    new Gaql()
      .select("user_list.id", "user_list.name", "user_list.type", "user_list.crm_based_user_list.upload_key_type", "user_list.access_reason", "user_list.read_only", "user_list.membership_status")
      .from("user_list")
      .where(`user_list.id = ${lit.id(id)}`)
      .limit(1),
    { maxRows: 1 },
  );
  if (!r) throw new ToolError("not_found", `No user list ${id} in this account.`);
  return {
    id,
    name: str(r, "user_list.name") ?? "",
    type: str(r, "user_list.type"),
    upload_key_type: str(r, "user_list.crm_based_user_list.upload_key_type"),
    access_reason: str(r, "user_list.access_reason"),
    read_only: pick(r, "user_list.read_only") === true,
    membership_status: str(r, "user_list.membership_status"),
  };
}

const CONSENT = ["GRANTED", "DENIED"] as const;
const NOTE =
  "Google processes Customer Match uploads asynchronously (often 6 hours or more). This confirms only that Google accepted the members and started the job, not that anyone was matched; check the list's size and match rate later with list_user_lists.";

// ------------------------------------------------------------------------------------------------- the tool
export const uploadCustomerMatchMembers = googleWrite({
  name: "upload_customer_match_members",
  title: "Upload Customer Match members",
  // The tier inventory/mapping.ts plans. Every request carries a change set, and its effect sets the approval's risk:
  // adding members is "create" (high_impact, a second approver), removing them is "remove" (destructive).
  risk: "write",
  timeoutMs: 120_000,
  description:
    "Adds people to, or removes them from, a Customer Match list (a CRM-based contact-info list from create_customer_match_list), after a person approves it. Give up to 1,000 members, each with an email, a phone number in E.164 form (+ country code), or both. " +
    "The server normalizes them the way Google requires (trim, lowercase; for gmail.com and googlemail.com also drop dots and any +suffix in the name) and hashes them with SHA-256 before anything is stored or sent; raw emails and phone numbers are never stored, logged or returned, and the approval shows only counts and the list name. " +
    "Already-hashed values (hashed_email, hashed_phone_number: lowercase hex SHA-256 of the normalized value) are accepted too. " +
    "Adding requires the consent you hold for these people: ad_user_data and ad_personalization must both be GRANTED (Google rejects an upload marked DENIED; remove such people instead). Only upload data you collected yourself (first party), under Google's Customer Match policy. " +
    "Sends one OfflineUserDataJob (create, add operations, run). Since 1 April 2026 Google refuses these requests with CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE for Google Cloud projects that had no Customer Match activity between October 2025 and March 2026 (Google points to its Data Manager API instead); such errors are returned as Google gives them. " +
    "Google processes the job asynchronously, so the result is the job and its status, never a confirmation that members were matched.",
  input: z
    .object({
      account_id: accountId,
      user_list_id: idSchema.describe("The Customer Match list (list_user_lists, type CRM_BASED)."),
      action: z.enum(["add", "remove"]),
      members: z.array(memberSchema).min(1).max(1000).describe("Up to 1,000 people, each one object with email and/or phone (or their hashes)."),
      consent: z
        .object({ ad_user_data: z.enum(CONSENT), ad_personalization: z.enum(CONSENT) })
        .strict()
        .optional()
        .describe("Required when adding: whether these people consented to Google using their data for ads (ad_user_data) and for ad personalization (ad_personalization). Not used when removing."),
    })
    .refine((v) => v.action === "remove" || v.consent !== undefined, { message: "consent (ad_user_data and ad_personalization) is required when adding members", path: ["consent"] }),
  output: z.object({
    user_list_id: z.string(),
    user_list_name: z.string(),
    action: z.enum(["add", "remove"]),
    members_sent: z.number().int(),
    identifiers_sent: z.object({ email: z.number().int(), phone: z.number().int() }),
    rejected_members: z.number().int().nullable().describe("Members Google refused when they were added to the job (null when Google reported a failure without saying which)."),
    rejected_error_codes: z.array(z.string()),
    job_resource_name: z.string(),
    job_id: z.string(),
    job_status: z.string().nullable().describe("PENDING, RUNNING, SUCCESS or FAILED as read right after starting the job."),
    note: z.string(),
  }),
  plan: async (a, ctx) => {
    const ads = ctx.services.ads;
    const list = await readCrmList(ads, a.user_list_id);
    if (list.type !== "CRM_BASED") throw new ToolError("invalid_argument", `User list ${a.user_list_id} is a ${list.type ?? "non-CRM"} list, not a Customer Match list.`);
    if (list.upload_key_type !== "CONTACT_INFO") throw new ToolError("invalid_argument", `This Customer Match list matches on ${list.upload_key_type ?? "an unknown key"}, not contact information (emails and phone numbers).`);
    if (list.read_only || list.access_reason !== "OWNED") throw new ToolError("invalid_argument", "Only the account that created a Customer Match list can change its members, and this account does not own it.");
    if (a.action === "add" && list.membership_status === "CLOSED") throw new ToolError("invalid_argument", "The list is closed: Google adds no new members to a closed list.");
    if (a.action === "add" && (a.consent!.ad_user_data === "DENIED" || a.consent!.ad_personalization === "DENIED"))
      throw new ToolError("invalid_argument", "Google rejects members uploaded with consent DENIED (CUSTOMER_NOT_ACCEPTED_CUSTOMER_DATA_TERMS). To take people who denied consent off the list, use action remove.");
    // Two running jobs on one list fail with CONCURRENT_MODIFICATION (get-started guide, best practices).
    const running = await ads.query(
      new Gaql().select("offline_user_data_job.id", "offline_user_data_job.status").from("offline_user_data_job").where(`offline_user_data_job.customer_match_user_list_metadata.user_list = ${lit.str(rn(ads, "userLists", a.user_list_id))}`).where("offline_user_data_job.status = 'RUNNING'").limit(1),
      { maxRows: 1, partial: true },
    );
    if (running.length) throw new ToolError("conflict", "Another upload job for this list is still running. Google refuses concurrent changes to one list; try again when it has finished.");
    const counts = countIds(a.members);
    const verb = a.action === "add" ? "Add" : "Remove";
    const change: Change = { resource: "user_list", id: a.user_list_id, name: list.name, field: "members", before: null, after: `${a.action === "add" ? "+" : "-"}${a.members.length} (hashed)`, unit: "text", effect: a.action === "add" ? "create" : "remove" };
    return {
      summary:
        `${verb} ${a.members.length} member(s) ${a.action === "add" ? "to" : "from"} Customer Match list "${list.name}" (${a.user_list_id}): ${counts.email} email(s) and ${counts.phone} phone number(s), SHA-256 hashed.` +
        (a.action === "add" ? ` Consent: ad_user_data ${a.consent!.ad_user_data}, ad_personalization ${a.consent!.ad_personalization}.` : "") +
        " Google processes the upload asynchronously; matching cannot be confirmed.",
      snapshot: { user_list: list },
      changes: [change],
    };
  },
  // The members of a Customer Match list cannot be read back, and a job interrupted after it was sent cannot be told
  // apart from other uploads to the same list, so an unknown outcome stays unknown rather than being guessed.
  verify: async () => ({ outcome: "indeterminate", detail: "Customer Match members cannot be read back from Google Ads. Check the list's recent upload jobs and size in Google Ads before uploading again." }),
  execute: async (a, ctx, run) => {
    const ads = ctx.services.ads;
    // The pipeline re-planned against live state just before this and refused on any difference from the approval.
    const list = (run.snapshot as { user_list: CrmList }).user_list;
    const metadata: Row = { userList: rn(ads, "userLists", a.user_list_id), ...(a.action === "add" ? { consent: { adUserData: a.consent!.ad_user_data, adPersonalization: a.consent!.ad_personalization } } : {}) };
    const created = await ads.sendRpc<{ resourceName?: string }>("customers/{customer}/offlineUserDataJobs:create", { job: { type: "CUSTOMER_MATCH_USER_LIST", customerMatchUserListMetadata: metadata } });
    const job = created.resourceName ?? "";
    // Without the job's name nothing more can be sent, and an empty job changes no membership: a definite failure.
    if (!new RegExp(`^customers/${ads.customerId}/offlineUserDataJobs/\\d+$`).test(job)) throw new ToolError("internal", "Google did not return the upload job it created, so no members were sent and none were changed.", { definite: true });

    // Partial failure as Google recommends: members it cannot accept are reported, the others stay in the job.
    let added: { partialFailureError?: unknown };
    try {
      added = await ads.sendRpc(`${job}:addOperations`, { enablePartialFailure: true, operations: a.members.map((m) => ({ [a.action === "add" ? "create" : "remove"]: { userIdentifiers: identifiers(m) } })) });
    } catch (e) {
      // The job is never run after this, so whatever reached it changes no membership.
      throw notRun(e, job, "adding the members to the upload job failed");
    }
    const rejected = rejectedOperations(added.partialFailureError);
    if (rejected.count === a.members.length) throw new ToolError("invalid_argument", `Google rejected every member (${rejected.codes.join(", ") || "no reason given"}). The upload job ${job} was not run, so no members were changed.`, { definite: true });

    try {
      await ads.sendRpc(`${job}:run`, {});
    } catch (e) {
      if (e instanceof ToolError && e.code === "unknown_outcome") throw e; // the job may have started
      throw notRun(e, job, "starting the upload job failed");
    }
    const [st] = await ads.query(new Gaql().select("offline_user_data_job.id", "offline_user_data_job.status").from("offline_user_data_job").where(`offline_user_data_job.resource_name = ${lit.str(job)}`).limit(1), { maxRows: 1 });
    const counts = countIds(a.members);
    return {
      user_list_id: a.user_list_id,
      user_list_name: list.name,
      action: a.action,
      members_sent: a.members.length,
      identifiers_sent: counts,
      rejected_members: rejected.count,
      rejected_error_codes: rejected.codes,
      job_resource_name: job,
      job_id: job.split("/").pop()!,
      job_status: st ? str(st, "offline_user_data_job.status") : null,
      note: NOTE,
    };
  },
});

/** One UserIdentifier per identifier: the identifier is a oneof, so email and phone are never set on the same one. */
function identifiers(m: Member): Row[] {
  return [...(m.hashed_email ? [{ hashedEmail: m.hashed_email }] : []), ...(m.hashed_phone_number ? [{ hashedPhoneNumber: m.hashed_phone_number }] : [])];
}
function countIds(members: Member[]) {
  return { email: members.filter((m) => m.hashed_email).length, phone: members.filter((m) => m.hashed_phone_number).length };
}

/** A failure before the job ran: nothing changed membership, whatever the transport says. Google's message is kept. */
function notRun(e: unknown, job: string, what: string): ToolError {
  const err = e instanceof ToolError ? e : new ToolError("internal", "unexpected error");
  const code = err.code === "unknown_outcome" ? "transient" : err.code;
  return new ToolError(code, `No members were changed: ${what} (${err.message}). The upload job ${job} was not run and expires unused.`, { definite: true });
}

/**
 * Operations Google refused in an addOperations partial-failure status: the distinct operation indexes, and the error
 * codes (never the error triggers, which can echo submitted values).
 */
function rejectedOperations(status: unknown): { count: number | null; codes: string[] } {
  const s = status as { code?: number; message?: string; details?: { errors?: { errorCode?: Record<string, string>; location?: { fieldPathElements?: { fieldName?: string; index?: number }[] } }[] }[] } | undefined;
  if (!s || (!s.code && !s.details?.length)) return { count: 0, codes: [] };
  const errors = (s.details ?? []).flatMap((d) => d.errors ?? []);
  const indexes = new Set<number>();
  for (const er of errors) {
    const op = er.location?.fieldPathElements?.find((f) => f.fieldName === "operations");
    if (op?.index !== undefined) indexes.add(op.index);
  }
  const codes = [...new Set(errors.flatMap((er) => Object.values(er.errorCode ?? {})))].sort();
  // A failure status that names no operation: Google refused something without saying which members.
  return { count: indexes.size ? indexes.size : null, codes };
}
