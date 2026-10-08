/**
 * Ranked season starts (annual reset). Riot does not expose these through the API,
 * so they are maintained by hand. Times are the NA queue opening; other regions
 * reset within the same day.
 */
export const SEASONS: Record<string, string> = {
  '2026': '2026-01-08T20:00:00Z', // Patch 26.1, noon PT
};

export const CURRENT_SEASON = '2026';

/** Accepts a season key ("2026") or an ISO date ("2026-05-01"). Returns epoch ms. */
export function parseSince(value: string): number {
  const iso = SEASONS[value] ?? value;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`--since must be a season (${Object.keys(SEASONS).join(', ')}) or a date like 2026-05-01`);
  }
  return ms;
}
