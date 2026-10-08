import { frameAtMinute, gameDurationSeconds, MIN_GAME_SECONDS } from '../metrics/compute';
import {
  isChampionKill,
  isEliteMonsterKill,
  type ChampionKillEvent,
  type FrameDto,
  type MatchDto,
  type ParticipantDto,
  type Position,
  type TimelineDto,
  type TimelineEvent,
} from '../riot/types';

/** Turret plates fall at 14:00, a natural end of the laning phase. */
export const LANE_END_MS = 14 * 60_000;
/** Kills chained within this gap belong to the same fight. */
const FIGHT_GAP_MS = 15_000;
/** A "teamfight" needs at least this many deaths (smaller clusters are picks/skirmishes). */
const FIGHT_MIN_DEATHS = 3;
/** Frames are 60s apart; only trust a frame position within this much of an event. */
const FRAME_TRUST_MS = 20_000;
const NEAR_OBJECTIVE = 3_500;
const FAR_FROM_OBJECTIVE = 7_000;
/** Tower taken this close to an enemy objective counts as a cross-map trade. */
const TRADE_WINDOW_MS = 90_000;
/** Approximate respawn window: died this long before an objective = dead for it. */
const DEAD_WINDOW_MS = 40_000;
const ISOLATED = 5_000;
const ISOLATED_DEATH = 4_000;
const TEAM_AHEAD = 1_500;
const FOUNTAINS: Record<number, Position> = { 100: { x: 400, y: 400 }, 200: { x: 14_400, y: 14_400 } };

type Kill = TimelineEvent & ChampionKillEvent;

export interface GameFeatures {
  matchId: string;
  puuid: string;
  champion: string;
  win: boolean;
  durationMin: number;

  // Laning phase (0-14 min) vs the enemy laner in the same position.
  gd7: number | null;
  gd14: number | null;
  csd14: number | null;
  xpd14: number | null;
  laneTakedownsOnOpp: number;
  soloKillsEarly: number;
  earlyDeaths: number;
  gankDeaths: number;
  soloDeathsToOpp: number;
  platesTaken: number;
  platesLost: number;
  firstLaneTower: 'ours' | 'theirs' | 'none';

  // Teamfights (clusters of 3+ deaths, 14 min onward).
  fights: number;
  fightsPresent: number;
  fightsWonPresent: number;
  fightsLostPresent: number;
  fightsWonAbsent: number;
  fightsLostAbsent: number;
  fightDeaths: number;
  firstAllyDeaths: number;
  fightTakedowns: number;

  // Epic monsters (dragon, herald, grubs, baron, atakhan).
  allyObjectives: number;
  allyObjectivesPresent: number;
  enemyObjectives: number;
  enemyObjDead: number;
  enemyObjNear: number;
  enemyObjFarTraded: number;
  enemyObjFarNoTrade: number;

  // Macro / side lane (14 min onward).
  towersAfterLane: number;
  isolationRate: number | null;
  isolatedDeaths: number;
  midDeaths: number; // 14-25 min
  lateDeaths: number; // 25+ min
  deathsWhileAhead: number;
  teamGd15: number | null;
  teamGd20: number | null;
}

const dist = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y);

function frameNear(timeline: TimelineDto, t: number): FrameDto | undefined {
  const frames = timeline.info.frames;
  const idx = Math.round(t / (timeline.info.frameInterval || 60_000));
  const f = frames[Math.min(Math.max(idx, 0), frames.length - 1)];
  return f && Math.abs(f.timestamp - t) <= FRAME_TRUST_MS ? f : undefined;
}

function positionAt(frame: FrameDto | undefined, id: number): Position | undefined {
  return frame?.participantFrames[String(id)]?.position;
}

function teamGold(frame: FrameDto | undefined, ids: number[]): number | null {
  if (!frame) return null;
  let sum = 0;
  for (const id of ids) {
    const pf = frame.participantFrames[String(id)];
    if (!pf) return null;
    sum += pf.totalGold;
  }
  return sum;
}

function involved(e: { killerId: number; assistingParticipantIds?: number[] }, id: number): boolean {
  return e.killerId === id || (e.assistingParticipantIds ?? []).includes(id);
}

/** Nearest living-and-in-play teammate distance (teammates in their fountain are ignored). */
function nearestTeammate(frame: FrameDto | undefined, from: Position, allies: number[], teamId: number): number | null {
  if (!frame) return null;
  let best: number | null = null;
  for (const id of allies) {
    const pos = positionAt(frame, id);
    if (!pos || dist(pos, FOUNTAINS[teamId]!) < 2_000) continue;
    const d = dist(pos, from);
    if (best === null || d < best) best = d;
  }
  return best;
}

