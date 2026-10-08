/**
 * Why does recalling after a solo kill cost oRegret more than peers?
 * For every pre-14:00 solo kill on the lane opponent followed by a recall (no plates) within 90s,
 * decompose the next 3 minutes of his team's win-probability change and describe the lane.
 */
import { Store } from '../src/db';
import { findSituations } from '../src/insights/situations';
import { apexLpScore } from '../src/rank';
import type { MatchDto, TimelineDto } from '../src/riot/types';
import { loadModel, predict } from '../src/wp/model';
import { GameTimeline } from '../src/wp/state';

const P = 'AQ1XAcwjaZ3W1ViZGbU2G7bESXGupurEtH1dfsZEwbpkK72ZhV6kpOPJm0i-SaRi3SBdXmCiGSFENA';
const WINDOW = 180_000;
const store = new Store('data/lol.db');
const model = loadModel('data/wp-model.json');

// Outer top towers (blue, red) for lane-progress of the kill position.
const TOWERS = { 100: { x: 981, y: 10441 }, 200: { x: 4318, y: 13875 } } as const;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

interface Case {
  who: 'him' | 'peer';
  champion: string;
  response: string;
  dWp: number;
  parts: Record<string, number>;
  killMin: number;
  recallDelay: number | null; // s from kill to first purchase
  progress: number | null; // 0 = at own outer tower, 1 = at enemy outer tower
  diedInWindow: boolean;
  diedToJungler: boolean;
  platesLost: number;
  platesTaken: number;
  laneGoldSwing: number; // change of (his gold - opp gold) over the window, net of the kill bounty
  csSwing: number;
  xpSwing: number;
  oppBackFirst: boolean | null;
  diedBeforeBuy: boolean; // the 'recall' purchase came after dying (fountain buy on respawn)
  deathDelay: number | null; // s from kill to his first death in the window // opp reached lane again before him (first position frame near lane)
  win: boolean;
}

