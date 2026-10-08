/** L2-regularized logistic regression fitted by Newton/IRLS. Intercept (column 0) is not penalized. */
export function fitLogit(X: number[][], y: number[], ridge = 1, iterations = 30): { w: number[]; se: number[] } {
  const k = X[0]!.length;
  let w = new Array<number>(k).fill(0);
  let cov: number[][] = [];
  for (let it = 0; it < iterations; it++) {
    const g = w.map((v, j) => (j === 0 ? 0 : -ridge * v));
    const H = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => (a === b && a > 0 ? ridge : 0)));
    for (let i = 0; i < X.length; i++) {
      const x = X[i]!;
      const p = sigmoid(dot(x, w));
      const r = y[i]! - p;
      const s = p * (1 - p);
      for (let a = 0; a < k; a++) {
        g[a]! += r * x[a]!;
        const row = H[a]!;
        for (let b = a; b < k; b++) row[b]! += s * x[a]! * x[b]!;
      }
    }
    for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) H[a]![b] = H[b]![a]!;
    for (let a = 0; a < k; a++) H[a]![a]! += 1e-9;
    cov = invert(H);
    const step = cov.map((row) => dot(row, g));
    w = w.map((v, a) => v + step[a]!);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return { w, se: w.map((_, a) => Math.sqrt(Math.max(0, cov[a]![a]!))) };
}

export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
export const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);

export function invert(m: number[][]): number[][] {
  const n = m.length;
  const a = m.map((r, i) => [...r, ...r.map((_, j) => +(i === j))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    [a[c], a[p]] = [a[p]!, a[c]!];
    const d = a[c]![c]!;
    for (let j = 0; j < 2 * n; j++) a[c]![j]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r]![c]!;
      if (f !== 0) for (let j = 0; j < 2 * n; j++) a[r]![j]! -= f * a[c]![j]!;
    }
  }
  return a.map((r) => r.slice(n));
}
