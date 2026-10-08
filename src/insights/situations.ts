import type { MatchDto, Position, TimelineDto } from '../riot/types';
import { predict, type WinModel } from '../wp/model';
import { GameTimeline, type Kill } from '../wp/state';

/**
 * Decision points: a situation the player is in, what he did next, and how his team's
 * win probability moved over the following minutes. Win probability (from the trained
 * model) already accounts for the game state at the start of the situation, so
 * responses can be compared fairly. If the game ends inside the window, the final
 * result (100% or 0%) is used.
 */

export interface Situation {
  kind: SituationKind;
  response: string;
  t: number;
  dWp: number; // change in his team's win probability over the window
  win: boolean;
  /** dWp split by what caused it; the parts add up to dWp exactly. */
  parts: Record<WpPart, number>;
  /** What happened in the window (counts, rates as 0/1, swings vs lane opponent). */
  facts: Record<FactKey, number>;
  /** Context at the start of the window, for finding where a gap concentrates. */
  ctx: { minute: number; wpStart: number; champion: string };
}

export const WP_PARTS = ['your deaths', 'teammate deaths', 'kills by your team', 'towers taken', 'towers lost', 'objectives taken', 'objectives lost', 'gold/XP drift'] as const;
export type WpPart = (typeof WP_PARTS)[number];

/** Facts recorded for every window. `rate` facts are 0/1 per case; `better` says which direction is good for him. */
export const FACTS = {
  died: { label: 'you died', rate: true, better: 'lower' },
  diedToJungler: { label: 'the enemy jungler was in on your death', rate: true, better: 'lower' },
  diedAlone: { label: 'you died with no teammate within 4000 units', rate: true, better: 'lower' },
  shutdownGiven: { label: 'shutdown gold you gave up', rate: false, better: 'lower' },
  teammateDeaths: { label: 'teammates who died', rate: false, better: 'lower' },
  enemyDeaths: { label: 'enemies your team killed', rate: false, better: 'higher' },
  structuresTaken: { label: 'plates and towers your team took', rate: false, better: 'higher' },
  structuresLost: { label: 'plates and towers your team lost', rate: false, better: 'lower' },
  enemyMonster: { label: 'the enemy took an epic monster', rate: true, better: 'lower' },
  allyMonster: { label: 'your team took an epic monster', rate: true, better: 'higher' },
  csSwing: { label: 'CS gained on your lane opponent', rate: false, better: 'higher' },
  xpSwing: { label: 'XP gained on your lane opponent', rate: false, better: 'higher' },
  goldSwing: { label: 'gold gained on your lane opponent', rate: false, better: 'higher' },
} as const;
export type FactKey = keyof typeof FACTS;

export type SituationKind =
  | 'solo-kill-in-lane'
  | 'enemy-epic-monster'
  | 'team-won-fight'
  | 'ahead-in-lane-at-10'
  | 'fed-mid-game'
  | 'objective-20m-plus'
  | 'joined-teamfight';

export const SITUATIONS: Record<SituationKind, { title: string; window: string; responses: string[] }> = {
  'solo-kill-in-lane': {
    title: 'He solo kills his lane opponent before 14:00',
    window: 'next 3 min',
    responses: ['takes plate/tower within 90s', 'recalls within 90s', 'neither (stays/roams)', 'dies within 90s (before recalling)'],
  },
  'enemy-epic-monster': {
    title: 'Enemy takes an epic monster (14:00+, he is alive)',
    window: '1 min before to 2 min after',
    responses: ['he takes a tower (trade)', 'team trades without him', 'he is near/contests', 'nothing elsewhere'],
  },
  'team-won-fight': {
    title: 'His team wins a teamfight (14:00+, he survives)',
    window: '3 min after the fight',
    responses: ['converts: he takes tower/objective', 'team converts without him', 'no conversion'],
  },
  'ahead-in-lane-at-10': {
    title: 'He is 500+ gold up on his lane opponent at 10:00',
    window: '10:00 to 16:00',
    responses: ['first lane tower before 14:00', 'no tower before 14:00'],
  },
  'fed-mid-game': {
    title: 'He is 1500+ gold up on his lane opponent (14-25 min)',
    window: 'next 5 min',
    responses: ['does not die', 'dies with a teammate nearby', 'dies alone'],
  },
  'objective-20m-plus': {
    title: 'Dragon/Baron/Atakhan taken (20:00+, either team)',
    window: '90s before to 90s after',
    responses: ['grouped near objective', 'in side lane, team takes a tower', 'in side lane, no tower', 'dead'],
  },
  'joined-teamfight': {
    title: 'He is in a teamfight (14:00+, 3+ deaths)',
    window: 'start to end of fight',
    responses: ['survives', 'dies, not first', 'first on his team to die'],
  },
};

