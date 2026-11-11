import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../auth/token-providers";
import { normalizeEmail, normalizePhone } from "../../platforms/google/tools/customer-match";
import { googleHarness, type GoogleHarness } from "../support/harness";

const C = "customers/1234567890";
const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const err = (status: number, s: string, message: string, errorCode?: Record<string, string>) => J({ error: { code: status, status: s, message, ...(errorCode ? { details: [{ "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure", errors: [{ errorCode, message }] }] } : {}) } }, status);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** In-memory user lists, where they are used, and Customer Match upload jobs. */
type List = Record<string, any> & { id: string; name: string };
let lists: List[];
let uses: { adGroup: string[]; campaign: string[]; audience: string[]; exclusion: string[] };
let jobs: { id: string; list: string; status: string; consent?: unknown; ops: any[] }[];
let calls: { path: string; body: any }[];
let queries: string[];
let nextId = 900;
let dropWrites = false;
let addFails: Response | null = null;
let partialFailure: unknown = null;
let runFails: Response | null = null;
let createFails: Response | null = null;
let userListFails: Response | null = null;

const listRow = (l: List) => ({ userList: l });
const fake: FetchLike = async (url, init) => {
  const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
  const body = JSON.parse(String(init?.body ?? "{}"));
  calls.push({ path, body });
  if (path.endsWith("googleAds:search")) {
    const q: string = body.query;
    queries.push(q);
    if (q.includes("FROM user_list")) {
      const id = /user_list\.id = (\d+)/.exec(q)?.[1];
      if (id) return J({ results: lists.filter((l) => l.id === id).map(listRow) });
      const name = /user_list\.name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1];
      if (name !== undefined) return J({ results: lists.filter((l) => l.name === name).map((l) => ({ userList: { id: l.id, type: l.type } })) });
      if (q.includes("user_list.type = 'LOGICAL'")) return J({ results: lists.filter((l) => l.type === "LOGICAL").map((l) => ({ userList: { id: l.id, name: l.name, logicalUserList: l.logicalUserList } })) });
      return J({ results: lists.map(listRow) });
    }
    const used = (kind: keyof typeof uses, res: string) => uses[kind].map((n, i) => ({ [res]: { id: String(10 + i), name: n } }));
    if (q.includes("FROM ad_group_criterion")) return J({ results: used("adGroup", "adGroup") });
    if (q.includes("FROM campaign_criterion")) return J({ results: used("campaign", "campaign") });
    if (q.includes("FROM audience")) return J({ results: used(q.includes("exclusion_dimension") ? "exclusion" : "audience", "audience") });
    if (q.includes("FROM offline_user_data_job")) {
      const rn = /offline_user_data_job\.resource_name = '([^']+)'/.exec(q)?.[1];
      if (rn) return J({ results: jobs.filter((j) => `${C}/offlineUserDataJobs/${j.id}` === rn).map((j) => ({ offlineUserDataJob: { id: j.id, status: j.status } })) });
      const list = /user_list = '([^']+)'/.exec(q)?.[1];
      return J({ results: jobs.filter((j) => j.list === list && j.status === "RUNNING").map((j) => ({ offlineUserDataJob: { id: j.id, status: j.status } })) });
    }
    return J({ results: [] });
  }
  if (path.endsWith("userLists:mutate")) {
    const op = body.operations[0];
    if (userListFails) return userListFails;
    if (dropWrites) return J({ results: [{}] });
    if (op.create) {
      const id = String(nextId++);
      lists.push({ id, ...op.create, type: op.create.crmBasedUserList ? "CRM_BASED" : "RULE_BASED", accessReason: "OWNED" });
      return J({ results: [{ resourceName: `${C}/userLists/${id}` }] });
    }
    lists = lists.filter((l) => `${C}/userLists/${l.id}` !== op.remove);
    return J({ results: [{ resourceName: op.remove }] });
  }
  if (path.endsWith("offlineUserDataJobs:create")) {
    if (createFails) return createFails;
    const id = String(nextId++);
    jobs.push({ id, list: body.job.customerMatchUserListMetadata.userList, status: "PENDING", consent: body.job.customerMatchUserListMetadata.consent, ops: [] });
    return J({ resourceName: `${C}/offlineUserDataJobs/${id}` });
  }
  const m = /offlineUserDataJobs\/(\d+):(addOperations|run)$/.exec(path);
  if (m) {
    const job = jobs.find((j) => j.id === m[1])!;
    if (m[2] === "addOperations") {
      if (addFails) return addFails;
      job.ops.push(...body.operations);
      return J(partialFailure ? { partialFailureError: partialFailure } : {});
    }
    if (runFails) return runFails;
    job.status = "RUNNING";
    return J({ name: `${C}/operations/${job.id}` });
  }
  return err(400, "INVALID_ARGUMENT", `fake has no handler for ${path}`);
};

