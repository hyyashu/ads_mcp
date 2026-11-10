/**
 * OAuth scopes of the Bing Webmaster connection ("Accessing Bing Webmaster APIs using OAuth 2.0", Authorization Scopes):
 * webmaster.read is read access, webmaster.manage is read and write. The reference spells them "Webmaster.read" /
 * "Webmaster.manage" in its list and "webmaster.manage" in its authorize URL sample; the sample's spelling is used.
 */
export const BING_READ = "webmaster.read";
export const BING_MANAGE = "webmaster.manage";
export const BING_SCOPES = { read: [BING_READ], write: [BING_MANAGE] } as const;
