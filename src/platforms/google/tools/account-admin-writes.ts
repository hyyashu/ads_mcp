import { z } from "zod";
import { ToolError } from "../../../mcp/errors";
import type { Change } from "../../../policy/change-set";
import type { GoogleAdsClient, Row } from "../client";
import { Gaql, lit, pick } from "../gaql";
import { ACCOUNT_CURRENCY_CODES, ACCOUNT_TIME_ZONES } from "./account-admin-codes";
import { type AccessInvitation, type AccessUser, readPendingInvitations, readUsers } from "./account-admin-reads";
import { accountId, idSchema, requireParent, str } from "./common";
import { stateWrite } from "./write-kit";

/**
 * HIGH_IMPACT_NOTE: inventory/mapping.ts plans these Update/Create tools as "write" (its googleHighImpact list does not name them),
 * and the declared tier must match the plan. Every plan here therefore carries a change whose effect ("create" or "enable") makes
 * the approval high impact under policy/risk.ts, so access, account and policy changes always need a second approver.
 */
const ROLES = ["ADMIN", "STANDARD", "READ_ONLY", "EMAIL_ONLY"] as const;
const roleSchema = z.enum(ROLES).describe("ADMIN (owns the account and manages users), STANDARD (edits campaigns), READ_ONLY (views) or EMAIL_ONLY (receives emails only).");
const clean = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/, "no control characters");
const email = z.string().trim().max(254).email();
const sameEmail = (x: string | null, y: string) => (x ?? "").trim().toLowerCase() === y.trim().toLowerCase();

/** The account itself: whether it is a manager account and its name. */
async function readCustomer(ads: GoogleAdsClient): Promise<{ id: string; name: string | null; manager: boolean }> {
  const [r] = await ads.query(new Gaql().select("customer.id", "customer.descriptive_name", "customer.manager").from("customer").limit(1), { maxRows: 1 });
  return { id: ads.customerId, name: r ? str(r, "customer.descriptive_name") : null, manager: r ? pick(r, "customer.manager") === true : false };
}
async function requireManager(ads: GoogleAdsClient) {
  const c = await readCustomer(ads);
  if (!c.manager) throw new ToolError("invalid_argument", `Account ${ads.customerId} is not a manager account. Only a manager account can create or link client accounts: run this on the manager account.`);
  return c;
}

// ----------------------------------------------------------------------------------- policy exemption (ads only)
/**
 * Topic entry types that restrict serving. Their topics are what the policy exemption guide calls ignorable policy topics
 * (PolicyValidationParameter.ignorable_policy_topics = PolicyTopicEntry.topic). DESCRIPTIVE and BROADENING entries do not
 * limit serving, so there is nothing to exempt for them.
 */
const RESTRICTING = new Set(["PROHIBITED", "LIMITED", "FULLY_LIMITED", "AREA_OF_INTEREST_ONLY"]);
const UNDER_REVIEW = new Set(["REVIEW_IN_PROGRESS", "UNDER_APPEAL"]);
interface AdPolicy {
  ad_group_name: string | null;
  status: string;
  approval_status: string | null;
  review_status: string | null;
  topics: { topic: string; type: string | null }[];
}

