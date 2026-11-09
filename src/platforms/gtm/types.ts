/**
 * Raw Tag Manager API v2 objects, as the reference documents them (docs/VERIFICATION.md, "Tag Manager tools (2026-11-10)").
 * Every interface keeps unknown fields (`[k: string]: unknown`): an update sends back the whole object it read, so fields this
 * server does not model pass through untouched.
 */
export type Row = Record<string, unknown>;

export interface GtmParameter {
  type?: string;
  key?: string;
  value?: string;
  list?: GtmParameter[];
  map?: GtmParameter[];
  isWeakReference?: boolean;
  [k: string]: unknown;
}
export interface GtmCondition {
  type?: string;
  parameter?: GtmParameter[];
  [k: string]: unknown;
}
export interface GtmContainerInfo {
  path?: string;
  accountId?: string;
  containerId?: string;
  name?: string;
  publicId?: string;
  domainName?: string[];
  usageContext?: string[];
  tagIds?: string[];
  features?: Record<string, unknown>;
  fingerprint?: string;
  [k: string]: unknown;
}
export interface GtmWorkspace {
  path?: string;
  workspaceId?: string;
  name?: string;
  description?: string;
  fingerprint?: string;
  [k: string]: unknown;
}
export interface GtmTag {
  path?: string;
  tagId?: string;
  name?: string;
  type?: string;
  parameter?: GtmParameter[];
  firingTriggerId?: string[];
  blockingTriggerId?: string[];
  paused?: boolean;
  liveOnly?: boolean;
  tagFiringOption?: string;
  consentSettings?: { consentStatus?: string; consentType?: GtmParameter };
  scheduleStartMs?: string;
  scheduleEndMs?: string;
  setupTag?: { tagName?: string; stopOnSetupFailure?: boolean }[];
  teardownTag?: { tagName?: string; stopTeardownOnFailure?: boolean }[];
  notes?: string;
  fingerprint?: string;
  [k: string]: unknown;
}
export interface GtmTrigger {
  path?: string;
  triggerId?: string;
  name?: string;
  type?: string;
  filter?: GtmCondition[];
  customEventFilter?: GtmCondition[];
  autoEventFilter?: GtmCondition[];
  waitForTags?: GtmParameter;
  checkValidation?: GtmParameter;
  waitForTagsTimeout?: GtmParameter;
  eventName?: GtmParameter;
  parameter?: GtmParameter[];
  notes?: string;
  fingerprint?: string;
  [k: string]: unknown;
}
export interface GtmVariable {
  path?: string;
  variableId?: string;
  name?: string;
  type?: string;
  parameter?: GtmParameter[];
  formatValue?: unknown;
  notes?: string;
  fingerprint?: string;
  [k: string]: unknown;
}
export interface GtmBuiltIn {
  type?: string;
  name?: string;
  [k: string]: unknown;
}
export interface GtmCustomTemplate {
  templateId?: string;
  name?: string;
  templateData?: string;
  galleryReference?: { owner?: string; repository?: string; version?: string; isModified?: boolean; [k: string]: unknown };
  [k: string]: unknown;
}
export interface GtmVersion {
  path?: string;
  containerVersionId?: string;
  name?: string;
  description?: string;
  deleted?: boolean;
  fingerprint?: string;
  container?: GtmContainerInfo;
  tag?: GtmTag[];
  trigger?: GtmTrigger[];
  variable?: GtmVariable[];
  builtInVariable?: GtmBuiltIn[];
  folder?: Row[];
  customTemplate?: GtmCustomTemplate[];
  client?: Row[];
  zone?: Row[];
  gtagConfig?: Row[];
  transformation?: Row[];
  [k: string]: unknown;
}
export interface GtmVersionHeader {
  containerVersionId?: string;
  name?: string;
  deleted?: boolean;
  numTags?: string;
  numTriggers?: string;
  numVariables?: string;
  [k: string]: unknown;
}
/** Entity of workspaces.getStatus: a change status and exactly one entity field. */
export interface GtmEntity {
  changeStatus?: string;
  tag?: GtmTag;
  trigger?: GtmTrigger;
  variable?: GtmVariable;
  folder?: Row;
  client?: Row;
  transformation?: Row;
  zone?: Row;
  customTemplate?: Row;
  builtInVariable?: GtmBuiltIn;
  gtagConfig?: Row;
  [k: string]: unknown;
}
export interface GtmStatus {
  workspaceChange?: GtmEntity[];
  mergeConflict?: { entityInWorkspace?: GtmEntity; entityInBaseVersion?: GtmEntity }[];
}
export interface CreateVersionResponse {
  containerVersion?: GtmVersion;
  syncStatus?: { mergeConflict?: boolean; syncError?: boolean };
  compilerError?: boolean;
  newWorkspacePath?: string;
}
export interface PublishResponse {
  containerVersion?: GtmVersion;
  compilerError?: boolean;
}
