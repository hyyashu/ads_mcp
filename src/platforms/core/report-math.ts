/** Platform-neutral helpers for reports. One definition each: Google and Meta tools both import them from here. */

/** YYYY-MM-DD that is a real calendar date. Date.parse alone accepts impossible dates such as 2027-02-30. */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(value);
}

/** Division that returns null instead of NaN/Infinity, so a metric is never reported as a number it is not. */
export const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
export const round = (n: number | null, digits = 4): number | null => (n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits);
