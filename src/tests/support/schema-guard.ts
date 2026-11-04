import { afterEach, expect } from "vitest";
import { checkBody, checkRequest } from "./google-schema";

/** Problems found in requests sent to the fake Google Ads API during the current test. */
const problems: string[] = [];

/** Wraps a fake Google Ads fetch so every request is checked against the v26 schema (see google-schema.ts). */
export function schemaChecked<F extends (url: string, init?: RequestInit) => Promise<Response>>(fetch: F): F {
  return (async (url: string, init?: RequestInit) => {
    const m = /^https:\/\/googleads\.googleapis\.com\/v\d+\/(.+)$/.exec(url);
    if (m && init?.body) {
      let body: unknown;
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = undefined;
      }
      problems.push(...checkRequest(m[1]!, body));
    }
    const res = await fetch(url, init);
    // Fake search responses must look like real ones too: unknown fields or invented enum values in fixtures hide bugs.
    if (m && /googleAds:search(Stream)?$/.test(m[1]!) && res.ok) {
      try {
        const j = (await res.clone().json()) as { results?: unknown[] } | { results?: unknown[] }[];
        for (const chunk of Array.isArray(j) ? j : [j]) for (const row of chunk.results ?? []) problems.push(...checkBody("Services__GoogleAdsRow", row).map((p) => `fixture row: ${p}`));
      } catch {
        /* not JSON: the client reports it */
      }
    }
    return res;
  }) as F;
}

/** For the guard's own test: returns and clears the problems recorded so far. */
export const drainSchemaProblems = () => problems.splice(0);

afterEach(() => {
  const found = problems.splice(0);
  expect(found, `requests that do not match the Google Ads v26 schema:\n${found.join("\n")}`).toEqual([]);
});
