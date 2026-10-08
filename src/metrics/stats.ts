import type { Direction } from './compute';

export function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Share of the distribution this value beats (0..1), respecting metric direction.
 * Ties count half. Returns null for neutral metrics or empty distributions.
 */
export function betterThan(value: number, distribution: readonly number[], direction: Direction): number | null {
  if (direction === 'neutral' || distribution.length === 0) return null;
  let beaten = 0;
  for (const other of distribution) {
    if (other === value) beaten += 0.5;
    else if (direction === 'higher' ? value > other : value < other) beaten += 1;
  }
  return beaten / distribution.length;
}