export function computeGameFeatures(match: MatchDto, timeline: TimelineDto, puuid: string): GameFeatures | null {
  const seconds = gameDurationSeconds(match);
  if (seconds < MIN_GAME_SECONDS) return null;
  const parts = match.info.participants;
  const me = parts.find((p) => p.puuid === puuid);
  if (!me || !me.teamPosition) return null;
  const opp = parts.find((p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition);
  const enemyJungler = parts.find((p) => p.teamId !== me.teamId && p.teamPosition === 'JUNGLE');
  const teamOf = new Map(parts.map((p) => [p.participantId, p.teamId]));
  const allyIds = parts.filter((p) => p.teamId === me.teamId).map((p) => p.participantId);
  const enemyIds = parts.filter((p) => p.teamId !== me.teamId).map((p) => p.participantId);
  const otherAllies = allyIds.filter((id) => id !== me.participantId);
  const myId = me.participantId;

  const events = timeline.info.frames.flatMap((f) => f.events);
  const kills = events.filter(isChampionKill).sort((a, b) => a.timestamp - b.timestamp);
  const monsters = events.filter(isEliteMonsterKill);
  const buildings = events.filter((e) => e.type === 'BUILDING_KILL') as (TimelineEvent & {
    killerId: number;
    assistingParticipantIds?: number[];
    teamId: number;
    buildingType: string;
    laneType?: string;
    towerType?: string;
  })[];
  const plates = events.filter((e) => e.type === 'TURRET_PLATE_DESTROYED') as (TimelineEvent & {
    teamId: number;
    laneType: string;
  })[];

  const killerTeam = (k: Kill) =>
    k.killerId > 0 ? teamOf.get(k.killerId)! : teamOf.get(k.victimId) === 100 ? 200 : 100;

  // --- Laning ---------------------------------------------------------------
  const f7 = frameAtMinute(timeline, 7);
  const f14 = frameAtMinute(timeline, 14);
  const diff = (f: FrameDto | undefined, stat: (pf: FrameDto['participantFrames'][string]) => number) => {
    if (!f || !opp) return null;
    const a = f.participantFrames[String(myId)];
    const b = f.participantFrames[String(opp.participantId)];
    return a && b ? stat(a) - stat(b) : null;
  };
  const early = kills.filter((k) => k.timestamp < LANE_END_MS);
  const myEarlyDeaths = early.filter((k) => k.victimId === myId);
  const laneName = { TOP: 'TOP_LANE', MIDDLE: 'MID_LANE', BOTTOM: 'BOT_LANE', UTILITY: 'BOT_LANE' }[
    me.teamPosition as string
  ];
  const laneTowers = buildings
    .filter((b) => b.buildingType === 'TOWER_BUILDING' && b.towerType === 'OUTER_TURRET' && b.laneType === laneName)
    .sort((a, b) => a.timestamp - b.timestamp);

  // --- Teamfights -----------------------------------------------------------
  const clusters: Kill[][] = [];
  for (const k of kills) {
    const last = clusters.at(-1);
    if (last && k.timestamp - last.at(-1)!.timestamp <= FIGHT_GAP_MS) last.push(k);
    else clusters.push([k]);
  }
  const fights = clusters.filter((c) => c.length >= FIGHT_MIN_DEATHS && c[0]!.timestamp >= LANE_END_MS);
  let fightsPresent = 0,
    fightsWonPresent = 0,
    fightsLostPresent = 0,
    fightsWonAbsent = 0,
    fightsLostAbsent = 0,
    fightDeaths = 0,
    firstAllyDeaths = 0,
    fightTakedowns = 0;
  for (const fight of fights) {
    const ours = fight.filter((k) => killerTeam(k) === me.teamId).length;
    const theirs = fight.length - ours;
    const present = fight.some((k) => k.victimId === myId || involved(k, myId));
    const won = ours > theirs;
    const lost = theirs > ours;
    if (present) {
      fightsPresent++;
      if (won) fightsWonPresent++;
      if (lost) fightsLostPresent++;
      fightDeaths += fight.filter((k) => k.victimId === myId).length;
      fightTakedowns += fight.filter((k) => involved(k, myId)).length;
      const firstAlly = fight.find((k) => teamOf.get(k.victimId) === me.teamId);
      if (firstAlly?.victimId === myId) firstAllyDeaths++;
    } else {
      if (won) fightsWonAbsent++;
      if (lost) fightsLostAbsent++;
    }
  }

  // --- Objectives -----------------------------------------------------------
  let allyObjectives = 0,
    allyObjectivesPresent = 0,
    enemyObjectives = 0,
    enemyObjDead = 0,
    enemyObjNear = 0,
    enemyObjFarTraded = 0,
    enemyObjFarNoTrade = 0;
  for (const m of monsters) {
    const pos = (m as { position?: Position }).position;
    const myPos = positionAt(frameNear(timeline, m.timestamp), myId);
    const near =
      involved(m, myId) ||
      (pos && myPos ? dist(pos, myPos) < NEAR_OBJECTIVE : false) ||
      kills.some(
        (k) =>
          Math.abs(k.timestamp - m.timestamp) <= 30_000 &&
          (k.victimId === myId || involved(k, myId)) &&
          k.position &&
          pos &&
          dist(k.position, pos) < NEAR_OBJECTIVE,
      );
    if (m.killerTeamId === me.teamId) {
      allyObjectives++;
      if (near) allyObjectivesPresent++;
      continue;
    }
    enemyObjectives++;
    const dead = kills.some(
      (k) => k.victimId === myId && k.timestamp <= m.timestamp && m.timestamp - k.timestamp <= DEAD_WINDOW_MS,
    );
    if (dead) enemyObjDead++;
    else if (near) enemyObjNear++;
    else if (pos && myPos && dist(pos, myPos) >= FAR_FROM_OBJECTIVE) {
      const traded = buildings.some(
        (b) => b.teamId !== me.teamId && Math.abs(b.timestamp - m.timestamp) <= TRADE_WINDOW_MS,
      );
      if (traded) enemyObjFarTraded++;
      else enemyObjFarNoTrade++;
    } else enemyObjNear++; // in between: rotating but didn't get there
  }

  // --- Macro ----------------------------------------------------------------
  let isolatedFrames = 0,
    countedFrames = 0;
  for (const f of timeline.info.frames) {
    if (f.timestamp < 15 * 60_000) continue;
    const pos = positionAt(f, myId);
    if (!pos || dist(pos, FOUNTAINS[me.teamId]!) < 2_000) continue;
    const nearest = nearestTeammate(f, pos, otherAllies, me.teamId);
    if (nearest === null) continue;
    countedFrames++;
    if (nearest > ISOLATED) isolatedFrames++;
  }
  const lateMyDeaths = kills.filter((k) => k.victimId === myId && k.timestamp >= LANE_END_MS);
  const isolatedDeaths = lateMyDeaths.filter((k) => {
    if (!k.position) return false;
    const nearest = nearestTeammate(frameNear(timeline, k.timestamp), k.position, otherAllies, me.teamId);
    return nearest !== null && nearest > ISOLATED_DEATH;
  }).length;
  const deathsWhileAhead = lateMyDeaths.filter((k) => {
    const f = timeline.info.frames.filter((fr) => fr.timestamp <= k.timestamp).at(-1);
    const a = teamGold(f, allyIds);
    const b = teamGold(f, enemyIds);
    return a !== null && b !== null && a - b > TEAM_AHEAD;
  }).length;
  const gdAt = (minute: number) => {
    const f = frameAtMinute(timeline, minute);
    const a = teamGold(f, allyIds);
    const b = teamGold(f, enemyIds);
    return a === null || b === null ? null : a - b;
  };

  return {
    matchId: match.metadata.matchId,
    puuid,
    champion: me.championName,
    win: me.win,
    durationMin: seconds / 60,

    gd7: diff(f7, (pf) => pf.totalGold),
    gd14: diff(f14, (pf) => pf.totalGold),
    csd14: diff(f14, (pf) => pf.minionsKilled + pf.jungleMinionsKilled),
    xpd14: diff(f14, (pf) => pf.xp),
    laneTakedownsOnOpp: opp ? early.filter((k) => k.victimId === opp.participantId && involved(k, myId)).length : 0,
    soloKillsEarly: early.filter((k) => k.killerId === myId && !(k.assistingParticipantIds ?? []).length).length,
    earlyDeaths: myEarlyDeaths.length,
    gankDeaths: enemyJungler
      ? myEarlyDeaths.filter((k) => involved(k, enemyJungler.participantId)).length
      : 0,
    soloDeathsToOpp: opp
      ? myEarlyDeaths.filter((k) => k.killerId === opp.participantId && !(k.assistingParticipantIds ?? []).length).length
      : 0,
    platesTaken: plates.filter((p) => p.laneType === laneName && p.teamId !== me.teamId).length,
    platesLost: plates.filter((p) => p.laneType === laneName && p.teamId === me.teamId).length,
    firstLaneTower: laneTowers[0] ? (laneTowers[0].teamId !== me.teamId ? 'ours' : 'theirs') : 'none',

    fights: fights.length,
    fightsPresent,
    fightsWonPresent,
    fightsLostPresent,
    fightsWonAbsent,
    fightsLostAbsent,
    fightDeaths,
    firstAllyDeaths,
    fightTakedowns,

    allyObjectives,
    allyObjectivesPresent,
    enemyObjectives,
    enemyObjDead,
    enemyObjNear,
    enemyObjFarTraded,
    enemyObjFarNoTrade,

    towersAfterLane: buildings.filter(
      (b) => b.buildingType === 'TOWER_BUILDING' && b.timestamp >= LANE_END_MS && involved(b, myId),
    ).length,
    isolationRate: countedFrames ? isolatedFrames / countedFrames : null,
    isolatedDeaths,
    midDeaths: lateMyDeaths.filter((k) => k.timestamp < 25 * 60_000).length,
    lateDeaths: lateMyDeaths.filter((k) => k.timestamp >= 25 * 60_000).length,
    deathsWhileAhead,
    teamGd15: gdAt(15),
    teamGd20: gdAt(20),
  };
}

export type { ParticipantDto };