let kit: GoogleHarness;
beforeAll(async () => {
  kit = await googleHarness("AUD", fake);
});
beforeEach(() => {
  lists = [
    { id: "5", name: "All visitors", type: "RULE_BASED", membershipStatus: "OPEN", membershipLifeSpan: "30", sizeForDisplay: "4200", sizeRangeForDisplay: "ONE_THOUSAND_TO_TEN_THOUSAND", eligibleForDisplay: true, accessReason: "OWNED" },
    { id: "6", name: "Customers", type: "CRM_BASED", membershipStatus: "OPEN", membershipLifeSpan: "540", crmBasedUserList: { uploadKeyType: "CONTACT_INFO" }, accessReason: "OWNED", matchRatePercentage: 42, eligibleForSearch: true, eligibleForDisplay: true },
    { id: "7", name: "Old buyers", type: "CRM_BASED", membershipStatus: "CLOSED", closingReason: "UNUSED", crmBasedUserList: { uploadKeyType: "CONTACT_INFO" }, accessReason: "OWNED" },
    { id: "8", name: "Shared list", type: "REMARKETING", membershipStatus: "OPEN", accessReason: "SHARED", readOnly: true },
    { id: "9", name: "App users", type: "CRM_BASED", membershipStatus: "OPEN", crmBasedUserList: { uploadKeyType: "MOBILE_ADVERTISING_ID" }, accessReason: "OWNED" },
  ];
  uses = { adGroup: [], campaign: [], audience: [], exclusion: [] };
  nextId = 900;
  jobs = [];
  calls = [];
  queries = [];
  dropWrites = false;
  addFails = partialFailure = runFails = createFails = userListFails = null;
});
const approve = (id: string, by = kit.owner) => kit.approveAs(id, by);
const mutations = () => calls.filter((c) => !c.path.endsWith("googleAds:search"));

describe("list_user_lists", () => {
  it("returns every list with its type, status, sizes and eligibility", async () => {
    const r = await kit.run("list_user_lists", {});
    expect(r.ok).toBe(true);
    const data = r.data as any;
    expect(data.truncated).toBe(false);
    expect(data.user_lists).toHaveLength(5);
    expect(data.user_lists[0]).toEqual({
      id: "5", name: "All visitors", description: null, type: "RULE_BASED", membership_status: "OPEN", membership_life_span_days: 30, size_range_for_search: null, size_range_for_display: "ONE_THOUSAND_TO_TEN_THOUSAND",
      size_for_search: null, size_for_display: 4200, eligible_for_search: false, eligible_for_display: true, closing_reason: null, access_reason: "OWNED", read_only: false, match_rate_percentage: null, upload_key_type: null,
    });
    expect(data.user_lists[1]).toMatchObject({ type: "CRM_BASED", match_rate_percentage: 42, upload_key_type: "CONTACT_INFO", membership_life_span_days: 540 });
    expect(data.user_lists[2]).toMatchObject({ membership_status: "CLOSED", closing_reason: "UNUSED" });
  });

  it("filters by type, status and name with escaped literals, and reports truncation", async () => {
    const r = await kit.run("list_user_lists", { types: ["CRM_BASED", "RULE_BASED"], membership_status: "OPEN", name_contains: "Bob's", limit: 2 });
    expect((r.data as any).truncated).toBe(true);
    expect((r.data as any).user_lists).toHaveLength(2);
    expect(queries.at(-1)).toContain("WHERE user_list.type IN ('CRM_BASED', 'RULE_BASED') AND user_list.membership_status = 'OPEN' AND user_list.name LIKE '%Bob\\'s%' ORDER BY user_list.name ASC LIMIT 3");
    expect((await kit.run("list_user_lists", { types: ["BOGUS"] })).error?.code).toBe("invalid_argument");
    expect((await kit.run("list_user_lists", { name_contains: "50%" })).error?.code).toBe("invalid_argument");
  });
});

