/**
 * Which in-game habits go with winning, once game state is held fixed?
 *
 * Stage 1 (cached to data/habit-rows.json; pass --rebuild to redo): for oRegret's season top games
 * and every Master 600+ peer top game, extract raw per-game counts (deaths by type and window,
 * wards, control wards, farm, unspent gold at death, objective participation) plus the model's
 * win chance at 0, 14 and 25 minutes.
 *
 * Stage 2: each habit is a yes/no rule over those counts with a start time. Its effect is the
 * difference in win rate between games with and without it, compared only among games at the
 * same win chance when the habit window starts (10 strata), then averaged. Measured on peers
 * (large n) and on him; ranked by the win rate he would gain per game by matching peers.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Store } from '../src/db';
import { apexLpScore } from '../src/rank';
import type { MatchDto, Position, TimelineDto } from '../src/riot/types';
import { loadModel, predict } from '../src/wp/model';
import { GameTimeline } from '../src/wp/state';

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const P = arg('puuid', 'AQ1XAcwjaZ3W1ViZGbU2G7bESXGupurEtH1dfsZEwbpkK72ZhV6kpOPJm0i-SaRi3SBdXmCiGSFENA');
const ROLE = arg('role', 'TOP').toUpperCase();
const MIN_LP = Number(arg('min-lp', '600'));
const CACHE = arg('puuid', '') ? `data/habit-rows-${arg('puuid', '').slice(0, 8)}-${ROLE}-${MIN_LP}.json` : 'data/habit-rows.json';
const MIN = 60_000;

export interface Row {
  who: 'him' | 'peer';
  puuid: string;
  matchId: string;
  champion: string;
  win: boolean;
  minutes: number;
  wp: { 0: number; 10: number | null; 14: number | null; 25: number | null };
  m: Record<string, number>;
  endTs?: number;
  opponent?: string;
  moments?: Moment[];
}

export interface Moment {
  t: number; // ms
  kind: string;
  detail: string;
  dWp: number; // his team's win-chance change at the death
}

const dist = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y);

function extract(match: MatchDto, timeline: TimelineDto, puuid: string, who: Row['who'], model: ReturnType<typeof loadModel>): Row | null {
  const parts = match.info.participants;
  const me = parts.find((p) => p.puuid === puuid);
  if (!me || me.teamPosition !== ROLE || match.info.gameDuration < 15 * 60) return null;
  const team = me.teamId;
  const id = me.participantId;
  const opp = parts.find((p) => p.teamId !== team && p.teamPosition === ROLE)?.participantId;
  const jg = parts.find((p) => p.teamId !== team && p.teamPosition === 'JUNGLE')?.participantId;
  const mates = parts.filter((p) => p.teamId === team && p.participantId !== id).map((p) => p.participantId);
  const gt = new GameTimeline(match, timeline);
  const frames = timeline.info.frames;
  const events = frames.flatMap((f) => f.events) as Record<string, any>[];
  const wpAt = (min: number) => {
    const t = min * MIN;
    if (t >= gt.endMs - MIN) return null;
    const p = predict(model, gt.stateAt(t));
    return team === 100 ? p : 1 - p;
  };
  const posAt = (pid: number, t: number): Position | undefined => {
    const i = Math.min(frames.length - 1, Math.floor(t / MIN));
    const a = frames[i]?.participantFrames[String(pid)]?.position;
    const b = frames[i + 1]?.participantFrames[String(pid)]?.position;
    if (!a || !b) return a;
    const f = Math.min(1, Math.max(0, (t - frames[i]!.timestamp) / MIN));
    return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
  };
  const goldAt = (t: number) => {
    const pf = frames[Math.min(frames.length - 1, Math.floor(t / MIN))]?.participantFrames[String(id)] as { currentGold?: number } | undefined;
    return pf?.currentGold ?? 0;
  };

  const kills = gt.kills;
  const myDeaths = kills.filter((k) => k.victimId === id);
  const myTakedowns = kills.filter((k) => k.killerId === id || (k.assistingParticipantIds ?? []).includes(id));
  const involvesJg = (k: (typeof kills)[number]) => jg !== undefined && (k.killerId === jg || (k.assistingParticipantIds ?? []).includes(jg));
  const isolated = (k: (typeof kills)[number]) => {
    const at = k.position ?? posAt(id, k.timestamp);
    if (!at) return false;
    return !mates.some((m) => {
      const p = posAt(m, k.timestamp);
      return p && dist(p, at) < 4000;
    });
  };
  // Teamfights: kills chained with <=15s gaps, 3+ deaths; is his death the first of his team's?
  const clusters: (typeof kills)[] = [];
  for (const k of [...kills].sort((a, b) => a.timestamp - b.timestamp)) {
    const last = clusters.at(-1);
    if (last && k.timestamp - last.at(-1)!.timestamp <= 15_000) last.push(k);
    else clusters.push([k]);
  }
  const firstTfDeaths = new Set<number>();
  for (const c of clusters) {
    if (c.length < 3) continue;
    const firstOwn = c.find((k) => gt.teamOf.get(k.victimId) === team);
    if (firstOwn && firstOwn.victimId === id) firstTfDeaths.add(firstOwn.timestamp);
  }
  const enemyGains = [
    ...events.filter((e) => e.type === 'ELITE_MONSTER_KILL' && e.killerTeamId !== team).map((e) => e.timestamp as number),
    ...events.filter((e) => e.type === 'BUILDING_KILL' && e.teamId === team).map((e) => e.timestamp as number),
  ];
  const teamMonsters = events.filter((e) => e.type === 'ELITE_MONSTER_KILL' && e.killerTeamId === team);
  const inW = (t: number, a: number, b: number) => t >= a * MIN && t < b * MIN;
  const count = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
  const deathsIn = (a: number, b: number, f: (k: (typeof kills)[number]) => boolean = () => true) =>
    count(myDeaths, (k) => inW(k.timestamp, a, b) && f(k));
  const ch = me.challenges ?? {};
  const raw = me as unknown as Record<string, number>;
  const tm1425 = teamMonsters.filter((e) => inW(e.timestamp, 14, 25));
  const laneGold = (min: number) => {
    const f = frames[Math.min(frames.length - 1, min)]?.participantFrames;
    return opp && f ? (f[String(id)]?.totalGold ?? 0) - (f[String(opp)]?.totalGold ?? 0) : 0;
  };
  const cwBetween = (a: number, b: number) =>
    count(events, (e) => e.type === 'ITEM_PURCHASED' && e.participantId === id && e.itemId === 2055 && inW(e.timestamp, a, b));

  const m: Record<string, number> = {
    deathsPre10: deathsIn(0, 10),
    deathsPre14: deathsIn(0, 14),
    gankDeathsPre14: deathsIn(0, 14, involvesJg),
    soloDeathsPre14: deathsIn(0, 14, (k) => k.killerId === opp && !(k.assistingParticipantIds ?? []).length),
    killThenDiePre14: count(myTakedowns, (t) => inW(t.timestamp, 0, 14) && myDeaths.some((d) => d.timestamp > t.timestamp && d.timestamp - t.timestamp <= 30_000)),
    controlWardsPre14: count(events, (e) => e.type === 'ITEM_PURCHASED' && e.participantId === id && e.itemId === 2055 && e.timestamp < 14 * MIN),
    wardsPre14: count(events, (e) => e.type === 'WARD_PLACED' && e.creatorId === id && e.timestamp < 14 * MIN),
    cs10: (frames[10]?.participantFrames[String(id)]?.minionsKilled ?? 0),
    richDeaths: count(myDeaths, (k) => goldAt(k.timestamp) >= 1200),
    unseenRecalls: ch.unseenRecalls ?? 0,
    controlWards: ch.controlWardsPlaced ?? raw.detectorWardsPlaced ?? 0,
    visionPerMin: ch.visionScorePerMinute ?? 0,
    deaths1425: deathsIn(14, 25),
    isoDeaths1425: deathsIn(14, 25, isolated),
    firstTfDeaths1425: count([...firstTfDeaths], (t) => inW(t, 14, 25)),
    shutdownDeaths1425: deathsIn(14, 25, (k) => ((k as unknown as { shutdownBounty?: number }).shutdownBounty ?? 0) >= 300),
    jgDeaths1425: deathsIn(14, 25, involvesJg),
    deathsBeforeEnemyGain: count(myDeaths, (k) => k.timestamp >= 14 * MIN && enemyGains.some((t) => t > k.timestamp && t - k.timestamp <= 60_000)),
    teamObj1425: tm1425.length,
    objPart1425: count(tm1425, (e) => e.killerId === id || (e.assistingParticipantIds ?? []).includes(id)),
    deaths25: deathsIn(25, 999),
    isoDeaths25: deathsIn(25, 999, isolated),
    firstTfDeaths25: count([...firstTfDeaths], (t) => t >= 25 * MIN),
    soloKills: ch.soloKills ?? 0,
    platesTaken: ch.turretPlatesTaken ?? 0,
    controlWardsBought: raw.visionWardsBoughtInGame ?? 0,
    controlWardsBoughtPre14: count(events, (e) => e.type === 'ITEM_PURCHASED' && e.participantId === id && e.itemId === 2055 && e.timestamp < 14 * MIN),
    sweeperBy20: count(events, (e) => e.type === 'ITEM_PURCHASED' && e.participantId === id && e.itemId === 3364 && e.timestamp < 20 * MIN),
    wardsKilled: raw.wardsKilled ?? 0,
    teleport: +[raw.summoner1Id, raw.summoner2Id].includes(12),
    ignite: +[raw.summoner1Id, raw.summoner2Id].includes(14),
    laneGold10: laneGold(10),
    laneGold14: laneGold(14),
    cw1020: cwBetween(10, 20),
    cw1425: cwBetween(14, 25),
  };
  let moments: Moment[] | undefined;
  if (who === 'him') {
    const jump = (t: number) => {
      const a = predict(model, gt.stateAt(t, false)), b = predict(model, gt.stateAt(t, true));
      return team === 100 ? b - a : a - b;
    };
    const mmss = (t: number) => `${Math.floor(t / MIN)}:${String(Math.floor((t % MIN) / 1000)).padStart(2, '0')}`;
    const gainLabel = (t: number) => {
      const e = events.find((x) => x.timestamp === t && (x.type === 'BUILDING_KILL' || x.type === 'ELITE_MONSTER_KILL'))!;
      if (e.type === 'BUILDING_KILL') return `${String(e.towerType ?? e.buildingType).toLowerCase().replace(/_/g, ' ').replace(' building', '')} (${String(e.laneType ?? '').toLowerCase().replace('_lane', '')})`;
      return String(e.monsterSubType ?? e.monsterType).toLowerCase().replace(/_/g, ' ');
    };
    moments = myDeaths.map((k) => {
      const tags: string[] = [];
      const after = enemyGains.filter((t) => t > k.timestamp && t - k.timestamp <= 60_000).sort((a, b) => a - b);
      if (k.timestamp >= 14 * MIN && after.length) tags.push(`enemy took ${after.map((t) => `${gainLabel(t)} at ${mmss(t)}`).join(', ')}`);
      if (involvesJg(k)) tags.push('enemy jungler involved');
      if (k.killerId === opp && !(k.assistingParticipantIds ?? []).length) tags.push('solo killed by lane opponent');
      if (firstTfDeaths.has(k.timestamp)) tags.push('first to die in teamfight');
      if (k.timestamp >= 14 * MIN && isolated(k)) tags.push('no teammate nearby');
      const g = goldAt(k.timestamp);
      if (g >= 1200) tags.push(`holding ~${g}g`);
      const sb = (k as unknown as { shutdownBounty?: number }).shutdownBounty ?? 0;
      if (sb >= 300) tags.push(`${sb}g shutdown`);
      return { t: k.timestamp, kind: 'death', detail: tags.join('; ') || 'death', dWp: jump(k.timestamp) };
    });
  }
  return { who, puuid, matchId: match.metadata.matchId, endTs: match.info.gameEndTimestamp, opponent: parts.find((p) => p.participantId === opp)?.championName, moments, champion: me.championName, win: me.win, minutes: match.info.gameDuration / 60, wp: { 0: 0.5, 10: wpAt(10), 14: wpAt(14), 25: wpAt(25) }, m };
}

function buildRows(): Row[] {
  const store = new Store('data/lol.db');
  const model = loadModel('data/wp-model.json');
  const since = Date.parse('2026-01-08T20:00:00Z');
  const refs = [
    ...store.playerGames(P, 5000, { queueId: 420, sinceMs: since }).filter((g) => g.teamPosition === ROLE).map((g) => ({ matchId: g.matchId, puuid: P, who: 'him' as const })),
    ...store.peerGameRefs({ role: ROLE, excludePuuid: P, queueId: 420, minRankScore: apexLpScore(MIN_LP) }).map((r) => ({ ...r, who: 'peer' as const })),
  ];
  const rows: Row[] = [];
  refs.forEach((r, i) => {
    const g = store.loadGame(r.matchId);
    const row = g && extract(g.match, g.timeline, r.puuid, r.who, model);
    if (row) rows.push(row);
    if (i % 2000 === 0) console.error(`  ${i}/${refs.length}`);
  });
  writeFileSync(CACHE, JSON.stringify(rows));
  return rows;
}

// ---------- Stage 2 ----------

interface Habit {
  key: string;
  label: string; // the good version, phrased as a habit
  start: 0 | 10 | 14 | 25; // win chance at this minute is held fixed
  applies?: (r: Row) => boolean; // games where the habit is measurable
  good: (r: Row) => boolean;
}

function habits(peerMedian: (k: string) => number): Habit[] {
  const ge25 = (r: Row) => r.wp[25] !== null;
  const ge14 = (r: Row) => r.wp[14] !== null;
  return [
    { key: 'noDeathPre10', label: 'No deaths before 10:00', start: 0, good: (r) => r.m.deathsPre10 === 0 },
    { key: 'noGankPre14', label: 'Not caught by the jungler before 14:00', start: 0, good: (r) => r.m.gankDeathsPre14 === 0 },
    { key: 'noSoloPre14', label: 'Not solo killed by the lane opponent before 14:00', start: 0, good: (r) => r.m.soloDeathsPre14 === 0 },
    { key: 'noTradeBack', label: 'Never dies within 30s of getting a kill/assist (pre-14)', start: 0, good: (r) => r.m.killThenDiePre14 === 0 },
    { key: 'controlWardEarly', label: 'Buys a control ward before 14:00', start: 0, good: (r) => r.m.controlWardsBoughtPre14 >= 1 },
    { key: 'controlWardAny', label: 'Buys at least one control ward', start: 0, good: (r) => r.m.controlWardsBought >= 1 },
    { key: 'sweeper', label: 'Swaps to Oracle Lens (sweeper) by 20:00', start: 0, good: (r) => r.m.sweeperBy20 >= 1 },
    { key: 'clearsWards', label: `Clears ${peerMedian('wardsKilled')}+ enemy wards`, start: 0, good: (r) => r.m.wardsKilled >= peerMedian('wardsKilled') },
    { key: 'teleport', label: 'Takes Teleport (vs not)', start: 0, good: (r) => r.m.teleport === 1 },
    { key: 'wardsEarly', label: `Places ${peerMedian('wardsPre14')}+ wards before 14:00`, start: 0, good: (r) => r.m.wardsPre14 >= peerMedian('wardsPre14') },
    { key: 'cs10', label: `${peerMedian('cs10')}+ CS at 10:00`, start: 0, good: (r) => r.m.cs10 >= peerMedian('cs10') },
    { key: 'spendGold', label: 'Never dies holding 1200+ unspent gold', start: 0, good: (r) => r.m.richDeaths === 0 },
    { key: 'unseenRecall', label: 'At least one unseen recall', start: 0, good: (r) => r.m.unseenRecalls >= 1 },
    { key: 'controlWards2', label: '2+ control wards placed in the game', start: 0, good: (r) => r.m.controlWards >= 2 },
    { key: 'noDeath1425', label: 'No deaths 14:00-25:00', start: 14, applies: ge14, good: (r) => r.m.deaths1425 === 0 },
    { key: 'noIso1425', label: 'No deaths alone (no teammate near) 14:00-25:00', start: 14, applies: ge14, good: (r) => r.m.isoDeaths1425 === 0 },
    { key: 'noFirstTf1425', label: 'Never first to die in a teamfight 14:00-25:00', start: 14, applies: ge14, good: (r) => r.m.firstTfDeaths1425 === 0 },
    { key: 'noJg1425', label: 'Not caught by the jungler 14:00-25:00', start: 14, applies: ge14, good: (r) => r.m.jgDeaths1425 === 0 },
    { key: 'noDeathOpensObj', label: "Never dies in the 60s before the enemy takes a tower/objective (14:00+)", start: 14, applies: ge14, good: (r) => r.m.deathsBeforeEnemyGain === 0 },
    { key: 'objPart', label: "Takes part in the team's objectives 14:00-25:00", start: 14, applies: (r) => ge14(r) && r.m.teamObj1425 > 0, good: (r) => r.m.objPart1425 > 0 },
    { key: 'noIso25', label: 'No deaths alone after 25:00', start: 25, applies: ge25, good: (r) => r.m.isoDeaths25 === 0 },
    { key: 'noFirstTf25', label: 'Never first to die in a teamfight after 25:00', start: 25, applies: ge25, good: (r) => r.m.firstTfDeaths25 === 0 },
    { key: 'deaths25le1', label: 'At most 1 death after 25:00', start: 25, applies: ge25, good: (r) => r.m.deaths25 <= 1 },
  ];
}

/** Win-rate difference (good - bad) within win-chance strata at the habit start, weighted by stratum size. */
/** Same comparison, but within each peer's own games (strata = player), removing between-player skill. */
function withinPlayer(rows: Row[], h: Habit): number {
  const by = new Map<string, Row[]>();
  for (const r of rows) if (!h.applies || h.applies(r)) (by.get(r.puuid) ?? by.set(r.puuid, []).get(r.puuid)!).push(r);
  let num = 0, w = 0;
  for (const s of by.values()) {
    const g = s.filter(h.good), b = s.filter((r) => !h.good(r));
    if (g.length < 2 || b.length < 2) continue;
    const resid = (xs: Row[]) => xs.reduce((a, r) => a + (+r.win - (r.wp[h.start] ?? 0.5)), 0) / xs.length;
    const n = (g.length * b.length) / (g.length + b.length);
    num += n * (resid(g) - resid(b));
    w += n;
  }
  return w ? num / w : NaN;
}

