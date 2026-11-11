import type { AnyTool } from "../../../mcp/tool";
import { getBillingInfo, getLocalServicesLeads, listAccountUsers } from "./account-admin-reads";
import { createClientAccount, inviteUser, linkClientAccount, removeUserAccess, requestPolicyExemption, updateUserAccess } from "./account-admin-writes";

/**
 * Google Ads tools: request_policy_exemption, list_account_users, update_user_access, remove_user_access, invite_user, get_billing_info, create_client_account, link_client_account, get_local_services_leads.
 * Approved by the owner on 2026-11-11 (inventory/tool-registry.json); API surfaces in inventory/mapping.ts.
 * Reads live in account-admin-reads.ts, writes in account-admin-writes.ts.
 */
export const accountAdminTools: AnyTool[] = [requestPolicyExemption, listAccountUsers, updateUserAccess, removeUserAccess, inviteUser, getBillingInfo, createClientAccount, linkClientAccount, getLocalServicesLeads];