describe("create_remarketing_list", () => {
  it("queues a write, then creates the documented flexible rule list and confirms it by name", async () => {
    const r = await kit.run("create_remarketing_list", { name: "Pricing visitors", url_rules: [{ operator: "CONTAINS", value: "example.com/pricing" }, { operator: "STARTS_WITH", value: "https://example.com/plans" }], exclude_url_rules: [{ operator: "CONTAINS", value: "/thank-you" }], membership_duration_days: 90 });
    expect(r.approval).toMatchObject({ risk: "write", summary: expect.stringContaining("Google tag"), change_set: { changes: [{ resource: "user_list", field: "user_list", effect: "neutral" }] } });
    expect(mutations()).toHaveLength(0);
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    const sent = calls.find((c) => c.path.endsWith("userLists:mutate"))!;
    expect(sent.path).toBe("customers/1234567890/userLists:mutate");
    expect(sent.body).toEqual({
      operations: [
        {
          create: {
            name: "Pricing visitors",
            membershipStatus: "OPEN",
            membershipLifeSpan: "90",
            ruleBasedUserList: {
              prepopulationStatus: "REQUESTED",
              flexibleRuleUserList: {
                inclusiveRuleOperator: "AND",
                inclusiveOperands: [
                  {
                    rule: { ruleItemGroups: [{ ruleItems: [{ name: "url__", stringRuleItem: { operator: "CONTAINS", value: "example.com/pricing" } }] }, { ruleItems: [{ name: "url__", stringRuleItem: { operator: "STARTS_WITH", value: "https://example.com/plans" } }] }] },
                    lookbackWindowDays: "90",
                  },
                ],
                exclusiveOperands: [{ rule: { ruleItemGroups: [{ ruleItems: [{ name: "url__", stringRuleItem: { operator: "CONTAINS", value: "/thank-you" } }] }] }, lookbackWindowDays: "90" }],
              },
            },
          },
        },
      ],
    });
    expect(done.result).toMatchObject({ user_list_id: "900", name: "Pricing visitors", type: "RULE_BASED", note: expect.stringContaining("Google tag") });
  });

  it("'all' puts every rule in one group; past visitors can be left out", async () => {
    const r = await kit.run("create_remarketing_list", { name: "Both", description: "Visited both", url_rules: [{ operator: "CONTAINS", value: "/a" }, { operator: "NOT_CONTAINS", value: "/b" }], match: "all", include_past_visitors: false });
    expect((await approve(r.approval!.approval_id)).status).toBe("executed");
    const create = calls.find((c) => c.path.endsWith("userLists:mutate"))!.body.operations[0].create;
    expect(create.description).toBe("Visited both");
    expect(create.membershipLifeSpan).toBe("30");
    expect(create.ruleBasedUserList.prepopulationStatus).toBeUndefined();
    expect(create.ruleBasedUserList.flexibleRuleUserList.inclusiveOperands[0].rule.ruleItemGroups).toEqual([{ ruleItems: [{ name: "url__", stringRuleItem: { operator: "CONTAINS", value: "/a" } }, { name: "url__", stringRuleItem: { operator: "NOT_CONTAINS", value: "/b" } }] }]);
    expect(create.ruleBasedUserList.flexibleRuleUserList.exclusiveOperands).toBeUndefined();
  });

  it("validates input and refuses a name that is already taken", async () => {
    for (const bad of [
      { name: "X", url_rules: [] },
      { name: "X", url_rules: [{ operator: "REGEX", value: "a" }] },
      { name: "X", url_rules: [{ operator: "CONTAINS", value: "a(b)" }] },
      { name: "X", url_rules: [{ operator: "CONTAINS", value: "has space" }] },
      { name: "X", url_rules: [{ operator: "CONTAINS", value: "a" }], membership_duration_days: 541 },
      { name: "X", url_rules: Array.from({ length: 11 }, () => ({ operator: "CONTAINS", value: "a" })) },
      { name: "", url_rules: [{ operator: "CONTAINS", value: "a" }] },
    ]) expect((await kit.run("create_remarketing_list", bad)).error?.code).toBe("invalid_argument");
    const taken = await kit.run("create_remarketing_list", { name: "All visitors", url_rules: [{ operator: "CONTAINS", value: "a" }] });
    expect(taken.error?.message).toContain('A user list named "All visitors" already exists (id 5)');
    expect(mutations()).toHaveLength(0);
  });

  it("drift applies nothing; a create that does not read back is an unknown outcome", async () => {
    const r = await kit.run("create_remarketing_list", { name: "Late", url_rules: [{ operator: "CONTAINS", value: "a" }] });
    lists.push({ id: "50", name: "Late", type: "RULE_BASED" });
    expect((await approve(r.approval!.approval_id)).status).toBe("failed");
    expect(mutations()).toHaveLength(0);

    const r2 = await kit.run("create_remarketing_list", { name: "Lost", url_rules: [{ operator: "CONTAINS", value: "a" }] });
    dropWrites = true;
    expect((await approve(r2.approval!.approval_id)).status).toBe("unknown_outcome");
  });
});