export const requestPolicyExemption = stateWrite({
  name: "request_policy_exemption",
  title: "Request a policy exemption for an ad",
  risk: "write", // approvals are high impact through the change set (see HIGH_IMPACT_NOTE)
  description:
    "Resubmits a disapproved or limited ad for review with a policy exemption request, after approval: the ad is updated with its restricting policy topics as ignorable policy topics (Google's policy exemption flow for ads). Refused when the ad has no restricting policy topics (nothing to exempt), is removed, or is already under review. Google decides whether the exemption is granted; an exempted ad may start serving. Confirmed by re-reading the ad's review status. Keywords are not supported: Google Ads API v26 exposes no exemptible policy violation keys on an existing keyword.",
  input: z.object({ account_id: accountId, ad_group_id: idSchema, ad_id: idSchema.describe("The ad id (from get_ad_policy_violations).") }),
  output: z.object({ ad_group_id: z.string(), ad_id: z.string(), exempted_topics: z.array(z.string()), approval_status: z.string().nullable(), review_status: z.string().nullable() }),
  read: async (a, ads): Promise<AdPolicy> => {
    await requireParent(ads, "ad_group", a.ad_group_id, "Ads");
    const [r] = await ads.query(
      new Gaql()
        .select("ad_group.name", "ad_group_ad.status", "ad_group_ad.policy_summary.approval_status", "ad_group_ad.policy_summary.review_status", "ad_group_ad.policy_summary.policy_topic_entries")
        .from("ad_group_ad")
        .where(`ad_group.id = ${lit.id(a.ad_group_id)}`)
        .where(`ad_group_ad.ad.id = ${lit.id(a.ad_id)}`)
        .limit(1),
      { maxRows: 1 },
    );
    if (!r) throw new ToolError("not_found", `No ad ${a.ad_id} in ad group ${a.ad_group_id}.`);
    const topics = ((pick(r, "ad_group_ad.policy_summary.policy_topic_entries") as { topic?: string; type?: string }[] | undefined) ?? []).filter((t) => t.topic).map((t) => ({ topic: String(t.topic), type: t.type ?? null }));
    return { ad_group_name: str(r, "ad_group.name"), status: str(r, "ad_group_ad.status") ?? "", approval_status: str(r, "ad_group_ad.policy_summary.approval_status"), review_status: str(r, "ad_group_ad.policy_summary.review_status"), topics: topics.sort((x, y) => x.topic.localeCompare(y.topic)) };
  },
  build: (a, s, ads) => {
    if (s.status === "REMOVED") throw new ToolError("invalid_argument", "The ad is removed and cannot be resubmitted.");
    const topics = [...new Set(s.topics.filter((t) => t.type && RESTRICTING.has(t.type)).map((t) => t.topic))];
    if (!topics.length) throw new ToolError("invalid_argument", `Nothing would change: the ad has no policy topics that restrict serving (approval status ${s.approval_status ?? "unknown"}), so there is nothing to exempt.`);
    if (s.review_status && UNDER_REVIEW.has(s.review_status)) throw new ToolError("invalid_argument", `Nothing would change: the ad is already under review (${s.review_status}).`);
    const ref = { resource: "ad", id: a.ad_id, name: s.ad_group_name ? `ad in "${s.ad_group_name}"` : null };
    const changes: Change[] = [{ ...ref, field: "policy_review", before: `${s.approval_status ?? "UNKNOWN"} / ${s.review_status ?? "UNKNOWN"}`, after: `resubmitted with exemption for ${topics.join(", ")}`, unit: "text", effect: "enable" }];
    return {
      summary: `Resubmit ad ${a.ad_id} (ad group "${s.ad_group_name ?? a.ad_group_id}", ${s.approval_status ?? "unknown approval"}) for review, requesting an exemption for policy topic(s): ${topics.join(", ")}. If Google grants it, the ad may start serving.`,
      changes,
      ops: [],
      mutate: {
        service: "adGroupAds",
        // The update re-sends the ad's current status; the exemption travels in policy_validation_parameter.
        operations: [{ update: { resourceName: `customers/${ads.customerId}/adGroupAds/${a.ad_group_id}~${a.ad_id}`, status: s.status }, updateMask: "status", policyValidationParameter: { ignorablePolicyTopics: topics } }],
      },
    };
  },
  landed: (_a, before, after) => after.review_status !== before.review_status || after.approval_status !== before.approval_status,
  result: (a, after, _res, before) => ({ ad_group_id: a.ad_group_id, ad_id: a.ad_id, exempted_topics: [...new Set(before.topics.filter((t) => t.type && RESTRICTING.has(t.type)).map((t) => t.topic))], approval_status: after.approval_status, review_status: after.review_status }),
});

// ------------------------------------------------------------------------------------------- users and access
/**
 * A pending multi-party approval (MPA) request. Google can hold an invitation, a role change or a removal until a second
 * administrator approves it in Google Ads; the mutate then returns the review's resource name instead of applying the change.
 */
