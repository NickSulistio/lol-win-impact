import { renderTable } from '../report';
import type { GameFeatures } from './features';

type G = GameFeatures;
type Better = 'higher' | 'lower' | undefined;

export interface Group {
  name: string;
  games: G[];
}

export interface Row {
  label: string;
  better: Better;
  /** Per-game value for mean-type rows. */
  perGame?: (g: G) => number | null;
  /** Pooled ratio for rate-type rows. */
  ratio?: { num: (g: G) => number; den: (g: G) => number };
  fmt: (v: number) => string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const n1 = (v: number) => v.toFixed(1);
const n2 = (v: number) => v.toFixed(2);
const signed0 = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}`;
const signed1 = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;

function values(gs: G[], f: (g: G) => number | null): number[] {
  return gs.map(f).filter((v): v is number => v !== null && Number.isFinite(v));
}
function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function sd(xs: number[]): number | null {
  const m = mean(xs);
  if (m === null || xs.length < 2) return null;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
export function rowValue(row: Row, gs: G[]): number | null {
  if (row.perGame) return mean(values(gs, row.perGame));
  const num = gs.reduce((a, g) => a + row.ratio!.num(g), 0);
  const den = gs.reduce((a, g) => a + row.ratio!.den(g), 0);
  return den > 0 ? num / den : null;
}

/** "better"/"worse" when the gap is meaningful: 0.25 SD for means, 15% relative for rates. */
export function verdict(row: Row, you: number | null, peers: number | null, peerGames: G[]): string {
  if (!row.better || you === null || peers === null) return '';
  let gap: number;
  if (row.perGame) {
    const s = sd(values(peerGames, row.perGame));
    if (!s) return '';
    gap = (you - peers) / s;
    if (Math.abs(gap) < 0.25) return '';
  } else {
    if (peers === 0 || Math.abs(you - peers) < 0.03) return '';
    gap = you / peers - 1;
    if (Math.abs(gap) < 0.15) return '';
  }
  const good = row.better === 'higher' ? gap > 0 : gap < 0;
  return good ? 'better' : 'WORSE';
}

function renderRows(rows: Row[], groups: Group[], peers: Group): string {
  const cols = [...groups, peers];
  const youAll = groups[0]!;
  const body = rows.map((row) => {
    const vals = cols.map((g) => rowValue(row, g.games));
    return [
      row.label,
      ...vals.map((v) => (v === null ? '-' : row.fmt(v))),
      verdict(row, vals[0]!, vals.at(-1)!, peers.games),
    ];
  });
  return renderTable(
    ['', ...cols.map((c) => c.name), `${youAll.name} vs peers`],
    body,
    new Set(cols.map((_, i) => i + 1)),
  );
}

export const LANING: Row[] = [
  { label: 'Gold diff @7', perGame: (g) => g.gd7, fmt: signed0, better: 'higher' },
  { label: 'Gold diff @14', perGame: (g) => g.gd14, fmt: signed0, better: 'higher' },
  { label: 'CS diff @14', perGame: (g) => g.csd14, fmt: signed1, better: 'higher' },
  { label: 'XP diff @14', perGame: (g) => g.xpd14, fmt: signed0, better: 'higher' },
  { label: 'Lane won (gold @14 >= +500)', perGame: (g) => (g.gd14 === null ? null : +(g.gd14 >= 500)), fmt: pct, better: 'higher' },
  { label: 'Lane lost (gold @14 <= -500)', perGame: (g) => (g.gd14 === null ? null : +(g.gd14 <= -500)), fmt: pct, better: 'lower' },
  { label: 'Takedowns on lane opp <14m', perGame: (g) => g.laneTakedownsOnOpp, fmt: n2, better: 'higher' },
  { label: 'Solo kills <14m', perGame: (g) => g.soloKillsEarly, fmt: n2, better: 'higher' },
  { label: 'Deaths <14m', perGame: (g) => g.earlyDeaths, fmt: n2, better: 'lower' },
  { label: '  of which ganked by jungler', perGame: (g) => g.gankDeaths, fmt: n2, better: 'lower' },
  { label: '  of which solo-killed by lane opp', perGame: (g) => g.soloDeathsToOpp, fmt: n2, better: 'lower' },
  { label: 'Plates taken - lost', perGame: (g) => g.platesTaken - g.platesLost, fmt: signed1, better: 'higher' },
  { label: 'First tower in lane is ours', perGame: (g) => (g.firstLaneTower === 'none' ? null : +(g.firstLaneTower === 'ours')), fmt: pct, better: 'higher' },
];

export const FIGHTS: Row[] = [
  { label: 'Teamfights per game (3+ deaths)', perGame: (g) => g.fights, fmt: n1, better: undefined },
  { label: 'Fight participation', ratio: { num: (g) => g.fightsPresent, den: (g) => g.fights }, fmt: pct, better: 'higher' },
  { label: 'Fights won when he is in them', ratio: { num: (g) => g.fightsWonPresent, den: (g) => g.fightsPresent }, fmt: pct, better: 'higher' },
  { label: 'Fights lost when he is in them', ratio: { num: (g) => g.fightsLostPresent, den: (g) => g.fightsPresent }, fmt: pct, better: 'lower' },
  { label: 'Fights won without him', ratio: { num: (g) => g.fightsWonAbsent, den: (g) => g.fights - g.fightsPresent }, fmt: pct, better: undefined },
  { label: 'Dies in fights he joins', ratio: { num: (g) => g.fightDeaths, den: (g) => g.fightsPresent }, fmt: pct, better: 'lower' },
  { label: 'First on his team to die', ratio: { num: (g) => g.firstAllyDeaths, den: (g) => g.fightsPresent }, fmt: pct, better: 'lower' },
  { label: 'Takedowns per fight joined', ratio: { num: (g) => g.fightTakedowns, den: (g) => g.fightsPresent }, fmt: n2, better: 'higher' },
];

export const OBJECTIVES: Row[] = [
  { label: 'Present for team epic monsters', ratio: { num: (g) => g.allyObjectivesPresent, den: (g) => g.allyObjectives }, fmt: pct, better: 'higher' },
  { label: 'Enemy epic monsters per game', perGame: (g) => g.enemyObjectives, fmt: n2, better: 'lower' },
  { label: 'On enemy objectives he was:', perGame: () => null, fmt: n1, better: undefined },
  { label: '  dead', ratio: { num: (g) => g.enemyObjDead, den: (g) => g.enemyObjectives }, fmt: pct, better: 'lower' },
  { label: '  nearby but lost it', ratio: { num: (g) => g.enemyObjNear, den: (g) => g.enemyObjectives }, fmt: pct, better: undefined },
  { label: '  far, team took a tower (trade)', ratio: { num: (g) => g.enemyObjFarTraded, den: (g) => g.enemyObjectives }, fmt: pct, better: 'higher' },
  { label: '  far, no trade', ratio: { num: (g) => g.enemyObjFarNoTrade, den: (g) => g.enemyObjectives }, fmt: pct, better: 'lower' },
];

export const MACRO: Row[] = [
  { label: 'Time isolated from team (15m+)', perGame: (g) => g.isolationRate, fmt: pct, better: undefined },
  { label: 'Towers taken after 14m (incl. assists)', perGame: (g) => g.towersAfterLane, fmt: n2, better: 'higher' },
  { label: 'Deaths 14-25m', perGame: (g) => g.midDeaths, fmt: n2, better: 'lower' },
  { label: 'Deaths 25m+', perGame: (g) => g.lateDeaths, fmt: n2, better: 'lower' },
  { label: 'Deaths with no teammate within 4000', perGame: (g) => g.isolatedDeaths, fmt: n2, better: 'lower' },
  { label: 'Deaths while team ahead 1.5k+', perGame: (g) => g.deathsWhileAhead, fmt: n2, better: 'lower' },
];

interface Split {
  label: string;
  a: { label: string; pred: (g: G) => boolean };
  b: { label: string; pred: (g: G) => boolean };
}

const SPLITS: Split[] = [
  { label: 'Lane result @14', a: { label: 'won lane', pred: (g) => (g.gd14 ?? 0) >= 500 }, b: { label: 'lost lane', pred: (g) => (g.gd14 ?? 0) <= -500 } },
  { label: 'Early deaths', a: { label: '0 deaths <14m', pred: (g) => g.earlyDeaths === 0 }, b: { label: '2+ deaths <14m', pred: (g) => g.earlyDeaths >= 2 } },
  { label: 'Isolated deaths', a: { label: '0 isolated deaths', pred: (g) => g.isolatedDeaths === 0 }, b: { label: '2+ isolated deaths', pred: (g) => g.isolatedDeaths >= 2 } },
  { label: 'Dying first in fights', a: { label: 'never first', pred: (g) => g.firstAllyDeaths === 0 }, b: { label: 'first 2+ times', pred: (g) => g.firstAllyDeaths >= 2 } },
  { label: 'Fight participation', a: { label: '>= 60% of fights', pred: (g) => g.fights > 0 && g.fightsPresent / g.fights >= 0.6 }, b: { label: '< 40% of fights', pred: (g) => g.fights > 0 && g.fightsPresent / g.fights < 0.4 } },
  { label: 'Objective presence', a: { label: '>= 50% of team objs', pred: (g) => g.allyObjectives > 0 && g.allyObjectivesPresent / g.allyObjectives >= 0.5 }, b: { label: '< 25% of team objs', pred: (g) => g.allyObjectives > 0 && g.allyObjectivesPresent / g.allyObjectives < 0.25 } },
  { label: 'Side-lane pressure', a: { label: '2+ towers after 14m (partly a result of winning)', pred: (g) => g.towersAfterLane >= 2 }, b: { label: '0 towers after 14m', pred: (g) => g.towersAfterLane === 0 } },
];

function wr(gs: G[]): string {
  if (!gs.length) return '-';
  return `${pct(gs.filter((g) => g.win).length / gs.length)} (${gs.length})`;
}

function renderSplits(you: Group, peers: Group): string {
  const rows = SPLITS.map((s) => {
    const ya = you.games.filter(s.a.pred);
    const yb = you.games.filter(s.b.pred);
    const pa = peers.games.filter(s.a.pred);
    const pb = peers.games.filter(s.b.pred);
    const swing = (a: G[], b: G[]) =>
      a.length >= 10 && b.length >= 10
        ? Math.round((a.filter((g) => g.win).length / a.length - b.filter((g) => g.win).length / b.length) * 100)
        : null;
    const ys = swing(ya, yb);
    const ps = swing(pa, pb);
    return {
      ys: ys ?? 0,
      cells: [
        `${s.a.label} vs ${s.b.label}`,
        wr(ya),
        wr(yb),
        ys === null ? '-' : `${ys > 0 ? '+' : ''}${ys}`,
        wr(pa),
        wr(pb),
        ps === null ? '-' : `${ps > 0 ? '+' : ''}${ps}`,
      ],
    };
  }).sort((a, b) => Math.abs(b.ys) - Math.abs(a.ys));
  return renderTable(
    ['Condition (A vs B)', 'His WR: A (n)', 'B (n)', 'Swing', 'Peers: A (n)', 'B (n)', 'Swing'],
    rows.map((r) => r.cells),
    new Set([1, 2, 3, 4, 5, 6]),
  );
}

const STATE_BUCKETS: { label: string; pred: (gd: number) => boolean }[] = [
  { label: 'team ahead 3k+', pred: (gd) => gd >= 3000 },
  { label: 'ahead 1-3k', pred: (gd) => gd >= 1000 && gd < 3000 },
  { label: 'even (+/-1k)', pred: (gd) => gd > -1000 && gd < 1000 },
  { label: 'behind 1-3k', pred: (gd) => gd <= -1000 && gd > -3000 },
  { label: 'behind 3k+', pred: (gd) => gd <= -3000 },
];

function renderGameState(you: Group, peers: Group): string {
  const rows = STATE_BUCKETS.map((b) => {
    const y = you.games.filter((g) => g.teamGd20 !== null && b.pred(g.teamGd20));
    const p = peers.games.filter((g) => g.teamGd20 !== null && b.pred(g.teamGd20));
    const share = (gs: G[], all: G[]) => pct(gs.length / Math.max(1, all.filter((g) => g.teamGd20 !== null).length));
    return [b.label, share(y, you.games), wr(y), share(p, peers.games), wr(p)];
  });
  return renderTable(['Team gold @20', 'His games', 'His WR (n)', 'Peer games', 'Peer WR (n)'], rows, new Set([1, 2, 3, 4]));
}

/** What his wins and losses look like, side by side. */
function renderWinLoss(you: Group): string {
  const wins = you.games.filter((g) => g.win);
  const losses = you.games.filter((g) => !g.win);
  const rows: Row[] = [
    LANING[1]!, LANING[8]!, FIGHTS[1]!, FIGHTS[2]!, FIGHTS[6]!, OBJECTIVES[0]!, MACRO[1]!, MACRO[2]!, MACRO[3]!, MACRO[4]!,
  ];
  const body = rows.map((r) => {
    const w = rowValue(r, wins);
    const l = rowValue(r, losses);
    return [r.label, w === null ? '-' : r.fmt(w), l === null ? '-' : r.fmt(l)];
  });
  return renderTable(['', `Wins (${wins.length})`, `Losses (${losses.length})`], body, new Set([1, 2]));
}

export function renderDeepReport(groups: Group[], peers: Group): string {
  const you = groups[0]!;
  const out: string[] = [];
  const section = (title: string, body: string) => out.push(`\n## ${title}\n${body}`);
  section('Laning phase (0-14 min, vs enemy top laner)', renderRows(LANING, groups, peers));
  section('Teamfights (14 min+, 3+ deaths within 15s chains)', renderRows(FIGHTS, groups, peers));
  section('Objectives (dragon, grubs, herald, baron, atakhan)', renderRows(OBJECTIVES, groups, peers));
  section('Macro and side lane (14 min+)', renderRows(MACRO, groups, peers));
  section('Lead conversion: win rate by team gold at 20 min', renderGameState(you, peers));
  section('What swings his win rate (biggest swing first; n >= 10 per side)', renderSplits(you, peers));
  section('His wins vs his losses', renderWinLoss(you));
  return out.join('\n');
}