describe("create_customer_match_list", () => {
  it("creates a CRM-based contact-info list with first-party data and the default 540-day span", async () => {
    const r = await kit.run("create_customer_match_list", { name: "Newsletter", description: "Subscribers" });
    expect(r.approval).toMatchObject({ risk: "write", summary: expect.stringContaining("540 days") });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("executed");
    expect(calls.find((c) => c.path.endsWith("userLists:mutate"))!.body).toEqual({ operations: [{ create: { name: "Newsletter", description: "Subscribers", membershipLifeSpan: "540", crmBasedUserList: { uploadKeyType: "CONTACT_INFO", dataSourceType: "FIRST_PARTY" } } }] });
    expect(done.result).toMatchObject({ user_list_id: "900", type: "CRM_BASED", note: expect.stringContaining("upload_customer_match_members") });
  });

  it("validates the life span, refuses a taken name and passes Google's eligibility error through", async () => {
    expect((await kit.run("create_customer_match_list", { name: "A", membership_life_span_days: 541 })).error?.code).toBe("invalid_argument");
    expect((await kit.run("create_customer_match_list", { name: "A", membership_life_span_days: 0 })).error?.code).toBe("invalid_argument");
    expect((await kit.run("create_customer_match_list", { name: "Customers" })).error?.message).toContain("already exists");
    const r = await kit.run("create_customer_match_list", { name: "Not eligible" });
    // Google refuses accounts that are not eligible for Customer Match; the approval fails with Google's own message.
    userListFails = err(400, "INVALID_ARGUMENT", "Advertiser needs to be on the allow-list to use remarketing lists created from advertiser uploaded data (for example, Customer Match lists).", { userListError: "ADVERTISER_NOT_ON_ALLOWLIST_FOR_USING_UPLOADED_DATA" });
    const done = await approve(r.approval!.approval_id);
    expect(done.status).toBe("failed");
    expect(JSON.stringify(done.result)).toContain("allow-list");
  });
});