interface Review {
  name: string;
  operation: string | null;
  /** customers/{c}/customerUserAccesses/{user_id} for role changes and removals. */
  user: string | null;
  /** Invited email address, for invitations. */
  email: string | null;
}
async function readPendingReviews(ads: GoogleAdsClient): Promise<Review[]> {
  const rows = await ads.query(
    new Gaql()
      .select("multi_party_auth_review.resource_name", "multi_party_auth_review.operation_type", "multi_party_auth_review.customer_user_access_review.old_customer_user_access", "multi_party_auth_review.customer_user_access_review.new_customer_user_access", "multi_party_auth_review.customer_user_access_invitation_review.new_customer_user_access_invitation")
      .from("multi_party_auth_review")
      .where("multi_party_auth_review.review_status = 'PENDING'")
      .orderBy("multi_party_auth_review.resource_name"),
    { maxRows: 1000 },
  );
  return rows.map((r) => {
    const updated = pick(r, "multi_party_auth_review.customer_user_access_review.new_customer_user_access") as { resourceName?: string } | undefined;
    const invite = pick(r, "multi_party_auth_review.customer_user_access_invitation_review.new_customer_user_access_invitation") as { emailAddress?: string } | undefined;
    return { name: str(r, "multi_party_auth_review.resource_name") ?? "", operation: str(r, "multi_party_auth_review.operation_type"), user: str(r, "multi_party_auth_review.customer_user_access_review.old_customer_user_access") ?? updated?.resourceName ?? null, email: invite?.emailAddress ?? null };
  });
}

interface AccessState {
  manager: boolean;
  users: AccessUser[];
  invitations: AccessInvitation[];
  reviews: Review[];
}
async function readAccess(ads: GoogleAdsClient): Promise<AccessState> {
  const c = await readCustomer(ads);
  return { manager: c.manager, users: await readUsers(ads), invitations: await readPendingInvitations(ads), reviews: await readPendingReviews(ads) };
}
const userRn = (ads: GoogleAdsClient, userId: string) => `customers/${ads.customerId}/customerUserAccesses/${userId}`;
/** A review that exists in `after` but not in `before` and matches. */
const newReview = (before: AccessState, after: AccessState, match: (r: Review) => boolean) => after.reviews.find((r) => !before.reviews.some((b) => b.name === r.name) && match(r)) ?? null;
/** The multi-party review Google returned for a single-operation mutate, if it held the change for approval. */
const reviewFromResponse = (responses: Row[]): string | null => {
  const r = (responses[0]?.result ?? {}) as { multiPartyAuthReview?: string };
  return r.multiPartyAuthReview ?? null;
};
const userSelector = {
  user_id: idSchema.optional().describe("The user's id (from list_account_users)."),
  email: email.optional().describe("Or the user's email address."),
};
const oneUser = (v: { user_id?: string; email?: string }) => (v.user_id === undefined) !== (v.email === undefined);
const oneUserMsg = { message: "give exactly one of user_id or email" };
function findUser(s: AccessState, a: { user_id?: string; email?: string }): AccessUser {
  const u = a.user_id ? s.users.find((x) => x.user_id === a.user_id) : s.users.find((x) => sameEmail(x.email, a.email!));
  if (!u) throw new ToolError("not_found", `No user ${a.user_id ?? a.email} has access to this account (list_account_users lists them).`);
  return u;
}
/** A change already waiting for a second administrator: sending another would only fail or duplicate it. */
function refusePending(ads: GoogleAdsClient, s: AccessState, u: AccessUser) {
  if (u.pending_multi_party_auth_review || s.reviews.some((r) => r.user === userRn(ads, u.user_id))) throw new ToolError("invalid_argument", `A change to ${u.email ?? u.user_id} is already waiting for another administrator's approval in Google Ads (Admin > Access and security). Approve, deny or revoke it there first.`);
}
/**
 * Google rejects removing or downgrading the last ADMIN of a manager account (LAST_ADMIN_USER_OF_MANAGER), and of a serving
 * account that has no owner manager (LAST_ADMIN_USER_OF_SERVING_CUSTOMER). The first is certain from what we read; the second
 * depends on the owner manager, which is left to Google.
 */
function lastAdmin(s: AccessState, u: AccessUser): boolean {
  return u.access_role === "ADMIN" && s.users.filter((x) => x.access_role === "ADMIN").length === 1;
}
const accessOut = z.object({
  user_id: z.string(),
  email: z.string().nullable(),
  status: z.enum(["applied", "pending_multi_party_approval"]).describe("pending_multi_party_approval: Google holds the change until another administrator of the account approves it in Google Ads (Admin > Access and security), within 20 days."),
  multi_party_auth_review: z.string().nullable(),
});

