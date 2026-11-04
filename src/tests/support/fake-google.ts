import type { FetchLike } from "../../auth/token-providers";

/**
 * A small stand-in for googleads.googleapis.com used by tool tests. Searches are answered by FROM resource (rows or a
 * function of the query); other RPCs by path suffix. Every request is recorded. Requests are schema-checked by the
 * harness, so fixtures only need realistic rows.
 */
export type Rows = Record<string, unknown>[];
export interface FakeGoogle {
  fetch: FetchLike;
  queries: string[];
  calls: { path: string; body: any }[];
  search: Record<string, Rows | ((q: string) => Rows)>;
  rpc: Record<string, (body: any) => unknown>;
  reset(): void;
}

export function fakeGoogle(): FakeGoogle {
  const f: FakeGoogle = {
    queries: [],
    calls: [],
    search: {},
    rpc: {},
    reset() {
      f.queries.length = 0;
      f.calls.length = 0;
      f.search = {};
      f.rpc = {};
    },
    fetch: async (url, init) => {
      const path = url.replace(/^https:\/\/googleads\.googleapis\.com\/v\d+\//, "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      f.calls.push({ path, body });
      const J = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (path.endsWith("googleAds:search")) {
        f.queries.push(body.query);
        const from = /\bFROM\s+([a-z_]+)/.exec(body.query)?.[1] ?? "";
        const h = f.search[from];
        return J({ results: typeof h === "function" ? h(body.query) : h ?? [] });
      }
      const key = Object.keys(f.rpc).find((k) => path.endsWith(k));
      if (key) return J(f.rpc[key]!(body));
      return J({ error: { code: 400, status: "INVALID_ARGUMENT", message: `fake has no handler for ${path}` } }, 400);
    },
  };
  return f;
}