const dist = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y);
const involved = (e: { killerId: number; assistingParticipantIds?: number[] }, id: number) =>
  e.killerId === id || (e.assistingParticipantIds ?? []).includes(id);

export function findSituations(match: MatchDto, timeline: TimelineDto, puuid: string, model: WinModel): Situation[] {
  const gt = new GameTimeline(match, timeline);
  const parts = match.info.participants;
  const me = parts.find((p) => p.puuid === puuid);
  if (!me || !me.teamPosition || match.info.gameDuration < 15 * 60) return [];
  const myId = me.participantId;
  const team = me.teamId;
  const opp = parts.find((p) => p.teamId !== team && p.teamPosition === me.teamPosition);
  const allies = parts.filter((p) => p.teamId === team && p.participantId !== myId).map((p) => p.participantId);
  const laneName = ({ TOP: 'TOP_LANE', MIDDLE: 'MID_LANE', BOTTOM: 'BOT_LANE', UTILITY: 'BOT_LANE' } as Record<string, string>)[me.teamPosition];
  const events = timeline.info.frames.flatMap((f) => f.events);
  const plates = events.filter((e) => e.type === 'TURRET_PLATE_DESTROYED') as unknown as { timestamp: number; teamId: number; laneType: string }[];
  const purchases = events.filter((e) => e.type === 'ITEM_PURCHASED') as unknown as { timestamp: number; participantId: number }[];
  const kills = [...gt.kills].sort((a, b) => a.timestamp - b.timestamp);
  const towers = gt.buildings.filter((b) => b.buildingType === 'TOWER_BUILDING');

  const wp = (t: number, inclusive = true) => {
    if (t >= gt.endMs) return me.win ? 1 : 0;
    const p = predict(model, gt.stateAt(Math.max(0, t), inclusive));
    return team === 100 ? p : 1 - p;
  };
  const jump = (t: number) => (t >= gt.endMs ? 0 : wp(t, true) - wp(t, false));
  const frames = timeline.info.frames;
  const stat = (id: number, t: number, key: 'gold' | 'cs' | 'xp') => {
    const i = Math.max(0, Math.min(frames.length - 2, Math.floor(t / 60_000)));
    const v = (f: (typeof frames)[number]) => {
      const pf = f.participantFrames[String(id)];
      if (!pf) return NaN;
      return key === 'gold' ? pf.totalGold : key === 'xp' ? pf.xp : pf.minionsKilled + pf.jungleMinionsKilled;
    };
    const a = frames[i]!;
    const b = frames[i + 1] ?? a;
    const f = Math.min(1, Math.max(0, (t - a.timestamp) / 60_000));
    return v(a) + f * (v(b) - v(a));
  };
  const enemyJungler = parts.find((p) => p.teamId !== team && p.teamPosition === 'JUNGLE')?.participantId;

  /** Break the window (from, to] down into what moved win probability and what happened. */
  const describe = (from: number, to: number, dWp: number) => {
    const end = Math.min(to, gt.endMs);
    const inWin = (x: number) => x > from && x <= end;
    const p = Object.fromEntries(WP_PARTS.map((k) => [k, 0])) as Record<WpPart, number>;
    const wk = kills.filter((k) => inWin(k.timestamp));
    for (const k of wk) {
      const key: WpPart = k.victimId === myId ? 'your deaths' : gt.teamOf.get(k.victimId) === team ? 'teammate deaths' : 'kills by your team';
      p[key] += jump(k.timestamp);
    }
    for (const b of gt.buildings.filter((b) => inWin(b.timestamp))) p[b.teamId === team ? 'towers lost' : 'towers taken'] += jump(b.timestamp);
    for (const m of gt.monsters.filter((m) => inWin(m.timestamp))) p[m.killerTeamId === team ? 'objectives taken' : 'objectives lost'] += jump(m.timestamp);
    const eventSum = WP_PARTS.reduce((s, k) => s + p[k], 0);
    p['gold/XP drift'] = dWp - eventSum;

    const myDeaths = wk.filter((k) => k.victimId === myId);
    const plateEvents = plates.filter((x) => inWin(x.timestamp));
    const towerEvents = towers.filter((b) => inWin(b.timestamp));
    const swing = (key: 'gold' | 'cs' | 'xp') => (opp ? stat(myId, end, key) - stat(opp.participantId, end, key) - (stat(myId, from, key) - stat(opp.participantId, from, key)) : NaN);
    const facts: Record<FactKey, number> = {
      died: +(myDeaths.length > 0),
      diedToJungler: +myDeaths.some((k) => enemyJungler !== undefined && involved(k, enemyJungler)),
      diedAlone: +myDeaths.some((k) => {
        const n = k.position ? nearestAlly(k.timestamp, k.position) : null;
        return n !== null && n > 4000;
      }),
      shutdownGiven: myDeaths.reduce((s, k) => s + ((k as { shutdownBounty?: number }).shutdownBounty ?? 0), 0),
      teammateDeaths: wk.filter((k) => k.victimId !== myId && gt.teamOf.get(k.victimId) === team).length,
      enemyDeaths: wk.filter((k) => gt.teamOf.get(k.victimId) !== team).length,
      structuresTaken: plateEvents.filter((x) => x.teamId !== team).length + towerEvents.filter((b) => b.teamId !== team).length,
      structuresLost: plateEvents.filter((x) => x.teamId === team).length + towerEvents.filter((b) => b.teamId === team).length,
      enemyMonster: +gt.monsters.some((m) => inWin(m.timestamp) && m.killerTeamId !== team),
      allyMonster: +gt.monsters.some((m) => inWin(m.timestamp) && m.killerTeamId === team),
      csSwing: swing('cs'),
      xpSwing: swing('xp'),
      goldSwing: swing('gold'),
    };
    return { parts: p, facts };
  };

  const out: Situation[] = [];
  const add = (kind: SituationKind, response: string, t: number, from: number, to: number) => {
    const dWp = wp(to) - wp(from);
    const wpStart = wp(from);
    out.push({ kind, response, t, dWp, win: me.win, ...describe(from, to, dWp), ctx: { minute: t / 60_000, wpStart, champion: me.championName } });
  };

  const posAt = (id: number, t: number): Position | undefined => {
    const f = timeline.info.frames[Math.round(t / 60_000)];
    return f && Math.abs(f.timestamp - t) <= 30_000 ? f.participantFrames[String(id)]?.position : undefined;
  };
  const deadAt = (t: number) => kills.some((k) => k.victimId === myId && k.timestamp <= t && t - k.timestamp <= 40_000);
  const nearestAlly = (t: number, from: Position) => {
    const d = allies.map((id) => posAt(id, t)).filter((p): p is Position => !!p).map((p) => dist(p, from));
    return d.length ? Math.min(...d) : null;
  };

  // 1. Solo kill in lane.
  if (opp) {
    for (const k of kills.filter((k) => k.timestamp < 14 * 60_000 && k.killerId === myId && k.victimId === opp.participantId && !(k.assistingParticipantIds ?? []).length)) {
      const t = k.timestamp;
      const soon = (x: number) => x > t && x - t <= 90_000;
      const pushed =
        plates.some((p) => soon(p.timestamp) && p.laneType === laneName && p.teamId !== team) ||
        towers.some((b) => soon(b.timestamp) && b.laneType === laneName && b.teamId !== team);
      const firstBuy = purchases.find((p) => p.participantId === myId && soon(p.timestamp));
      const firstPush = [...plates.filter((p) => soon(p.timestamp) && p.laneType === laneName && p.teamId !== team), ...towers.filter((b) => soon(b.timestamp) && b.laneType === laneName && b.teamId !== team)]
        .map((e) => e.timestamp)
        .sort((a, b) => a - b)[0];
      // A purchase right after dying is a fountain buy on respawn, not a recall.
      const death = kills.find((d) => d.victimId === myId && soon(d.timestamp));
      const r = SITUATIONS['solo-kill-in-lane'].responses;
      const diedFirst = death && death.timestamp < Math.min(firstBuy?.timestamp ?? Infinity, firstPush ?? Infinity);
      add('solo-kill-in-lane', diedFirst ? r[3]! : pushed ? r[0]! : firstBuy ? r[1]! : r[2]!, t, t + 1, t + 180_000);
    }
  }

  // 2. Enemy epic monster while he is alive.
  for (const m of gt.monsters.filter((m) => m.timestamp >= 14 * 60_000 && m.killerTeamId !== team)) {
    const t = m.timestamp;
    if (deadAt(t)) continue;
    const window = (x: number) => Math.abs(x - t) <= 90_000;
    const mine = towers.some((b) => window(b.timestamp) && b.teamId !== team && involved(b, myId));
    const teamTrade = towers.some((b) => window(b.timestamp) && b.teamId !== team);
    const myPos = posAt(myId, t);
    const near =
      (m.position && myPos && dist(m.position, myPos) < 4000) ||
      kills.some((k) => Math.abs(k.timestamp - t) <= 30_000 && (k.victimId === myId || involved(k, myId)) && k.position && m.position && dist(k.position, m.position) < 4000);
    const r = SITUATIONS['enemy-epic-monster'].responses;
    add('enemy-epic-monster', mine ? r[0]! : teamTrade ? r[1]! : near ? r[2]! : r[3]!, t, t - 60_000, t + 120_000);
  }

  // Teamfight clusters.
  const clusters: Kill[][] = [];
  for (const k of kills) {
    const last = clusters.at(-1);
    if (last && k.timestamp - last.at(-1)!.timestamp <= 15_000) last.push(k);
    else clusters.push([k]);
  }
  const fights = clusters.filter((c) => c.length >= 3 && c[0]!.timestamp >= 14 * 60_000);

  // 3. Team won a fight and he survived: did they convert?
  for (const f of fights) {
    const ours = f.filter((k) => gt.killerTeam(k) === team).length;
    if (ours <= f.length - ours || f.some((k) => k.victimId === myId)) continue;
    const end = f.at(-1)!.timestamp;
    const soon = (x: number) => x > end && x - end <= 120_000;
    const taken = [
      ...gt.buildings.filter((b) => soon(b.timestamp) && b.teamId !== team),
      ...gt.monsters.filter((m) => soon(m.timestamp) && m.killerTeamId === team),
    ];
    const r = SITUATIONS['team-won-fight'].responses;
    add('team-won-fight', taken.some((e) => involved(e, myId)) ? r[0]! : taken.length ? r[1]! : r[2]!, end, end + 1, end + 180_000);
  }

  // 4. Ahead in lane at 10.
  const f10 = timeline.info.frames[10];
  if (opp && f10) {
    const gd = (f10.participantFrames[String(myId)]?.totalGold ?? 0) - (f10.participantFrames[String(opp.participantId)]?.totalGold ?? 0);
    if (gd >= 500) {
      const tower = towers.some((b) => b.timestamp < 14 * 60_000 && b.laneType === laneName && b.teamId !== team);
      const r = SITUATIONS['ahead-in-lane-at-10'].responses;
      add('ahead-in-lane-at-10', tower ? r[0]! : r[1]!, 10 * 60_000, 10 * 60_000, 16 * 60_000);
    }
  }

  // 5. Fed in the mid game (first minute he is 1500+ up on his lane opponent).
  if (opp) {
    const frames = timeline.info.frames;
    for (let m = 14; m <= 25 && m < frames.length; m++) {
      const pf = frames[m]!.participantFrames;
      if ((pf[String(myId)]?.totalGold ?? 0) - (pf[String(opp.participantId)]?.totalGold ?? 0) < 1500) continue;
      const t = frames[m]!.timestamp;
      const deaths = kills.filter((k) => k.victimId === myId && k.timestamp > t && k.timestamp - t <= 300_000);
      const alone = deaths.some((k) => {
        const n = k.position ? nearestAlly(k.timestamp, k.position) : null;
        return n !== null && n > 4000;
      });
      const r = SITUATIONS['fed-mid-game'].responses;
      add('fed-mid-game', !deaths.length ? r[0]! : alone ? r[2]! : r[1]!, t, t, t + 300_000);
      break;
    }
  }

  // 6. Big objectives from 20:00: grouped or side lane?
  for (const m of gt.monsters.filter((m) => m.timestamp >= 20 * 60_000 && ['DRAGON', 'BARON_NASHOR', 'ATAKHAN'].includes(m.monsterType))) {
    const t = m.timestamp;
    const r = SITUATIONS['objective-20m-plus'].responses;
    if (deadAt(t)) {
      add('objective-20m-plus', r[3]!, t, t - 90_000, t + 90_000);
      continue;
    }
    const myPos = posAt(myId, t);
    if (!myPos || !m.position) continue;
    const near = dist(myPos, m.position) < 5000 || involved(m, myId);
    const tower = towers.some((b) => Math.abs(b.timestamp - t) <= 90_000 && b.teamId !== team);
    add('objective-20m-plus', near ? r[0]! : tower ? r[1]! : r[2]!, t, t - 90_000, t + 90_000);
  }

  // 7. Teamfights he joins.
  for (const f of fights) {
    if (!f.some((k) => k.victimId === myId || involved(k, myId))) continue;
    const first = f.find((k) => gt.teamOf.get(k.victimId) === team);
    const died = f.some((k) => k.victimId === myId);
    const r = SITUATIONS['joined-teamfight'].responses;
    add('joined-teamfight', first?.victimId === myId ? r[2]! : died ? r[1]! : r[0]!, f[0]!.timestamp, f[0]!.timestamp - 1, f.at(-1)!.timestamp + 1);
  }
  return out;
}