export const updateUserAccess = stateWrite({
  name: "update_user_access",
  title: "Change a user's access role",
  risk: "write", // approvals are high impact through the change set (see HIGH_IMPACT_NOTE)
  description:
    "Changes a user's access role on the Google Ads account (ADMIN, STANDARD, READ_ONLY or EMAIL_ONLY), after approval. Needs ADMIN access. Refused when the user already has the role, when a change to the user is already awaiting approval, and when it would downgrade the only ADMIN of a manager account (Google rejects that; it also rejects it on a serving account without an owner manager). Google may hold the change for multi-party approval by another administrator: the result then says pending_multi_party_approval. Confirmed by re-reading the account's users and pending approvals. Returns the user's email address.",
  input: z.object({ account_id: accountId, ...userSelector, access_role: roleSchema }).refine(oneUser, oneUserMsg),
  output: accessOut.extend({ access_role_before: z.string().nullable(), access_role: z.string() }),
  read: (_a, ads) => readAccess(ads),
  build: (a, s, ads) => {
    const u = findUser(s, a);
    if (u.access_role === a.access_role) throw new ToolError("invalid_argument", `Nothing would change: ${u.email ?? u.user_id} already has ${a.access_role} access.`);
    refusePending(ads, s, u);
    const downgrade = a.access_role !== "ADMIN" && lastAdmin(s, u);
    if (downgrade && s.manager) throw new ToolError("invalid_argument", `${u.email ?? u.user_id} is the only ADMIN of this manager account, and Google rejects downgrading the last admin of a manager account. Give another user ADMIN access first.`);
    return {
      summary: `Change the access of ${u.email ?? `user ${u.user_id}`} from ${u.access_role} to ${a.access_role}.${downgrade ? " This user is the only ADMIN: Google rejects the change unless the account has an owner manager." : ""}`,
      // effect "enable": an access change is high impact whichever way it goes (see HIGH_IMPACT_NOTE).
      changes: [{ resource: "user_access", id: u.user_id, name: u.email, field: "access_role", before: u.access_role, after: a.access_role, unit: "text", effect: "enable" }],
      ops: [],
      rpc: { path: `customers/${ads.customerId}/customerUserAccesses:mutate`, body: { operation: { update: { resourceName: userRn(ads, u.user_id), accessRole: a.access_role }, updateMask: "access_role" } } },
    };
  },
  landed: (a, before, after) => {
    const u = findUser(before, a);
    return after.users.find((x) => x.user_id === u.user_id)?.access_role === a.access_role || pendingOn(before, after, u);
  },
  result: (a, after, responses, before) => {
    const u = findUser(before, a);
    const now = after.users.find((x) => x.user_id === u.user_id);
    const applied = now?.access_role === a.access_role;
    const review = applied ? null : (reviewFromResponse(responses) ?? now?.pending_multi_party_auth_review ?? reviewOn(before, after, u));
    return { user_id: u.user_id, email: u.email, access_role_before: u.access_role, access_role: a.access_role, status: applied ? ("applied" as const) : ("pending_multi_party_approval" as const), multi_party_auth_review: review };
  },
});

/** Name of a review created for this user between `before` and `after` (on the user row or in the review list), or null. */
function reviewOn(before: AccessState, after: AccessState, u: AccessUser): string | null {
  const row = after.users.find((x) => x.user_id === u.user_id)?.pending_multi_party_auth_review ?? null;
  if (row && row !== u.pending_multi_party_auth_review) return row;
  return newReview(before, after, (r) => !!r.user && r.user.endsWith(`/customerUserAccesses/${u.user_id}`))?.name ?? null;
}
const pendingOn = (before: AccessState, after: AccessState, u: AccessUser) => reviewOn(before, after, u) !== null;

