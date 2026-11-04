import { afterEach, expect } from "vitest";
import { checkRequest } from "./google-schema";

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
    return fetch(url, init);
  }) as F;
}

afterEach(() => {
  const found = problems.splice(0);
  expect(found, `requests that do not match the Google Ads v26 schema:\n${found.join("\n")}`).toEqual([]);
});