function effect(rows: Row[], h: Habit): { eff: number; se: number; n: number; rate: number; wrGood: number; wrBad: number } {
  const rs = rows.filter((r) => !h.applies || h.applies(r));
  const strata = new Map<number, Row[]>();
  for (const r of rs) {
    const w = r.wp[h.start] ?? 0.5;
    const k = h.start === 0 ? 0 : Math.min(9, Math.floor(w * 10));
    (strata.get(k) ?? strata.set(k, []).get(k)!).push(r);
  }
  let num = 0, wsum = 0, var_ = 0;
  for (const s of strata.values()) {
    const g = s.filter(h.good), b = s.filter((r) => !h.good(r));
    if (g.length < 3 || b.length < 3) continue;
    const pg = g.filter((r) => r.win).length / g.length, pb = b.filter((r) => r.win).length / b.length;
    num += s.length * (pg - pb);
    wsum += s.length;
    var_ += s.length ** 2 * (pg * (1 - pg) / g.length + pb * (1 - pb) / b.length);
  }
  const good = rs.filter(h.good);
  const bad = rs.filter((r) => !h.good(r));
  const wr = (xs: Row[]) => xs.filter((r) => r.win).length / Math.max(1, xs.length);
  return { eff: wsum ? num / wsum : NaN, se: wsum ? Math.sqrt(var_) / wsum : NaN, n: rs.length, rate: good.length / Math.max(1, rs.length), wrGood: wr(good), wrBad: wr(bad) };
}