export const removeUserAccess = stateWrite({
  name: "remove_user_access",
  title: "Remove a user's access",
  risk: "destructive",
  description:
    "Removes a user's access to the Google Ads account, after a person approves it. Needs ADMIN access; the user must be invited again to regain access. Refused when a change to the user is already awaiting approval and when the user is the only ADMIN of a manager account (Google rejects removing the last admin of a manager account; it also rejects removing the last admin of a serving account without an owner manager). Google may hold the removal for multi-party approval by another administrator: the result then says pending_multi_party_approval. Confirmed by re-reading the account's users and pending approvals. Returns the user's email address.",
  input: z.object({ account_id: accountId, ...userSelector }).refine(oneUser, oneUserMsg),
  output: accessOut.extend({ access_role_before: z.string().nullable() }),
  read: (_a, ads) => readAccess(ads),
  build: (a, s, ads) => {
    const u = findUser(s, a);
    refusePending(ads, s, u);
    const last = lastAdmin(s, u);
    if (last && s.manager) throw new ToolError("invalid_argument", `${u.email ?? u.user_id} is the only ADMIN of this manager account, and Google rejects removing the last admin of a manager account. Give another user ADMIN access first.`);
    return {
      summary: `Remove the access of ${u.email ?? `user ${u.user_id}`} (${u.access_role}) to account ${ads.customerId}. They would need a new invitation to get access back.${last ? " This user is the only ADMIN: Google rejects the removal unless the account has an owner manager." : ""}`,
      changes: [{ resource: "user_access", id: u.user_id, name: u.email, field: "access_role", before: u.access_role, after: null, unit: "text", effect: "remove" }],
      ops: [],
      rpc: { path: `customers/${ads.customerId}/customerUserAccesses:mutate`, body: { operation: { remove: userRn(ads, u.user_id) } } },
    };
  },
  // Removed, or held for approval. A user whose change awaits approval may drop out of the list, so the review is checked first in result().
  landed: (a, before, after) => {
    const u = findUser(before, a);
    return pendingOn(before, after, u) || !after.users.some((x) => x.user_id === u.user_id);
  },
  result: (a, after, responses, before) => {
    const u = findUser(before, a);
    const review = reviewFromResponse(responses) ?? reviewOn(before, after, u);
    return { user_id: u.user_id, email: u.email, access_role_before: u.access_role, status: review ? ("pending_multi_party_approval" as const) : ("applied" as const), multi_party_auth_review: review };
  },
});

export const inviteUser = stateWrite({
  name: "invite_user",
  title: "Invite a user",
  risk: "write", // approvals are high impact through the change set (see HIGH_IMPACT_NOTE)
  description:
    "Sends an email invitation to access the Google Ads account with a role (ADMIN, STANDARD, READ_ONLY or EMAIL_ONLY), after approval. Needs ADMIN access. Refused when the email address already has access, already has a pending invitation, or has an invitation awaiting multi-party approval. The person gets access only after accepting the invitation in Google Ads. Google may hold the invitation for multi-party approval by another administrator: the result then says pending_multi_party_approval. Confirmed by re-reading the account's pending invitations and approvals.",
  input: z.object({ account_id: accountId, email, access_role: roleSchema }),
  output: z.object({ email: z.string(), access_role: z.string(), status: z.enum(["invited", "pending_multi_party_approval"]), invitation_id: z.string().nullable(), multi_party_auth_review: z.string().nullable() }),
  read: (_a, ads) => readAccess(ads),
  build: (a, s, ads) => {
    const user = s.users.find((u) => sameEmail(u.email, a.email));
    if (user) throw new ToolError("invalid_argument", `Nothing would change: ${a.email} already has ${user.access_role} access (user ${user.user_id}). Use update_user_access to change the role.`);
    const inv = s.invitations.find((i) => sameEmail(i.email, a.email));
    if (inv) throw new ToolError("invalid_argument", `Nothing would change: ${a.email} already has a pending invitation (${inv.access_role}, sent ${inv.created ?? "earlier"}).`);
    if (s.reviews.some((r) => r.email !== null && sameEmail(r.email, a.email))) throw new ToolError("invalid_argument", `An invitation for ${a.email} is already waiting for another administrator's approval in Google Ads (Admin > Access and security).`);
    return {
      summary: `Invite ${a.email} to account ${ads.customerId} with ${a.access_role} access.`,
      changes: [{ resource: "user_invitation", id: "new", name: a.email, field: "access_role", before: null, after: a.access_role, unit: "text", effect: "create" }],
      ops: [],
      rpc: { path: `customers/${ads.customerId}/customerUserAccessInvitations:mutate`, body: { operation: { create: { emailAddress: a.email, accessRole: a.access_role } } } },
    };
  },
  landed: (a, before, after) => after.invitations.some((i) => sameEmail(i.email, a.email)) || !!newReview(before, after, (r) => r.email !== null && sameEmail(r.email, a.email)),
  result: (a, after, responses, before) => {
    const inv = after.invitations.find((i) => sameEmail(i.email, a.email));
    const review = inv ? null : (reviewFromResponse(responses) ?? newReview(before, after, (r) => r.email !== null && sameEmail(r.email, a.email))?.name ?? null);
    return { email: a.email, access_role: a.access_role, status: inv ? ("invited" as const) : ("pending_multi_party_approval" as const), invitation_id: inv?.invitation_id ?? null, multi_party_auth_review: review };
  },
});

