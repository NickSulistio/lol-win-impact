/**
 * Tests coaching heuristics against stored matches. Each row is a match from blue's
 * perspective; features are blue minus red. Each heuristic is a logistic regression of
 * blue win on the heuristic plus controls for the game state when its window starts,
 * so "already winning" is held fixed as far as the data allows.
 *
 *   node --import tsx scripts/heuristics.ts
 */
import { DatabaseSync } from 'node:sqlite';
import { frameAtMinute, gameDurationSeconds } from '../src/metrics/compute';
import { isChampionKill, isEliteMonsterKill, type FrameDto, type MatchDto, type TimelineDto, type TimelineEvent } from '../src/riot/types';

const MIN = 60_000;
const db = new DatabaseSync('data/lol.db');
const rows = db.prepare(`SELECT match_json, timeline_json FROM matches WHERE queue_id = 420`).all() as { match_json: string; timeline_json: string }[];

type Feat = Record<string, number>;
const data: { win: number; durMin: number; f: Feat }[] = [];

for (const r of rows) {
  const match = JSON.parse(r.match_json) as MatchDto;
  const tl = JSON.parse(r.timeline_json) as TimelineDto;
  const dur = gameDurationSeconds(match) / 60;
  if (dur < 20) continue;
  const parts = match.info.participants;
  const team = new Map(parts.map((p) => [p.participantId, p.teamId]));
  const sgn = (t: number | undefined) => (t === 100 ? 1 : t === 200 ? -1 : 0);
  const ev = tl.info.frames.flatMap((f) => f.events);
  const kills = ev.filter(isChampionKill);
  const mons = ev.filter(isEliteMonsterKill);
  type B = TimelineEvent & { teamId: number; buildingType: string; killerId: number };
  const blds = ev.filter((e) => e.type === 'BUILDING_KILL') as B[];
  const wards = ev.filter((e) => e.type === 'WARD_PLACED') as (TimelineEvent & { creatorId: number; wardType: string })[];
  const lvls = ev.filter((e) => e.type === 'LEVEL_UP') as (TimelineEvent & { participantId: number; level: number })[];
  const killerTeam = (k: (typeof kills)[number]) => (k.killerId > 0 ? team.get(k.killerId)! : team.get(k.victimId) === 100 ? 200 : 100);
  const victimSign = (k: (typeof kills)[number]) => sgn(team.get(k.victimId)); // +1 when blue died

  const gold = (f: FrameDto | undefined, t: number) => parts.filter((p) => p.teamId === t).reduce((a, p) => a + (f?.participantFrames[String(p.participantId)]?.totalGold ?? NaN), 0);
  const gd = (m: number) => { const f = frameAtMinute(tl, m); return (gold(f, 100) - gold(f, 200)) / 1000; };
  // Towers destroyed BY blue minus BY red (the building's teamId is the side that lost it).
  const towersBy = (t: number) => blds.filter((b) => b.buildingType === 'TOWER_BUILDING' && b.timestamp < t).reduce((a, b) => a - sgn(b.teamId), 0);
  const deathsIn = (a: number, b: number) => kills.filter((k) => k.timestamp >= a && k.timestamp < b).reduce((s, k) => s + victimSign(k), 0);
  const lateDeaths = kills.filter((k) => k.timestamp >= 14 * MIN);

  const frameBefore = (t: number) => tl.info.frames.filter((f) => f.timestamp <= t).at(-1);
  const withGold = lateDeaths.filter((k) => {
    const f = frameBefore(k.timestamp);
    return f && k.timestamp - f.timestamp <= 30_000 && (f.participantFrames[String(k.victimId)] as { currentGold?: number })?.currentGold! >= 1500;
  });
  // Died <60s before an epic monster taken by the OTHER team (lost setup) vs by your OWN team (traded a death for it).
  const before = (k: (typeof kills)[number], own: boolean) => mons.some((m) => (m.killerTeamId === team.get(k.victimId)) === own && m.timestamp > k.timestamp && m.timestamp - k.timestamp <= MIN);
  const setupDeathsLost = lateDeaths.filter((k) => before(k, false));
  const setupDeathsOwn = lateDeaths.filter((k) => before(k, true));
  const converted = lateDeaths.filter((k) => {
    const kt = killerTeam(k);
    return blds.some((b) => b.teamId !== kt && b.timestamp > k.timestamp && b.timestamp - k.timestamp <= 90_000) ||
      mons.some((m) => m.killerTeamId === kt && m.timestamp > k.timestamp && m.timestamp - k.timestamp <= 90_000);
  });
  const lateMons = mons.filter((m) => m.timestamp >= 14 * MIN);
  const trades = lateMons.filter((m) => blds.some((b) => b.teamId === m.killerTeamId && Math.abs(b.timestamp - m.timestamp) <= 90_000));
  const setupWards = lateMons.flatMap((m) => wards.filter((w) => w.creatorId > 0 && w.timestamp <= m.timestamp && m.timestamp - w.timestamp <= 90_000));
  const lvl6 = (pos: string) => {
    const t = (tid: number) => { const p = parts.find((x) => x.teamId === tid && x.teamPosition === pos); return p ? lvls.find((l) => l.participantId === p.participantId && l.level === 6)?.timestamp : undefined; };
    const a = t(100), b = t(200);
    return a === undefined || b === undefined ? 0 : a < b ? 1 : a > b ? -1 : 0;
  };

  const f: Feat = {
    gd6: gd(6), gd7: gd(7), gd14: gd(14), gd25: dur >= 25 ? gd(25) : NaN, tw14: towersBy(14 * MIN), tw25: towersBy(25 * MIN),
    deaths0_14: deathsIn(0, 14 * MIN), deaths14_25: deathsIn(14 * MIN, 25 * MIN), deaths25plus: dur >= 25 ? deathsIn(25 * MIN, 1e9) : NaN,
    deathsLate: lateDeaths.reduce((s, k) => s + victimSign(k), 0),
    deathsWithGold: withGold.reduce((s, k) => s + victimSign(k), 0),
    shutdownGiven: lateDeaths.reduce((s, k) => s + victimSign(k) * ((k as { shutdownBounty?: number }).shutdownBounty ?? 0), 0) / 1000,
    setupDeathsLost: setupDeathsLost.reduce((s, k) => s + victimSign(k), 0),
    setupDeathsOwn: setupDeathsOwn.reduce((s, k) => s + victimSign(k), 0),
    killsLate: lateDeaths.reduce((s, k) => s + sgn(killerTeam(k)), 0),
    convertedKills: converted.reduce((s, k) => s + sgn(killerTeam(k)), 0),
    lateMonsters: lateMons.reduce((s, m) => s + sgn(m.killerTeamId), 0),
    trades: trades.reduce((s, m) => s - sgn(m.killerTeamId), 0), // credited to the side that conceded
    setupWards: setupWards.reduce((s, w) => s + sgn(team.get(w.creatorId)), 0) / 10,
    controlWards14: wards.filter((w) => w.wardType === 'CONTROL_WARD' && w.timestamp < 14 * MIN && w.creatorId > 0).reduce((s, w) => s + sgn(team.get(w.creatorId)), 0),
    grubs: mons.filter((m) => m.monsterType === 'HORDE').reduce((s, m) => s + sgn(m.killerTeamId), 0),
    level6First: lvl6('TOP') + lvl6('MIDDLE'),
  };
  data.push({ win: match.info.participants.find((p) => p.teamId === 100)!.win ? 1 : 0, durMin: dur, f });
}

