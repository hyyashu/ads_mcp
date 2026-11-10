import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { checkGaql } from "../support/google-schema";

/**
 * Every `new Gaql()` chain in the Google platform source, rebuilt into GAQL from its string literals and checked against
 * the v26 rules (google-schema.ts). The fake-API tests only check the queries a test happens to run; this covers the
 * branches they do not (optional filters, rarely taken paths). Chains whose FROM is a variable cannot be rebuilt and are
 * listed in SKIPPED_FROM below after a manual review.
 */
const ROOT = join(__dirname, "../../platforms/google");
const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []));

/** Index just past the closing paren matching the "(" at `open`, skipping strings and template literals. */
function closeParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === "\\") i++;
    } else if (ch === "`") {
      i = skipTemplate(src, i);
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i + 1;
  }
  return src.length;
}
function skipTemplate(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "`") return i;
    else if (src[i] === "$" && src[i + 1] === "{") {
      let d = 0;
      for (i++; i < src.length; i++) {
        if (src[i] === "{") d++;
        else if (src[i] === "}" && --d === 0) break;
        else if (src[i] === "`") i = skipTemplate(src, i);
      }
    }
  }
  return src.length;
}
/** String and template literals in an argument; interpolations become 0 (not a field). */
function literals(arg: string, consts: Map<string, string> = new Map()): string[] {
  const out: string[] = [];
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      for (; j < arg.length && arg[j] !== ch; j++) if (arg[j] === "\\") j++;
      out.push(arg.slice(i + 1, j));
      i = j;
    } else if (ch === "`") {
      const end = skipTemplate(arg, i);
      let body = arg.slice(i + 1, end);
      // Replace ${...} (with nesting) by 0.
      let res = "";
      for (let k = 0; k < body.length; k++) {
        if (body[k] === "$" && body[k + 1] === "{") {
          let d = 0;
          const from = k + 2;
          for (k++; k < body.length; k++) {
            if (body[k] === "{") d++;
            else if (body[k] === "}" && --d === 0) break;
          }
          res += consts.get(body.slice(from, k).trim()) ?? "0";
        } else res += body[k];
      }
      body = res;
      out.push(body);
      i = end;
    }
  }
  return out;
}
/** Top-level comma split. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' || ch === "'" ) {
      let j = i + 1;
      for (; j < s.length && s[j] !== ch; j++) if (s[j] === "\\") j++;
      cur += s.slice(i, j + 1); i = j; continue;
    }
    if (ch === "`") { const e = skipTemplate(s, i); cur += s.slice(i, e + 1); i = e; continue; }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

interface Chain { at: string; from: string | null; select: string[]; selectComplete: boolean; where: string[]; order: string[] }
function chains(): Chain[] {
  const out: Chain[] = [];
  for (const file of files(ROOT)) {
    const src = readFileSync(file, "utf8");
    // Local string constants (const c = "ad_group_criterion") are substituted; the last binding before the chain wins.
    const bindings = [...src.matchAll(/\bconst (\w+) = "([a-z_.]+)";/g)].map((m) => ({ at: m.index!, name: m[1]!, value: m[2]! }));
    for (let idx = src.indexOf("new Gaql()"); idx !== -1; idx = src.indexOf("new Gaql()", idx + 1)) {
      const c: Chain = { at: `${relative(join(ROOT, "../../.."), file)}:${src.slice(0, idx).split("\n").length}`, from: null, select: [], selectComplete: true, where: [], order: [] };
      const consts = new Map(bindings.filter((b) => b.at < idx).map((b) => [b.name, b.value]));
      let p = idx + "new Gaql()".length;
      for (;;) {
        const m = /^\s*\.(select|from|where|orderBy|limit|parameters)\(/.exec(src.slice(p, p + 200));
        if (!m) break;
        const open = p + m[0].length - 1;
        const close = closeParen(src, open);
        const arg = src.slice(open + 1, close - 1);
        if (m[1] === "select") for (const a of splitArgs(arg)) {
          const lit = /^["'`]/.test(a) ? literals(a, consts)[0] : undefined;
          if (lit !== undefined && !/^0\./.test(lit)) c.select.push(lit); else c.selectComplete = false;
        }
        else if (m[1] === "from") c.from = /^\s*["']([a-z_]+)["']\s*$/.exec(arg)?.[1] ?? consts.get(arg.trim()) ?? null;
        else if (m[1] === "where") c.where.push(...literals(arg, consts));
        else if (m[1] === "orderBy") { const l = literals(splitArgs(arg)[0] ?? "", consts)[0]; if (l) c.order.push(l); }
        p = close;
      }
      out.push(c);
    }
  }
  return out;
}

describe("every GAQL query in the Google source", () => {
  const all = chains();
  it("finds the queries", () => expect(all.length).toBeGreaterThan(100));
  it("matches the v26 field reference", () => {
    const problems: string[] = [];
    for (const c of all) {
      if (!c.from) continue;
      const q = `SELECT ${c.select.length ? c.select.join(", ") : `${c.from}.resource_name`} FROM ${c.from}${c.where.length ? ` WHERE ${c.where.join(" AND ")}` : ""}${c.order.length ? ` ORDER BY ${c.order.join(", ")}` : ""}`;
      for (const pr of checkGaql(q)) {
        // Unresolved interpolations become 0: '0' enum literals and 0.field paths are extractor noise, not query problems.
        if (/'0' is not a valid value/.test(pr) || new RegExp(`\\b0\\.${(/^(?:unknown field: )?([a-z0-9_.]+)/.exec(pr)?.[1] ?? "@").replace(/\./g, "\\.")}\\b`).test(q)) continue;
        // A spread (...FIELDS) may select the field; those are reported separately for manual review.
        if (!c.selectComplete && /not selected|date range/.test(pr)) { problems.push(`REVIEW ${c.at}: ${pr}`); continue; }
        problems.push(`${c.at}: ${pr}`);
      }
    }
    expect(problems).toEqual([]);
  });
  it("leaves only reviewed chains unchecked", () => {
    // FROM is a parameter here. Reviewed: the first four filter only on the FROM resource's own id (campaign, ad_group,
    // label or the criterion resources); get_segment_performance's plan is exercised per segment in keyword-segment-reports.test.ts.
    const skipped = all.filter((c) => !c.from).map((c) => c.at.replace(/:\d+$/, ""));
    expect(skipped.sort()).toEqual([
      "src/platforms/google/tools/account-writes.ts",
      "src/platforms/google/tools/common.ts",
      "src/platforms/google/tools/keyword-segment-reports.ts",
      "src/platforms/google/tools/keywords.ts",
      "src/platforms/google/tools/status.ts",
    ]);
  });
});
