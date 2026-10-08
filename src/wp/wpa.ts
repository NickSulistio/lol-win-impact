import type { MatchDto, Position, TimelineDto } from '../riot/types';
import { predict, type WinModel } from './model';
import { GameTimeline, type Building, type Kill, type Monster, type ScoredEvent } from './state';

/**
 * Win Probability Added. Every kill, building, and epic monster is valued as the change
 * in win probability it caused (state just after minus just before). Credit:
 *   kill:      killer 50%, assisters share 50% (killer 100% if solo); victim takes -100%
 *   building/monster: split equally between the players who took it
 *   economy:   each minute, the gold a player out-earned their lane opponent (excluding
 *              kill bounties, already credited) x the marginal value of gold at that state
 * All values are in win-probability points for the player's own team.
 */

export type Category = 'kills' | 'deaths' | 'objectives' | 'structures' | 'economy';
export type Phase = 'laning' | 'mid' | 'late';

export interface DeathRecord {
  matchId: string;
  t: number;
  cost: number; // win probability his team lost (positive = costly)
  wpBefore: number; // his team's win probability just before
  context: string[];
}

export interface PlayerWpa {
  participantId: number;
  puuid: string;
  champion: string;
  teamPosition: string;
  win: boolean;
  total: number;
  byCategory: Record<Category, number>;
  byPhase: Record<Phase, number>;
  deaths: DeathRecord[];
  plays: { t: number; gain: number; what: string }[];
}

const phaseOf = (t: number): Phase => (t < 14 * 60_000 ? 'laning' : t < 25 * 60_000 ? 'mid' : 'late');
const FIGHT_GAP_MS = 15_000;
const dist = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y);

export function computeWpa(match: MatchDto, timeline: TimelineDto, model: WinModel): PlayerWpa[] {
  const gt = new GameTimeline(match, timeline);
  const parts = match.info.participants;
  const players = new Map<number, PlayerWpa>(
    parts.map((p) => [
      p.participantId,
      {
        participantId: p.participantId,
        puuid: p.puuid,
        champion: p.championName,
        teamPosition: p.teamPosition,
        win: p.win,
        total: 0,
        byCategory: { kills: 0, deaths: 0, objectives: 0, structures: 0, economy: 0 },
        byPhase: { laning: 0, mid: 0, late: 0 },
        deaths: [],
        plays: [],
      },
    ]),
  );
  const credit = (id: number, amount: number, cat: Category, t: number) => {
    const p = players.get(id);
    if (!p || !Number.isFinite(amount)) return;
    p.total += amount;
    p.byCategory[cat] += amount;
    p.byPhase[phaseOf(t)] += amount;
  };
  const forTeam = (teamId: number, blueDelta: number) => (teamId === 100 ? blueDelta : -blueDelta);
  const wpFor = (teamId: number, blueWp: number) => (teamId === 100 ? blueWp : 1 - blueWp);

  // Fight clusters (for death context).
  const kills = [...gt.kills].sort((a, b) => a.timestamp - b.timestamp);
  const clusterOf = new Map<Kill, Kill[]>();
  let current: Kill[] = [];
  for (const k of kills) {
    if (current.length && k.timestamp - current.at(-1)!.timestamp > FIGHT_GAP_MS) current = [];
    current.push(k);
    clusterOf.set(k, current);
  }

  // --- Events -----------------------------------------------------------------
  const events = gt.scoredEvents();
  for (let i = 0; i < events.length; ) {
    const t = events[i]!.timestamp;
    const group: ScoredEvent[] = [];
    while (i < events.length && events[i]!.timestamp === t) group.push(events[i++]!);
    const wpBefore = predict(model, gt.stateAt(t, false));
    const wpAfter = predict(model, gt.stateAt(t, true));
    const d = (wpAfter - wpBefore) / group.length;

    for (const e of group) {
      if (e.type === 'CHAMPION_KILL') {
        const k = e as Kill;
        const team = gt.killerTeam(k);
        const gain = forTeam(team, d);
        const assists = (k.assistingParticipantIds ?? []).filter((id) => gt.teamOf.get(id) === team);
        if (k.killerId > 0) {
          credit(k.killerId, assists.length ? gain / 2 : gain, 'kills', t);
          for (const a of assists) credit(a, gain / 2 / assists.length, 'kills', t);
          players.get(k.killerId)?.plays.push({ t, gain, what: `kill on ${players.get(k.victimId)?.champion}` });
        }
        credit(k.victimId, -gain, 'deaths', t);
        players.get(k.victimId)?.deaths.push({
          matchId: match.metadata.matchId,
          t,
          cost: gain,
          wpBefore: wpFor(gt.teamOf.get(k.victimId)!, wpBefore),
          context: deathContext(gt, timeline, k, clusterOf.get(k)!),
        });
      } else {
        const b = e as Building | Monster;
        const team = e.type === 'BUILDING_KILL' ? ((e as Building).teamId === 100 ? 200 : 100) : (e as Monster).killerTeamId;
        const gain = forTeam(team, d);
        const takers = [b.killerId, ...(b.assistingParticipantIds ?? [])].filter((id) => id > 0 && gt.teamOf.get(id) === team);
        const cat: Category = e.type === 'BUILDING_KILL' ? 'structures' : 'objectives';
        for (const id of takers) {
          credit(id, gain / takers.length, cat, t);
          const what = e.type === 'BUILDING_KILL' ? (e as Building).buildingType : (e as Monster).monsterType;
          players.get(id)?.plays.push({ t, gain: gain / takers.length, what: what.toLowerCase().replace('_building', '') });
        }
      }
    }
  }

  // --- Economy ----------------------------------------------------------------
  const frames = timeline.info.frames;
  for (let i = 0; i + 1 < frames.length; i++) {
    const t0 = frames[i]!.timestamp;
    const t1 = frames[i + 1]!.timestamp;
    const s = gt.stateAt(t0, true);
    const p = predict(model, s);
    const tm = s.minute / 30;
    const slopePerGold = (p * (1 - p) * (model.weights[1]! + model.weights[2]! * tm)) / 1000; // blue WP per blue gold
    const bounties = (id: number) =>
      gt.kills
        .filter((k) => k.killerId === id && k.timestamp > t0 && k.timestamp <= t1)
        .reduce((a, k) => a + (k.bounty ?? 300) + (k.shutdownBounty ?? 0), 0);
    const gain = (id: number) =>
      (frames[i + 1]!.participantFrames[String(id)]?.totalGold ?? 0) -
      (frames[i]!.participantFrames[String(id)]?.totalGold ?? 0) -
      bounties(id);
    for (const pos of ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']) {
      const b = parts.find((x) => x.teamId === 100 && x.teamPosition === pos);
      const r = parts.find((x) => x.teamId === 200 && x.teamPosition === pos);
      if (!b || !r) continue;
      const v = slopePerGold * (gain(b.participantId) - gain(r.participantId));
      credit(b.participantId, v, 'economy', t1);
      credit(r.participantId, -v, 'economy', t1);
    }
  }
  return [...players.values()];
}