/** Logistic regression by Newton/IRLS; returns coefficients and standard errors. */
function logit(X: number[][], y: number[]) {
  const k = X[0]!.length;
  let w = new Array(k).fill(0);
  let cov: number[][] = [];
  for (let it = 0; it < 25; it++) {
    const g = new Array(k).fill(0);
    const H = Array.from({ length: k }, () => new Array(k).fill(0));
    X.forEach((x, i) => {
      const p = 1 / (1 + Math.exp(-x.reduce((a, v, j) => a + v * w[j], 0)));
      for (let a = 0; a < k; a++) { g[a] += (y[i]! - p) * x[a]!; for (let b = 0; b < k; b++) H[a]![b] += p * (1 - p) * x[a]! * x[b]!; }
    });
    for (let a = 0; a < k; a++) H[a]![a] += 1e-6;
    cov = invert(H);
    w = w.map((v, a) => v + cov[a]!.reduce((s, c, b) => s + c * g[b]!, 0));
  }
  return { w, se: w.map((_, a) => Math.sqrt(cov[a]![a]!)) };
}
function invert(m: number[][]): number[][] {
  const n = m.length, a = m.map((r, i) => [...r, ...r.map((_, j) => +(i === j))]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r;
    [a[c], a[p]] = [a[p]!, a[c]!];
    const d = a[c]![c]!; for (let j = 0; j < 2 * n; j++) a[c]![j]! /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const fct = a[r]![c]!; for (let j = 0; j < 2 * n; j++) a[r]![j] -= fct * a[c]![j]!; }
  }
  return a.map((r) => r.slice(n));
}

