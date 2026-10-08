const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'] as const;
const DIVISIONS = ['IV', 'III', 'II', 'I'] as const;
const APEX_BASE = TIERS.indexOf('MASTER') * 400;

export interface RankInfo {
  tier: string;
  division: string;
  lp: number;
}

/**
 * Single number for "rank or above" comparisons. Each tier below Master spans 400
 * (4 divisions x 100 LP). Master, Grandmaster, and Challenger share one LP ladder,
 * so apex players are ordered by LP alone: Master 0 LP = 2800.
 */
export function rankScore({ tier, division, lp }: RankInfo): number {
  const t = TIERS.indexOf(tier.toUpperCase() as (typeof TIERS)[number]);
  if (t < 0) throw new Error(`Unknown tier "${tier}"`);
  if (t >= TIERS.indexOf('MASTER')) return APEX_BASE + lp;
  const d = DIVISIONS.indexOf(division.toUpperCase() as (typeof DIVISIONS)[number]);
  return t * 400 + Math.max(0, d) * 100 + lp;
}

/** Score for "Master N LP and above" (apex) thresholds. */
export const apexLpScore = (lp: number) => APEX_BASE + lp;

export function formatRank({ tier, division, lp }: RankInfo): string {
  const apex = TIERS.indexOf(tier as (typeof TIERS)[number]) >= TIERS.indexOf('MASTER');
  const name = tier.charAt(0) + tier.slice(1).toLowerCase();
  return apex ? `${name} ${lp} LP` : `${name} ${division} ${lp} LP`;
}
