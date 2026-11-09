import { reportOf } from "../ga4/fake-ga4";

/**
 * GA4 runReport answers keyed by the first requested dimension: each row gives its dimension values and the metrics it has
 * (others are absent → null). `totals` are GA4's totals for that report.
 */
export type Ga4Spec = Record<string, { rows: { dims: string[]; m: Record<string, number> }[]; totals?: Record<string, number>; rowCount?: number }>;
export const ga4Answer = (spec: Ga4Spec) => (body: any) => {
  const dims: string[] = body.dimensions.map((d: { name: string }) => d.name);
  const mets: string[] = body.metrics.map((m: { name: string }) => m.name);
  const s = spec[dims[0]!] ?? { rows: [] };
  const rows = s.rows.map((r) => [r.dims, mets.map((m) => (r.m[m] === undefined ? undefined : String(r.m[m])))] as [string[], (string | undefined)[]]);
  const totals = s.totals ? [{ dimensionValues: dims.map(() => ({ value: "RESERVED_TOTAL" })), metricValues: mets.map((m) => ({ value: String(s.totals![m] ?? 0) })) }] : undefined;
  return reportOf(dims, mets, rows, { ...(totals ? { totals } : {}), ...(s.rowCount ? { rowCount: s.rowCount } : {}) });
};