describe("Customer Match normalization", () => {
  it("follows Google's documented email and phone rules", () => {
    expect(normalizeEmail("  Dana@Example.com ")).toBe("dana@example.com");
    expect(normalizeEmail("Jane.Doe+Shopping@googlemail.com")).toBe("janedoe@googlemail.com");
    expect(normalizeEmail("alex.2+myalias@gmail.com")).toBe("alex2@gmail.com");
    expect(normalizeEmail("user.name+NYC@Example.com")).toBe("user.name+nyc@example.com");
    expect(normalizeEmail("not an email")).toBeNull();
    expect(normalizeEmail("+x@gmail.com")).toBeNull();
    expect(normalizePhone("+1 (800) 555-0101")).toBe("+18005550101");
    expect(normalizePhone("+44 20 7946 0000")).toBe("+442079460000");
    expect(normalizePhone("800 555 0101")).toBeNull();
    expect(normalizePhone("+0 800 555")).toBeNull();
  });
});

describe("upload_customer_match_members", () => {
  const consent = { ad_user_data: "GRANTED", ad_personalization: "GRANTED" };
  const members = [{ email: " Dana@Example.com", phone: "+1 (800) 555-0101" }, { email: "Jane.Doe+Shopping@googlemail.com" }, { phone: "+44 20 7946 0000" }];
  const RAW = ["dana", "Dana", "jane", "Jane", "555-0101", "5550101", "7946"];
  const hashed = [
    { userIdentifiers: [{ hashedEmail: sha("dana@example.com") }, { hashedPhoneNumber: sha("+18005550101") }] },
    { userIdentifiers: [{ hashedEmail: sha("janedoe@googlemail.com") }] },
    { userIdentifiers: [{ hashedPhoneNumber: sha("+442079460000") }] },
  ];

  it("hashes on the server, stores and shows only counts, then creates, fills and runs one job", async () => {
    const r = await kit.run("upload_customer_match_members", { user_list_id: "6", action: "add", members, consent });
    expect(r.approval).toMatchObject({ risk: "high_impact", summary: expect.stringContaining('Add 3 member(s) to Customer Match list "Customers" (6): 2 email(s) and 2 phone number(s)'), change_set: { changes: [{ resource: "user_list", id: "6", field: "members", before: null, after: "+3 (hashed)", effect: "create" }] } });
    expect(mutations()).toHaveLength(0);
    // Nothing raw is kept with the approval: the stored arguments hold only the hashes.
    const row = await kit.approvals.get(kit.tenantId, r.approval!.approval_id);
    const stored = JSON.stringify({ args: row!.args, summary: row!.summary, changes: row!.changeSet, snapshot: row!.planSnapshot, response: r });
    for (const raw of RAW) expect(stored).not.toContain(raw);
    expect((row!.args as any).members[0]).toEqual({ hashed_email: sha("dana@example.com"), hashed_phone_number: sha("+18005550101") });

    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    const sent = mutations();
    expect(sent.map((c) => c.path)).toEqual(["customers/1234567890/offlineUserDataJobs:create", "customers/1234567890/offlineUserDataJobs/900:addOperations", "customers/1234567890/offlineUserDataJobs/900:run"]);
    expect(sent[0]!.body).toEqual({ job: { type: "CUSTOMER_MATCH_USER_LIST", customerMatchUserListMetadata: { userList: `${C}/userLists/6`, consent: { adUserData: "GRANTED", adPersonalization: "GRANTED" } } } });
    expect(sent[1]!.body).toEqual({ enablePartialFailure: true, operations: hashed.map((create) => ({ create })) });
    expect(sent[2]!.body).toEqual({});
    for (const raw of RAW) expect(JSON.stringify(calls)).not.toContain(raw);
    expect(done.result).toEqual({
      user_list_id: "6", user_list_name: "Customers", action: "add", members_sent: 3, identifiers_sent: { email: 2, phone: 2 }, rejected_members: 0, rejected_error_codes: [],
      job_resource_name: `${C}/offlineUserDataJobs/900`, job_id: "900", job_status: "RUNNING", note: expect.stringContaining("not that anyone was matched"),
    });
    for (const raw of RAW) expect(JSON.stringify(done)).not.toContain(raw);
  });

  it("removes members without consent, as destructive, and accepts pre-hashed identifiers", async () => {
    const h = sha("someone@example.com");
    const r = await kit.run("upload_customer_match_members", { user_list_id: "7", action: "remove", members: [{ hashed_email: h }] });
    expect(r.approval).toMatchObject({ risk: "destructive", change_set: { changes: [{ after: "-1 (hashed)", effect: "remove" }] } });
    expect((await approve(r.approval!.approval_id, kit.second)).status).toBe("executed");
    expect(mutations()[0]!.body.job.customerMatchUserListMetadata).toEqual({ userList: `${C}/userLists/7` });
    expect(mutations()[1]!.body.operations).toEqual([{ remove: { userIdentifiers: [{ hashedEmail: h }] } }]);
  });

  it("validates members without echoing them, and requires consent to add", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ members: [{ email: "dana.example.com" }], consent }, "dana"],
      [{ members: [{ phone: "800 555 0101" }], consent }, "555"],
      [{ members: [{}], consent }, ""],
      [{ members: [{ email: "dana@example.com", hashed_phone_number: sha("x") }], consent }, "dana"],
      [{ members: [{ hashed_email: "ABC" }], consent }, "ABC"],
      [{ members: Array.from({ length: 1001 }, (_, i) => ({ email: `u${i}@example.com` })), consent }, "u1@"],
      [{ members: [{ email: "dana@example.com" }] }, "dana"],
      [{ members: [{ email: "dana@example.com" }], consent: { ad_user_data: "YES", ad_personalization: "GRANTED" } }, "dana"],
    ];
    for (const [args, raw] of cases) {
      const r = await kit.run("upload_customer_match_members", { user_list_id: "6", action: "add", ...args });
      expect(r.error?.code).toBe("invalid_argument");
      if (raw) expect(r.error!.message).not.toContain(raw);
    }
    expect(mutations()).toHaveLength(0);
  });

  it("refuses lists it cannot upload to, denied consent and a running job", async () => {
    const add = (list: string, extra: Record<string, unknown> = {}) => kit.run("upload_customer_match_members", { user_list_id: list, action: "add", members: [{ email: "a@example.com" }], consent, ...extra });
    expect((await add("99")).error?.code).toBe("not_found");
    expect((await add("5")).error?.message).toContain("not a Customer Match list");
    expect((await add("9")).error?.message).toContain("MOBILE_ADVERTISING_ID");
    expect((await add("7")).error?.message).toContain("closed");
    lists.push({ id: "10", name: "Theirs", type: "CRM_BASED", crmBasedUserList: { uploadKeyType: "CONTACT_INFO" }, accessReason: "SHARED", readOnly: true });
    expect((await add("10")).error?.message).toContain("does not own");
    expect((await add("6", { consent: { ad_user_data: "GRANTED", ad_personalization: "DENIED" } })).error?.message).toContain("consent DENIED");
    jobs.push({ id: "1", list: `${C}/userLists/6`, status: "RUNNING", ops: [] });
    expect((await add("6")).error).toMatchObject({ code: "conflict", message: expect.stringContaining("still running") });
    expect(queries.at(-1)).toContain("offline_user_data_job.status = 'RUNNING'");
    expect(mutations()).toHaveLength(0);
  });

  it("reports members Google rejects; when it rejects all, or a step fails before running, nothing is run", async () => {
    const op = (i: number) => ({ errorCode: { offlineUserDataJobError: "INVALID_SHA256_FORMAT" }, message: "bad hash", trigger: { stringValue: "secret" }, location: { fieldPathElements: [{ fieldName: "operations", index: i }, { fieldName: "create" }] } });
    partialFailure = { code: 3, message: "partial", details: [{ "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure", errors: [op(1)] }] };
    const r = await kit.run("upload_customer_match_members", { user_list_id: "6", action: "add", members: [{ email: "p1@example.com" }, { email: "p2@example.com" }], consent });
    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(done.result).toMatchObject({ rejected_members: 1, rejected_error_codes: ["INVALID_SHA256_FORMAT"] });
    expect(JSON.stringify(done.result)).not.toContain("secret");
    for (const j of jobs) j.status = "SUCCESS"; // the job finished; a running one would block the next upload

    calls = [];
    partialFailure = { code: 3, message: "partial", details: [{ "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure", errors: [op(0)] }] };
    const r2 = await kit.run("upload_customer_match_members", { user_list_id: "6", action: "add", members: [{ email: "x@example.com" }], consent });
    const d2 = await approve(r2.approval!.approval_id, kit.second);
    expect(d2.status).toBe("failed");
    expect(JSON.stringify(d2.result)).toContain("rejected every member");
    expect(mutations().some((c) => c.path.endsWith(":run"))).toBe(false);

    calls = [];
    partialFailure = null;
    addFails = err(500, "INTERNAL", "boom");
    const r3 = await kit.run("upload_customer_match_members", { user_list_id: "6", action: "add", members: [{ email: "y@example.com" }], consent });
    const d3 = await approve(r3.approval!.approval_id, kit.second);
    expect(d3.status).toBe("failed");
    expect(JSON.stringify(d3.result)).toContain("No members were changed");
    expect(mutations().some((c) => c.path.endsWith(":run"))).toBe(false);

    calls = [];
    addFails = null;
    runFails = err(400, "INVALID_ARGUMENT", "Job cannot be run.");
    const r4 = await kit.run("upload_customer_match_members", { user_list_id: "6", action: "add", members: [{ email: "z@example.com" }], consent });
    const d4 = await approve(r4.approval!.approval_id, kit.second);
    expect(d4.status).toBe("failed");
    expect(JSON.stringify(d4.result)).toContain("was not run");
  });

  it("surfaces Google's Customer Match allowlist refusal as a definite failure", async () => {
    createFails = err(400, "INVALID_ARGUMENT", "The customer is not allowlisted for this feature.", { offlineUserDataJobError: "CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE" });
    const r = await kit.run("upload_customer_match_members", { user_list_id: "6", action: "add", members: [{ email: "a@example.com" }], consent });
    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("failed");
    expect(JSON.stringify(done.result)).toContain("not allowlisted");
  });

  it("an interrupted run is an unknown outcome that verify never guesses; drift applies nothing", async () => {
    runFails = err(500, "INTERNAL", "boom");
    const r = await kit.run("upload_customer_match_members", { user_list_id: "6", action: "add", members: [{ email: "a@example.com" }], consent });
    expect((await approve(r.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");
    const tool = kit.deps.registry.get("upload_customer_match_members")!;
    if (tool.kind !== "write") throw new Error("write tool expected");
    const row = await kit.approvals.get(kit.tenantId, r.approval!.approval_id);
    expect(await tool.verify(row!.args as never, {} as never, { snapshot: row!.planSnapshot })).toMatchObject({ outcome: "indeterminate" });

    calls = [];
    runFails = null;
    const r2 = await kit.run("upload_customer_match_members", { user_list_id: "6", action: "add", members: [{ email: "drift@example.com" }], consent });
    lists.find((l) => l.id === "6")!.name = "Renamed";
    expect((await approve(r2.approval!.approval_id, kit.second)).status).toBe("failed");
    expect(mutations()).toHaveLength(0);
  });
});

describe("remove_user_list", () => {
  it("removes an unused owned list as destructive and confirms it is gone", async () => {
    const r = await kit.run("remove_user_list", { user_list_id: "7" });
    expect(r.approval).toMatchObject({ risk: "destructive", summary: expect.stringContaining('"Old buyers"'), change_set: { changes: [{ resource: "user_list", id: "7", before: "CRM_BASED", after: "(removed)", effect: "remove" }] } });
    const done = await approve(r.approval!.approval_id, kit.second);
    expect(done.status).toBe("executed");
    expect(mutations()).toEqual([{ path: "customers/1234567890/userLists:mutate", body: { operations: [{ remove: `${C}/userLists/7` }] } }]);
    expect(done.result).toEqual({ user_list_id: "7", name: "Old buyers", removed: true });
    expect(queries.some((q) => q.includes(`ad_group_criterion.user_list.user_list = '${C}/userLists/7'`))).toBe(true);
    expect(queries.some((q) => q.includes(`audience.exclusion_dimension.exclusions.user_list.user_list = '${C}/userLists/7'`))).toBe(true);
  });

  it("refuses lists that are in use, read-only, not owned or missing", async () => {
    uses.adGroup = ["Shoes"];
    uses.campaign = ["Brand"];
    uses.exclusion = ["PMax signal"];
    const inUse = await kit.run("remove_user_list", { user_list_id: "7" });
    expect(inUse.error?.message).toContain("still used by 3 item(s): ad_group 10 (Shoes); audience 10 (PMax signal); campaign 10 (Brand)");
    uses = { adGroup: [], campaign: [], audience: [], exclusion: [] };
    lists.push({ id: "11", name: "Combined", type: "LOGICAL", accessReason: "OWNED", logicalUserList: { rules: [{ operator: "ANY", ruleOperands: [{ userList: `${C}/userLists/7` }] }] } });
    expect((await kit.run("remove_user_list", { user_list_id: "7" })).error?.message).toContain("logical_list 11 (Combined)");
    expect((await kit.run("remove_user_list", { user_list_id: "8" })).error?.message).toContain("read-only");
    lists.push({ id: "12", name: "Licensed", type: "REMARKETING", accessReason: "LICENSED" });
    expect((await kit.run("remove_user_list", { user_list_id: "12" })).error?.message).toContain("does not own");
    expect((await kit.run("remove_user_list", { user_list_id: "99" })).error?.code).toBe("not_found");
    expect((await kit.run("remove_user_list", { user_list_id: "abc" })).error?.code).toBe("invalid_argument");
    expect(mutations()).toHaveLength(0);
  });

  it("drift applies nothing; a removal that does not read back is an unknown outcome, and verify sees a later removal", async () => {
    const r = await kit.run("remove_user_list", { user_list_id: "6" });
    uses.adGroup = ["Shoes"]; // new targeting meanwhile: the list may no longer be removed
    expect((await approve(r.approval!.approval_id, kit.second)).status).toBe("failed");
    expect(mutations()).toHaveLength(0);
    uses.adGroup = [];

    const r2 = await kit.run("remove_user_list", { user_list_id: "6" });
    dropWrites = true;
    expect((await approve(r2.approval!.approval_id, kit.second)).status).toBe("unknown_outcome");
    const tool = kit.deps.registry.get("remove_user_list")!;
    if (tool.kind !== "write") throw new Error("write tool expected");
    const services = await kit.deps.createServices({ tenantId: kit.tenantId, account: { id: kit.accountId, platform: "google_ads", externalId: "1234567890", loginCustomerId: null, connectionId: "x" } });
    const row = await kit.approvals.get(kit.tenantId, r2.approval!.approval_id);
    expect(await tool.verify(row!.args as never, { services } as never, { snapshot: row!.planSnapshot })).toEqual({ outcome: "not_applied" });
    lists = lists.filter((l) => l.id !== "6");
    expect(await tool.verify(row!.args as never, { services } as never, { snapshot: row!.planSnapshot })).toEqual({ outcome: "applied" });
  });
});