// ------------------------------------------------------------------------------------------------ manager accounts
interface NewClientState {
  manager: { id: string; name: string | null };
  /** Direct client accounts already carrying the requested name (their ids). */
  same_name: string[];
}
async function readSameName(ads: GoogleAdsClient, name: string): Promise<string[]> {
  const rows = await ads.query(new Gaql().select("customer_client.id", "customer_client.descriptive_name").from("customer_client").where("customer_client.level = 1").where(`customer_client.descriptive_name = ${lit.str(name)}`), { maxRows: 1000 });
  return rows.map((r) => String(pick(r, "customer_client.id"))).sort();
}

export const createClientAccount = stateWrite({
  name: "create_client_account",
  title: "Create a client account",
  risk: "write", // approvals are high impact through the change set (see HIGH_IMPACT_NOTE)
  description:
    "Creates a new Google Ads client account under a manager account, after approval (CustomerService.CreateCustomerClient). Run it on the manager account; other accounts are refused. Currency and time zone must be values Google supports and cannot be changed later. Optionally invites a user by email with a role, which Google allows only for allowlisted managers. Google allows account creation only for managers in good standing that have spent enough; it refuses otherwise. Refused when a direct client account with the same name already exists (so a repeated request cannot create a duplicate). Reports the new customer id, confirmed by re-reading the manager's client accounts. The new account appears in list_accounts only after the Google connection is refreshed.",
  input: z
    .object({
      account_id: accountId.describe("The manager account to create the client under."),
      descriptive_name: clean(255).describe("Name of the new account."),
      currency_code: z.enum(ACCOUNT_CURRENCY_CODES as [string, ...string[]]).describe("ISO 4217 code Google supports, e.g. USD or EUR. Cannot be changed later."),
      time_zone: z.string().refine((t) => ACCOUNT_TIME_ZONES.includes(t), "not a time zone Google supports (see developers.google.com/google-ads/api/data/codes-formats#timezone_ids)").describe("Time zone id, e.g. America/New_York. Cannot be changed later."),
      invite_email: email.optional().describe("Invite this person to the new account (allowlisted managers only)."),
      invite_access_role: roleSchema.optional(),
    })
    .refine((v) => (v.invite_email === undefined) === (v.invite_access_role === undefined), { message: "give invite_email and invite_access_role together" }),
  output: z.object({ customer_id: z.string(), descriptive_name: z.string(), currency_code: z.string(), time_zone: z.string(), manager_customer_id: z.string(), invitation_link: z.string().nullable() }),
  read: async (a, ads): Promise<NewClientState> => {
    const m = await requireManager(ads);
    return { manager: { id: m.id, name: m.name }, same_name: await readSameName(ads, a.descriptive_name) };
  },
  build: (a, s, ads) => {
    if (s.same_name.length) throw new ToolError("invalid_argument", `Nothing would change: manager ${ads.customerId} already has a client account named "${a.descriptive_name}" (${s.same_name.join(", ")}). Choose another name.`);
    return {
      summary: `Create a new client account "${a.descriptive_name}" (${a.currency_code}, ${a.time_zone}) under manager ${s.manager.name ? `"${s.manager.name}" ` : ""}${ads.customerId}${a.invite_email ? `, inviting ${a.invite_email} as ${a.invite_access_role}` : ""}. Currency and time zone cannot be changed later.`,
      changes: [{ resource: "customer", id: "new", name: a.descriptive_name, field: "client_account", before: null, after: `${a.currency_code}, ${a.time_zone}`, unit: "text", effect: "create" }],
      ops: [],
      rpc: { path: `customers/${ads.customerId}:createCustomerClient`, body: { customerClient: { descriptiveName: a.descriptive_name, currencyCode: a.currency_code, timeZone: a.time_zone }, ...(a.invite_email ? { emailAddress: a.invite_email, accessRole: a.invite_access_role } : {}) } },
    };
  },
  landed: (_a, before, after) => after.same_name.some((id) => !before.same_name.includes(id)),
  result: (a, after, responses, before) => {
    const res = (responses[0] ?? {}) as { resourceName?: string; invitationLink?: string };
    const fromResponse = res.resourceName?.split("/").pop();
    const created = after.same_name.filter((id) => !before.same_name.includes(id));
    return { customer_id: fromResponse && created.includes(fromResponse) ? fromResponse : created[0]!, descriptive_name: a.descriptive_name, currency_code: a.currency_code, time_zone: a.time_zone, manager_customer_id: before.manager.id, invitation_link: res.invitationLink ?? null };
  },
});

