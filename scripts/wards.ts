import { Store } from '../src/db';
import { apexLpScore } from '../src/rank';
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const P = arg('puuid', 'AQ1XAcwjaZ3W1ViZGbU2G7bESXGupurEtH1dfsZEwbpkK72ZhV6kpOPJm0i-SaRi3SBdXmCiGSFENA');
const ROLE = arg('role', 'TOP').toUpperCase();
const MIN_LP = Number(arg('min-lp', '600'));
const CHAMPS = arg('champions', 'Riven,Camille').split(',');
const store = new Store('data/lol.db');
const since = Date.parse('2026-01-08T20:00:00Z');
const refs = [
  ...store.playerGames(P, 5000, { queueId: 420, sinceMs: since }).filter((g) => g.teamPosition === ROLE).map((g) => ({ matchId: g.matchId, puuid: P, who: 'him' })),
  ...store.peerGameRefs({ role: ROLE, excludePuuid: P, queueId: 420, minRankScore: apexLpScore(MIN_LP) }).map((r) => ({ ...r, who: 'peer' })),
];
type Acc = Record<string, number>;
const groups: Record<string, { n: number; min: number; s: Acc; any: Acc }> = {};
const add = (g: string, min: number, v: Acc) => {
  const G = (groups[g] ??= { n: 0, min: 0, s: {}, any: {} });
  G.n++; G.min += min;
  for (const [k, x] of Object.entries(v)) { G.s[k] = (G.s[k] ?? 0) + x; G.any[k] = (G.any[k] ?? 0) + (x > 0 ? 1 : 0); }
};
for (const r of refs) {
  const g = store.loadGame(r.matchId);
  if (!g || g.match.info.gameDuration < 900) continue;
  const p = g.match.info.participants.find((x) => x.puuid === r.puuid) as any;
  if (!p || p.teamPosition !== ROLE) continue;
  const id = p.participantId;
  const ev = g.timeline.info.frames.flatMap((f) => f.events) as any[];
  const placed = ev.filter((e) => e.type === 'WARD_PLACED' && e.creatorId === id);
  const ty = (t: string) => placed.filter((e) => e.wardType === t).length;
  const buys = (item: number) => ev.filter((e) => e.type === 'ITEM_PURCHASED' && e.participantId === id && e.itemId === item).length;
  const ch = p.challenges ?? {};
  const v: Acc = {
    'Wards placed (all)': p.wardsPlaced ?? 0,
    '  yellow trinket': ty('YELLOW_TRINKET'),
    '  stealth wards (support item etc.)': ty('SIGHT_WARD'),
    '  farsight (blue trinket)': ty('BLUE_TRINKET'),
    '  control wards': ty('CONTROL_WARD'),
    'Control wards bought': p.visionWardsBoughtInGame ?? 0,
    'Wards placed before 14:00': placed.filter((e) => e.timestamp < 840_000 && ['YELLOW_TRINKET', 'BLUE_TRINKET', 'CONTROL_WARD', 'SIGHT_WARD'].includes(e.wardType)).length,
    'Enemy wards cleared': p.wardsKilled ?? 0,
    'Ward takedowns before 20:00': ch.wardTakedownsBefore20M ?? 0,
    'Swapped to Oracle Lens (sweeper)': buys(3364) > 0 ? 1 : 0,
    'Swapped to Farsight (blue)': buys(3363) > 0 ? 1 : 0,
    'Vision score': p.visionScore ?? 0,
    'Vision score vs lane opponent (x100)': (ch.visionScoreAdvantageLaneOpponent ?? 0) * 100,
    'Control ward coverage river/enemy half (x100)': (ch.controlWardTimeCoverageInRiverOrEnemyHalf ?? 0) * 100,
  };
  const min = g.match.info.gameDuration / 60;
  add(r.who, min, v);
  if (CHAMPS.includes(p.championName)) add(`${r.who}-${p.championName}`, min, v);
}
const cols = ['him', 'peer', ...CHAMPS.flatMap((c) => [`him-${c}`, `peer-${c}`])].filter((c) => groups[c]);
const jsonPath = arg('json', '');
if (jsonPath) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(jsonPath, JSON.stringify(Object.fromEntries(cols.map((c) => {
    const G = groups[c]!;
    return [c, { games: G.n, minutes: G.min, perGame: Object.fromEntries(Object.entries(G.s).map(([k, x]) => [k, x / G.n])), anyShare: Object.fromEntries(Object.entries(G.any).map(([k, x]) => [k, x / G.n])) }];
  }))));
}
const keys = Object.keys(groups.peer!.s);
const rate = new Set(['Swapped to Oracle Lens (sweeper)', 'Swapped to Farsight (blue)']);
console.log('Per game (per 10 min in brackets); swaps = % of games'.padEnd(48) + cols.map((c) => c.padStart(17)).join(''));
console.log('games'.padEnd(48) + cols.map((c) => String(groups[c]!.n).padStart(17)).join(''));
for (const k of keys) {
  console.log(k.padEnd(48) + cols.map((c) => {
    const G = groups[c]!;
    if (rate.has(k)) return `${Math.round((100 * G.s[k]!) / G.n)}%`.padStart(17);
    const pg = G.s[k]! / G.n, p10 = (10 * G.s[k]!) / G.min;
    return `${pg.toFixed(2)} (${p10.toFixed(2)})`.padStart(17);
  }).join(''));
}
console.log('% of games with any control ward bought'.padEnd(48) + cols.map((c) => `${Math.round((100 * groups[c]!.any['Control wards bought']!) / groups[c]!.n)}%`.padStart(17)).join(''));