function analyzeGame(match: MatchDto, timeline: TimelineDto, puuid: string, who: Case['who']): Case[] {
  const sits = findSituations(match, timeline, puuid, model).filter((s) => s.kind === 'solo-kill-in-lane');
  if (!sits.length) return [];
  const gt = new GameTimeline(match, timeline);
  const me = match.info.participants.find((p) => p.puuid === puuid)!;
  const opp = match.info.participants.find((p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition);
  if (!opp) return [];
  const team = me.teamId;
  const wp = (t: number, inclusive = true) => {
    if (t >= gt.endMs) return me.win ? 1 : 0;
    const p = predict(model, gt.stateAt(t, inclusive));
    return team === 100 ? p : 1 - p;
  };
  const frames = timeline.info.frames;
  const pfAt = (id: number, t: number, key: 'totalGold' | 'minionsKilled' | 'xp') => {
    const i = Math.min(frames.length - 2, Math.floor(t / 60_000));
    const a = frames[i]!.participantFrames[String(id)]!;
    const b = frames[i + 1]!.participantFrames[String(id)]!;
    const v = (f: typeof a) => (key === 'minionsKilled' ? f.minionsKilled + f.jungleMinionsKilled : f[key]);
    const f = (t - frames[i]!.timestamp) / 60_000;
    return v(a) + Math.min(1, Math.max(0, f)) * (v(b) - v(a));
  };
  const events = frames.flatMap((f) => f.events);
  const purchases = events.filter((e) => e.type === 'ITEM_PURCHASED') as unknown as { timestamp: number; participantId: number }[];
  const plates = events.filter((e) => e.type === 'TURRET_PLATE_DESTROYED') as unknown as { timestamp: number; teamId: number; laneType: string }[];
  const enemyJungler = match.info.participants.find((p) => p.teamId !== team && p.teamPosition === 'JUNGLE')?.participantId;

  return sits.map((s) => {
    const t = s.t;
    const end = t + WINDOW;
    const inWin = (x: number) => x > t && x <= end;
    // Decompose: each discrete event's own WP jump, by type; the remainder is gold/XP drift.
    const parts: Record<string, number> = { 'his deaths': 0, 'teammate deaths': 0, 'kills for his team': 0, 'towers': 0, 'objectives': 0 };
    const jump = (x: number) => wp(x, true) - wp(x, false);
    for (const k of gt.kills.filter((k) => inWin(k.timestamp))) {
      const key = k.victimId === me.participantId ? 'his deaths' : gt.teamOf.get(k.victimId) === team ? 'teammate deaths' : 'kills for his team';
      parts[key]! += jump(k.timestamp);
    }
    for (const b of gt.buildings.filter((b) => inWin(b.timestamp))) parts.towers! += jump(b.timestamp);
    for (const m of gt.monsters.filter((m) => inWin(m.timestamp))) parts.objectives! += jump(m.timestamp);
    const eventSum = Object.values(parts).reduce((a, b) => a + b, 0);
    parts['gold/XP drift (farm, plates, waves)'] = s.dWp - eventSum;

    const kill = gt.kills.find((k) => k.timestamp === t && k.killerId === me.participantId);
    const recall = purchases.find((p) => p.participantId === me.participantId && p.timestamp > t && p.timestamp - t <= 90_000);
    const myDeaths = gt.kills.filter((k) => k.victimId === me.participantId && inWin(k.timestamp));
    const bounty = (kill as unknown as { bounty?: number; shutdownBounty?: number }) ?? {};
    const killGold = (bounty.bounty ?? 300) + (bounty.shutdownBounty ?? 0);
    const t0 = t + 1000; // just after the kill gold lands
    let progress: number | null = null;
    if (kill?.position) {
      const own = dist(kill.position, TOWERS[team as 100 | 200]);
      const enemy = dist(kill.position, TOWERS[(team === 100 ? 200 : 100) as 100 | 200]);
      progress = own / (own + enemy);
    }
    // Who is back in lane first: first frame after the kill where each is within 3000 of the lane midpoint between outer towers.
    const mid = { x: (TOWERS[100].x + TOWERS[200].x) / 2, y: (TOWERS[100].y + TOWERS[200].y) / 2 };
    const backAt = (id: number) => {
      for (const f of frames) {
        if (f.timestamp <= t + 30_000 || f.timestamp > end + 60_000) continue;
        const pos = f.participantFrames[String(id)]?.position;
        if (pos && dist(pos, mid) < 3500) return f.timestamp;
      }
      return Infinity;
    };
    const meBack = backAt(me.participantId);
    const oppBack = backAt(opp.participantId);
    return {
      who,
      champion: me.championName,
      response: s.response,
      dWp: s.dWp,
      parts,
      killMin: t / 60_000,
      recallDelay: recall ? (recall.timestamp - t) / 1000 : null,
      progress,
      diedInWindow: myDeaths.length > 0,
      diedToJungler: myDeaths.some((k) => k.killerId === enemyJungler || (k.assistingParticipantIds ?? []).includes(enemyJungler ?? -1)),
      platesLost: plates.filter((p) => inWin(p.timestamp) && p.laneType === 'TOP_LANE' && p.teamId === team).length,
      platesTaken: plates.filter((p) => inWin(p.timestamp) && p.laneType === 'TOP_LANE' && p.teamId !== team).length,
      laneGoldSwing: pfAt(me.participantId, end) - pfAt(opp.participantId, end) - (pfAt(me.participantId, t0) - pfAt(opp.participantId, t0)),
      csSwing: pfAt(me.participantId, end, 'minionsKilled') - pfAt(opp.participantId, end, 'minionsKilled') - (pfAt(me.participantId, t0, 'minionsKilled') - pfAt(opp.participantId, t0, 'minionsKilled')),
      xpSwing: pfAt(me.participantId, end, 'xp') - pfAt(opp.participantId, end, 'xp') - (pfAt(me.participantId, t0, 'xp') - pfAt(opp.participantId, t0, 'xp')),
      diedBeforeBuy: !!recall && gt.kills.some((k) => k.victimId === me.participantId && k.timestamp > t && k.timestamp < recall.timestamp),
      deathDelay: myDeaths.length ? (myDeaths[0]!.timestamp - t) / 1000 : null,
      oppBackFirst: Number.isFinite(meBack) || Number.isFinite(oppBack) ? oppBack < meBack : null,
      win: me.win,
      killGold,
    } as Case;
  });
}

const since = Date.parse('2026-01-08T20:00:00Z');
const mine = store.playerGames(P, 5000, { queueId: 420, sinceMs: since }).filter((g) => g.teamPosition === 'TOP');
const peerRefs = store.peerGameRefs({ role: 'TOP', excludePuuid: P, queueId: 420, minRankScore: apexLpScore(600) });
const cases: Case[] = [];
for (const g of mine) {
  const x = store.loadGame(g.matchId);
  if (x && x.match.info.gameDuration >= 900) cases.push(...analyzeGame(x.match, x.timeline, P, 'him'));
}
for (const r of peerRefs) {
  const x = store.loadGame(r.matchId);
  if (x && x.match.info.gameDuration >= 900) cases.push(...analyzeGame(x.match, x.timeline, r.puuid, 'peer'));
}

const mean = (xs0: number[]) => { const xs = xs0.filter(Number.isFinite); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; };
const ci = (xs: number[]) => {
  const m = mean(xs);
  return xs.length > 1 ? 1.96 * Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length) : NaN;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};