interface LinkState {
  links: { resource_name: string; status: string | null; manager_link_id: string | null }[];
}
const clientIdSchema = z.string().regex(/^\d{3}-?\d{3}-?\d{4}$/, "a 10-digit Google Ads customer id, e.g. 123-456-7890");
const digits = (id: string) => id.replace(/-/g, "");
const ACTIVE_OR_PENDING = new Set(["ACTIVE", "PENDING"]);

export const linkClientAccount = stateWrite({
  name: "link_client_account",
  title: "Invite a client account to a manager",
  risk: "write", // approvals are high impact through the change set (see HIGH_IMPACT_NOTE)
  description:
    "Sends a link invitation from a manager account to an existing Google Ads account, after approval (CustomerClientLinkService, status PENDING). Run it on the manager account; other accounts are refused. The link takes effect only when an admin of the client account accepts the invitation: that happens outside this server, in the client account's Google Ads (or with the client's own API access). Refused when the client is already linked to this manager or an invitation is already pending. Confirmed by re-reading the manager's client links.",
  input: z.object({ account_id: accountId.describe("The manager account sending the invitation."), client_customer_id: clientIdSchema.describe("The existing account to invite (10-digit customer id).") }),
  output: z.object({ manager_customer_id: z.string(), client_customer_id: z.string(), status: z.string(), link_resource_name: z.string(), manager_link_id: z.string().nullable(), next_step: z.string() }),
  read: async (a, ads): Promise<LinkState> => {
    await requireManager(ads);
    const rows = await ads.query(new Gaql().select("customer_client_link.resource_name", "customer_client_link.status", "customer_client_link.manager_link_id").from("customer_client_link").where(`customer_client_link.client_customer = ${lit.str(`customers/${digits(a.client_customer_id)}`)}`), { maxRows: 100 });
    return { links: rows.map((r) => ({ resource_name: str(r, "customer_client_link.resource_name") ?? "", status: str(r, "customer_client_link.status"), manager_link_id: str(r, "customer_client_link.manager_link_id") })).sort((x, y) => x.resource_name.localeCompare(y.resource_name)) };
  },
  build: (a, s, ads) => {
    if (digits(a.client_customer_id) === ads.customerId) throw new ToolError("invalid_argument", "A manager account cannot be linked to itself.");
    const live = s.links.find((l) => l.status && ACTIVE_OR_PENDING.has(l.status));
    if (live) throw new ToolError("invalid_argument", `Nothing would change: account ${digits(a.client_customer_id)} ${live.status === "ACTIVE" ? "is already linked to this manager" : "already has a pending invitation from this manager"}.`);
    return {
      summary: `Invite account ${digits(a.client_customer_id)} to be managed by manager ${ads.customerId}. The client account's admin must accept the invitation in Google Ads before the link is active.`,
      changes: [{ resource: "customer_client_link", id: digits(a.client_customer_id), field: "status", before: s.links[0]?.status ?? null, after: "PENDING", unit: "status", effect: "create" }],
      ops: [],
      rpc: { path: `customers/${ads.customerId}/customerClientLinks:mutate`, body: { operation: { create: { clientCustomer: `customers/${digits(a.client_customer_id)}`, status: "PENDING" } } } },
    };
  },
  landed: (_a, before, after) => after.links.some((l) => l.status !== null && ACTIVE_OR_PENDING.has(l.status) && !before.links.some((b) => b.resource_name === l.resource_name && b.status === l.status)),
  result: (a, after, _res, before) => {
    const l = after.links.find((x) => x.status !== null && ACTIVE_OR_PENDING.has(x.status) && !before.links.some((b) => b.resource_name === x.resource_name && b.status === x.status))!;
    return {
      manager_customer_id: l.resource_name.split("/")[1]!,
      client_customer_id: digits(a.client_customer_id),
      status: l.status!,
      link_resource_name: l.resource_name,
      manager_link_id: l.manager_link_id,
      next_step: l.status === "ACTIVE" ? "The link is active." : "An admin of the client account must accept this invitation in Google Ads (or through the client's own API access with CustomerManagerLinkService). This server cannot accept it.",
    };
  },
});
