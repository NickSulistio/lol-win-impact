import type { PeerFilter, Store } from './db';
import { METRICS, type MetricDef, type ParticipantMetrics } from './metrics/compute';
import { betterThan, mean, median } from './metrics/stats';

/** Prefer comparing averages to other players' averages; fall back to per-game values. */
const MIN_PEER_PLAYERS = 20;
const MIN_PEER_GAMES = 3;

export interface MetricSummary {
  def: MetricDef;
  yours: number | null;
  peerMedian: number | null;
  betterThan: number | null;
  sampleSize: number;
  basis: 'players' | 'games';
}

export function mainRole(games: ParticipantMetrics[]): string | null {
  const counts = new Map<string, number>();
  for (const g of games) {
    if (g.teamPosition) counts.set(g.teamPosition, (counts.get(g.teamPosition) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [role, n] of counts) if (!best || n > counts.get(best)!) best = role;
  return best;
}

/** Compares the player's games (already filtered to the slice being analyzed) with peers. */
export function summarize(store: Store, games: ParticipantMetrics[], filter: PeerFilter): MetricSummary[] {
  return METRICS.map((def) => {
    const values = games.map((g) => g.metrics[def.key]).filter((v): v is number => v !== null);
    const yours = mean(values);

    let basis: MetricSummary['basis'] = 'players';
    let peers = store.perPlayerMeans(def.key, filter, MIN_PEER_GAMES);
    if (peers.length < MIN_PEER_PLAYERS) {
      basis = 'games';
      peers = store.perGameValues(def.key, filter);
    }
    return {
      def,
      yours,
      peerMedian: median(peers),
      betterThan: yours === null ? null : betterThan(yours, peers, def.direction),
      sampleSize: peers.length,
      basis,
    };
  });
}

export function formatValue(def: MetricDef, v: number | null): string {
  if (v === null) return '-';
  if (def.percent) return `${(v * 100).toFixed(def.decimals)}%`;
  const s = v.toFixed(def.decimals);
  return def.key.includes('Diff') && v > 0 ? `+${s}` : s;
}

export function renderTable(headers: string[], rows: string[][], rightAlign: Set<number> = new Set()): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (rightAlign.has(i) ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

export function renderGames(games: ParticipantMetrics[]): string {
  const rows = games.map((g) => [
    new Date(g.gameEndTimestamp).toISOString().slice(0, 10),
    g.championName,
    g.teamPosition || '?',
    g.win ? 'W' : 'L',
    `${g.kills}/${g.deaths}/${g.assists}`,
    formatValue(METRICS[1], g.metrics.csDiffAt10),
    formatValue(METRICS[4], g.metrics.goldDiffAt15),
    formatValue(METRICS[7], g.metrics.killParticipation),
  ]);
  return renderTable(
    ['Date', 'Champion', 'Role', 'W/L', 'K/D/A', 'CSd@10', 'GDd@15', 'KP'],
    rows,
    new Set([4, 5, 6, 7]),
  );
}

export function renderSummary(summaries: MetricSummary[]): string {
  const rows = summaries.map((s) => [
    s.def.label,
    formatValue(s.def, s.yours),
    formatValue(s.def, s.peerMedian),
    s.betterThan === null ? '-' : `${Math.round(s.betterThan * 100)}%`,
    s.betterThan === null ? '' : verdict(s.betterThan),
    `${s.sampleSize} ${s.basis}`,
  ]);
  return renderTable(['Metric', 'You', 'Peer median', 'Better than', '', 'Sample'], rows, new Set([1, 2, 3]));
}

function verdict(share: number): string {
  if (share >= 0.75) return 'strength';
  if (share <= 0.25) return 'weakness';
  return '';
}

/** Games, win rate, KDA, and lane diffs per champion+role, most played first. */
export function renderChampionPool(games: ParticipantMetrics[]): string {
  const groups = new Map<string, ParticipantMetrics[]>();
  for (const g of games) {
    const key = `${g.championName}|${g.teamPosition || '?'}`;
    groups.set(key, [...(groups.get(key) ?? []), g]);
  }
  const avg = (gs: ParticipantMetrics[], f: (g: ParticipantMetrics) => number | null) =>
    mean(gs.map(f).filter((v): v is number => v !== null));
  const rows = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, gs]) => {
      const [champ, role] = key.split('|') as [string, string];
      const wins = gs.filter((g) => g.win).length;
      const k = avg(gs, (g) => g.kills)!;
      const d = avg(gs, (g) => g.deaths)!;
      const a = avg(gs, (g) => g.assists)!;
      return [
        champ,
        role,
        String(gs.length),
        `${wins}-${gs.length - wins}`,
        `${Math.round((wins / gs.length) * 100)}%`,
        `${k.toFixed(1)}/${d.toFixed(1)}/${a.toFixed(1)}`,
        formatValue(METRICS[1], avg(gs, (g) => g.metrics.csDiffAt10)),
        formatValue(METRICS[4], avg(gs, (g) => g.metrics.goldDiffAt15)),
      ];
    });
  return renderTable(
    ['Champion', 'Role', 'Games', 'W-L', 'WR', 'Avg K/D/A', 'CSd@10', 'GDd@15'],
    rows,
    new Set([2, 3, 4, 5, 6, 7]),
  );
}