const rows: Row[] = existsSync(CACHE) && !process.argv.includes('--rebuild') ? JSON.parse(readFileSync(CACHE, 'utf8')) : buildRows();
const champArg = process.argv.find((a) => a.startsWith('--champion='))?.split('=')[1];
const scoped = champArg ? rows.filter((r) => r.champion === champArg) : rows;
const peers = scoped.filter((r) => r.who === 'peer');
const him = scoped.filter((r) => r.who === 'him');
const medians = new Map<string, number>();
const median = (k: string) => {
  if (!medians.has(k)) {
    const xs = peers.map((r) => r.m[k]!).sort((a, b) => a - b);
    medians.set(k, xs[Math.floor(xs.length / 2)]!);
  }
  return medians.get(k)!;
};
const pct = (x: number) => `${Math.round(x * 100)}%`;
const pp = (x: number) => (Number.isNaN(x) ? '-' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`);

if (process.argv.includes('--pinks')) {
  // oRegret's rule: buy control wards when ahead and able to hold vision; skip when behind at tower saving for an item.
  const windows = [
    { label: 'Control ward bought 10:00-20:00', start: 10 as const, lane: 'laneGold10', key: 'cw1020' },
    { label: 'Control ward bought 14:00-25:00', start: 14 as const, lane: 'laneGold14', key: 'cw1425' },
  ];
  const states: [string, (g: number) => boolean][] = [
    ['behind in lane (-500g or worse)', (g) => g <= -500],
    ['even lane (within 500g)', (g) => g > -500 && g < 500],
    ['ahead in lane (+500g or more)', (g) => g >= 500],
  ];
  for (const w of windows) {
    console.log(`\n${w.label}, split by lane gold vs opponent at ${w.start}:00 (peers; win chance at ${w.start}:00 held fixed)`);
    for (const [label, f] of states) {
      const h: Habit = { key: w.key, label, start: w.start, applies: (r) => r.wp[w.start] !== null && f(r.m[w.lane]!), good: (r) => r.m[w.key]! >= 1 };
      const e = effect(peers, h);
      const hs = him.filter((r) => h.applies!(r));
      console.log(`  ${label.padEnd(34)} effect ${pp(e.eff)} ±${(e.se * 196).toFixed(1)}   in-player ${pp(withinPlayer(peers, h))}   peers buy ${pct(e.rate)} (n=${e.n})   he buys ${pct(hs.filter(h.good).length / Math.max(1, hs.length))} (n=${hs.length})`);
    }
  }
  process.exit(0);
}

if (process.argv.includes('--vods')) {
  const n = Number(process.argv.find((a) => a.startsWith('--games='))?.split('=')[1] ?? 20);
  const games = him.filter((r) => r.moments).sort((a, b) => (b.endTs ?? 0) - (a.endTs ?? 0)).slice(0, n);
  const mmss = (t: number) => `${Math.floor(t / MIN)}:${String(Math.floor((t % MIN) / 1000)).padStart(2, '0')}`;
  for (const g of games) {
    const date = new Date(g.endTs ?? 0).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    console.log(`\n${g.matchId}  ${date} PT  ${g.champion} vs ${g.opponent ?? '?'}  ${g.win ? 'WIN' : 'LOSS'} ${Math.round(g.minutes)}m  pinks bought: ${g.m.controlWardsBought}`);
    for (const mo of [...g.moments!].sort((a, b) => a.dWp - b.dWp).slice(0, 3)) console.log(`  ${mmss(mo.t).padStart(6)}  ${pp(mo.dWp).padStart(6)}  ${mo.detail}`);
  }
  process.exit(0);
}

console.log(`${champArg ?? 'All champions'}: ${him.length} of his games, ${peers.length} peer games\n`);
const out = habits(median).map((h) => {
  const pe = effect(peers, h);
  const me = effect(him, h);
  const hw = him.filter((r) => (!h.applies || h.applies(r)) && r.win), hl = him.filter((r) => (!h.applies || h.applies(r)) && !r.win);
  const inWins = hw.filter(h.good).length / Math.max(1, hw.length), inLosses = hl.filter(h.good).length / Math.max(1, hl.length);
  return { h, pe, me, inWins, inLosses, wp: withinPlayer(peers, h), value: (pe.rate - me.rate) * pe.eff };
});
out.sort((a, b) => b.value - a.value);
const jsonPath = arg('json', '');
if (jsonPath) {
  const pinkStates: [string, (g: number) => boolean][] = [['behind', (g) => g <= -500], ['even', (g) => g > -500 && g < 500], ['ahead', (g) => g >= 500]];
  const pinks = pinkStates.map(([state, f]) => {
    const h: Habit = { key: 'cw1425', label: state, start: 14, applies: (r) => r.wp[14] !== null && f(r.m.laneGold14!), good: (r) => r.m.cw1425! >= 1 };
    const e = effect(peers, h);
    const hs = him.filter((r) => h.applies!(r));
    return { state, eff: e.eff, se: e.se, inPlayer: withinPlayer(peers, h), peerRate: e.rate, hisRate: hs.filter(h.good).length / Math.max(1, hs.length), n: e.n, hisN: hs.length };
  });
  const vods = him.filter((r) => r.moments).sort((a, b) => (b.endTs ?? 0) - (a.endTs ?? 0)).slice(0, Number(arg('games', '15'))).map((g) => ({
    matchId: g.matchId, endTs: g.endTs, champion: g.champion, opponent: g.opponent, win: g.win, minutes: g.minutes, pinks: g.m.controlWardsBought,
    moments: [...g.moments!].sort((a, b) => a.dWp - b.dWp).slice(0, 3),
  }));
  writeFileSync(jsonPath, JSON.stringify({
    scope: champArg ?? 'all', hisGames: him.length, peerGames: peers.length, peerPlayers: new Set(peers.map((r) => r.puuid)).size,
    habits: out.map((o) => ({ key: o.h.key, label: o.h.label, peerEff: o.pe.eff, peerSe: o.pe.se, inPlayer: o.wp, hisEff: o.me.eff, hisSe: o.me.se, hisRate: o.me.rate, peerRate: o.pe.rate, inWins: o.inWins, inLosses: o.inLosses, value: o.value })),
    pinks, vods,
  }));
}
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
console.log(pad('Habit', 64) + 'peer effect'.padStart(14) + 'in-player'.padStart(11) + 'his effect'.padStart(14) + 'he does'.padStart(9) + 'peers'.padStart(7) + 'his W/L'.padStart(11) + 'value/game'.padStart(12));
for (const o of out) {
  console.log(
    pad(o.h.label, 64) +
      `${pp(o.pe.eff)}±${(o.pe.se * 196).toFixed(1)}`.padStart(14) +
      pp(o.wp).padStart(11) +
      `${pp(o.me.eff)}±${(o.me.se * 196).toFixed(1)}`.padStart(14) +
      pct(o.me.rate).padStart(9) +
      pct(o.pe.rate).padStart(7) +
      `${pct(o.inWins)}/${pct(o.inLosses)}`.padStart(11) +
      pp(o.value).padStart(12),
  );
}
console.log('\nin-player = same comparison inside each peer\'s own games (win minus expected win at the start), so skill differences between players drop out.');
console.log('effect = win-rate difference, doing it vs not, among games at the same win chance when the window starts (pp, ±95%).');
console.log('value/game = (peer rate - his rate) x peer effect: win rate he would gain per game by doing it as often as peers.');