function deathContext(gt: GameTimeline, timeline: TimelineDto, k: Kill, cluster: Kill[]): string[] {
  const ctx: string[] = [];
  const team = gt.teamOf.get(k.victimId)!;
  const t = k.timestamp;
  if (cluster.length >= 3) {
    const firstAlly = cluster.find((c) => gt.teamOf.get(c.victimId) === team);
    ctx.push(firstAlly === k ? 'first to die in teamfight' : 'teamfight');
  } else if ((k.assistingParticipantIds ?? []).length === 0 && k.killerId > 0) ctx.push('1v1');
  else ctx.push(`caught by ${1 + (k.assistingParticipantIds ?? []).length}`);
  const enemyObj = gt.monsters.find((m) => m.killerTeamId !== team && m.timestamp > t && m.timestamp - t <= 60_000);
  if (enemyObj) ctx.push(`enemy took ${enemyObj.monsterType.toLowerCase()} after`);
  const lostTower = gt.buildings.find((b) => b.teamId === team && b.timestamp > t && b.timestamp - t <= 60_000);
  if (lostTower) ctx.push(`lost ${lostTower.buildingType === 'INHIBITOR_BUILDING' ? 'inhibitor' : 'tower'} after`);
  if ((k.shutdownBounty ?? 0) >= 300) ctx.push(`gave ${k.shutdownBounty}g shutdown`);
  const frame = timeline.info.frames[Math.round(t / 60_000)];
  if (k.position && frame && Math.abs(frame.timestamp - t) <= 20_000) {
    const allies = [...gt.teamOf].filter(([id, tm]) => tm === team && id !== k.victimId).map(([id]) => id);
    const near = allies
      .map((id) => frame.participantFrames[String(id)]?.position)
      .filter((p): p is Position => !!p)
      .map((p) => dist(p, k.position!));
    if (near.length && Math.min(...near) > 4000) ctx.push('no teammate nearby');
  }
  return ctx;
}