const pp = (v: number) => (Number.isNaN(v) ? '-' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`);
const RECALL = 'recalls within 90s';
const PUSH = 'takes plate/tower within 90s';
const groups: [string, Case[]][] = [
  ['Him, recall', cases.filter((c) => c.who === 'him' && c.response === RECALL && !c.diedBeforeBuy)],
  ['Peers, recall', cases.filter((c) => c.who === 'peer' && c.response === RECALL && !c.diedBeforeBuy)],
  ['Him, died+buy', cases.filter((c) => c.who === 'him' && c.response === RECALL && c.diedBeforeBuy)],
  ['Peers, died+buy', cases.filter((c) => c.who === 'peer' && c.response === RECALL && c.diedBeforeBuy)],
  ['Him, push', cases.filter((c) => c.who === 'him' && c.response === PUSH)],
  ['Peers, push', cases.filter((c) => c.who === 'peer' && c.response === PUSH)],
];
const pad = (s: string, n: number) => s.padEnd(n);
const row = (label: string, f: (cs: Case[]) => string) => console.log(pad(label, 44) + groups.map(([, cs]) => f(cs).padStart(16)).join(''));
console.log(pad('', 44) + groups.map(([g]) => g.padStart(16)).join(''));
row('cases', (cs) => String(cs.length));
row('win-chance change over 3 min', (cs) => `${pp(mean(cs.map((c) => c.dWp)))} ±${(ci(cs.map((c) => c.dWp)) * 100).toFixed(1)}`);
console.log('\n  where the change came from:');
for (const k of Object.keys(cases[0]!.parts)) row(`    ${k}`, (cs) => pp(mean(cs.map((c) => c.parts[k]!))));
console.log('\n  what happened in the 3 minutes:');
row('    seconds from kill to his death (median)', (cs) => String(Math.round(median(cs.filter((c) => c.deathDelay !== null).map((c) => c.deathDelay!)))));
row('    he died', (cs) => `${Math.round(mean(cs.map((c) => +c.diedInWindow)) * 100)}%`);
row('    ...with the enemy jungler involved', (cs) => `${Math.round(mean(cs.map((c) => +c.diedToJungler)) * 100)}%`);
row('    plates lost', (cs) => mean(cs.map((c) => c.platesLost)).toFixed(2));
row('    plates taken', (cs) => mean(cs.map((c) => c.platesTaken)).toFixed(2));
row('    gold vs lane opp (excl. kill gold)', (cs) => `${Math.round(mean(cs.map((c) => c.laneGoldSwing)))}`);
row('    CS vs lane opp', (cs) => mean(cs.map((c) => c.csSwing)).toFixed(1));
row('    XP vs lane opp', (cs) => `${Math.round(mean(cs.map((c) => c.xpSwing)))}`);
row('    opponent back in lane first', (cs) => `${Math.round(mean(cs.filter((c) => c.oppBackFirst !== null).map((c) => +c.oppBackFirst!)) * 100)}%`);
console.log('\n  context:');
row('    kill minute (avg)', (cs) => mean(cs.map((c) => c.killMin)).toFixed(1));
row('    kill before 6:00', (cs) => `${Math.round(mean(cs.map((c) => +(c.killMin < 6))) * 100)}%`);
row('    seconds from kill to recall (median)', (cs) => String(Math.round(median(cs.filter((c) => c.recallDelay !== null).map((c) => c.recallDelay!)))));
row('    kill on enemy half of lane', (cs) => `${Math.round(mean(cs.filter((c) => c.progress !== null).map((c) => +(c.progress! > 0.5))) * 100)}%`);
row('    game win rate', (cs) => `${Math.round(mean(cs.map((c) => +c.win)) * 100)}%`);

// Where does his extra cost concentrate? Split recall cases.
console.log('\nRecall cases split (win-chance change over 3 min, n):');
const splits: [string, (c: Case) => boolean][] = [
  ['kill before 6:00', (c) => c.killMin < 6],
  ['kill 6:00-14:00', (c) => c.killMin >= 6],
  ['recall within 30s of kill', (c) => (c.recallDelay ?? 99) <= 30],
  ['recall 30-90s after kill', (c) => (c.recallDelay ?? 0) > 30],
  ['kill on enemy half of lane', (c) => (c.progress ?? 0) > 0.5],
  ['kill on own half of lane', (c) => (c.progress ?? 1) <= 0.5],
  ['he did not die in the window', (c) => !c.diedInWindow],
  ['he died in the window', (c) => c.diedInWindow],
  ['real recall (alive when buying)', (c) => !c.diedBeforeBuy],
  ['died before buying', (c) => c.diedBeforeBuy],
  ['Riven', (c) => c.champion === 'Riven'],
  ['Camille', (c) => c.champion === 'Camille'],
];
const rc = cases.filter((c) => c.who === 'him' && c.response === RECALL);
const pr = cases.filter((c) => c.who === 'peer' && c.response === RECALL);
console.log(`All "recall" cases: him ${rc.length}, of which died before buying ${Math.round(mean(rc.map((c) => +c.diedBeforeBuy)) * 100)}%; peers ${pr.length}, ${Math.round(mean(pr.map((c) => +c.diedBeforeBuy)) * 100)}%`);
console.log(pad('', 34) + 'Him'.padStart(18) + 'Peers'.padStart(18) + 'Gap'.padStart(10));
for (const [label, f] of splits) {
  const a = rc.filter(f);
  const b = pr.filter(f);
  console.log(pad(label, 34) + `${pp(mean(a.map((c) => c.dWp)))} (${a.length})`.padStart(18) + `${pp(mean(b.map((c) => c.dWp)))} (${b.length})`.padStart(18) + pp(mean(a.map((c) => c.dWp)) - mean(b.map((c) => c.dWp))).padStart(10));
}
store.close();
