/** Win-probability points, e.g. 0.034 -> "+3.4". */
export const pp = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(digits)}`;
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
export const tone = (v: number | null | undefined) => (v === null || v === undefined || Math.abs(v) < 0.0005 ? '' : v > 0 ? 'pos' : 'neg');
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