interface Test { name: string; unit: string; x: string; controls: string[]; minDur?: number }
const TESTS: Test[] = [
  { name: 'Death in laning phase (0-14m)', unit: 'per death', x: 'deaths0_14', controls: ['gd6'] },
  { name: 'Death in mid game (14-25m)', unit: 'per death', x: 'deaths14_25', controls: ['gd14', 'tw14'] },
  { name: 'Death in late game (25m+)', unit: 'per death', x: 'deaths25plus', controls: ['gd25', 'tw25'], minDur: 25 },
  { name: 'Dying with 1500+ unspent gold', unit: 'per such death', x: 'deathsWithGold', controls: ['gd14', 'tw14', 'deathsLate'] },
  { name: 'Shutdown gold given up', unit: 'per 1000g', x: 'shutdownGiven', controls: ['gd14', 'tw14', 'deathsLate'] },
  { name: 'Dying <60s before ENEMY takes epic monster', unit: 'per such death', x: 'setupDeathsLost', controls: ['gd14', 'tw14', 'deathsLate'] },
  { name: 'Dying <60s before OWN team takes it', unit: 'per such death', x: 'setupDeathsOwn', controls: ['gd14', 'tw14', 'deathsLate'] },
  { name: 'Kill converted to tower/objective <90s', unit: 'per converted kill', x: 'convertedKills', controls: ['gd14', 'tw14', 'killsLate'] },
  { name: 'Cross-map trade when conceding objective', unit: 'per trade', x: 'trades', controls: ['gd14', 'tw14', 'lateMonsters'] },
  { name: 'Wards placed <90s before objectives', unit: 'per 10 wards', x: 'setupWards', controls: ['gd14', 'tw14'] },
  { name: 'Control wards placed before 14m', unit: 'per ward', x: 'controlWards14', controls: ['gd6'] },
  { name: 'Void grubs taken', unit: 'per grub', x: 'grubs', controls: ['gd6'] },
  { name: 'Hitting level 6 first (top + mid)', unit: 'per lane', x: 'level6First', controls: ['gd6'] },
];

console.log(`${data.length} solo-queue matches (20+ min). Effect = change in win probability at a 50/50 game, holding controls fixed.\n`);
const out = TESTS.map((t) => {
  const d = data.filter((r) => r.durMin >= (t.minDur ?? 0) && [t.x, ...t.controls].every((c) => Number.isFinite(r.f[c]!)));
  const { w, se } = logit(d.map((r) => [1, ...t.controls.map((c) => r.f[c]!), r.f[t.x]!]), d.map((r) => r.win));
  const b = w.at(-1)!, s = se.at(-1)!;
  const pp = (v: number) => `${v > 0 ? '+' : ''}${(v * 25).toFixed(1)}`;
  const sig = Math.abs(b / s) >= 1.96 ? (b > 0 ? 'helps' : 'hurts') : 'unclear';
  return [t.name, t.unit, `${pp(b)} pp`, `[${pp(b - 1.96 * s)}, ${pp(b + 1.96 * s)}]`, sig, t.controls.join(', '), String(d.length)];
});
const head = ['Heuristic', 'Unit', 'Effect', '95% CI', 'Verdict', 'Held fixed', 'n'];
const wd = head.map((h, i) => Math.max(h.length, ...out.map((r) => r[i]!.length)));
console.log(head.map((h, i) => h.padEnd(wd[i]!)).join('  '));
console.log(wd.map((x) => '-'.repeat(x)).join('  '));
for (const r of out) console.log(r.map((c, i) => c.padEnd(wd[i]!)).join('  '));
