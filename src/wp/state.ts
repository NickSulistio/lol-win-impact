import { isChampionKill, isEliteMonsterKill, type MatchDto, type TimelineDto, type TimelineEvent } from '../riot/types';

/**
 * Reconstructs the game state at any timestamp from a match timeline, from blue's (100)
 * perspective. Frames give gold/XP once a minute; kill bounties are applied as jumps at
 * the kill, and the rest of each minute's gold is spread linearly.
 */

export interface GameState {
  minute: number;
  goldDiff: number;
  xpDiff: number;
  towerDiff: number; // towers destroyed by blue minus by red
  inhibDiff: number; // enemy inhibitors currently down (blue's advantage)
  dragonDiff: number; // elemental dragons
  soul: number; // +1 blue has soul, -1 red
  baron: number; // +1 blue has baron buff active
  elder: number;
  deadDiff: number; // red players dead minus blue players dead
}

// Base respawn timer by level (seconds), before the late-game time multiplier.
const RESPAWN = [10, 10, 12, 12, 14, 16, 20, 25, 28, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50, 52.5];
const respawnMs = (level: number, minute: number) =>
  RESPAWN[Math.min(Math.max(level, 1), 18) - 1]! * 1000 * (1 + Math.min(0.5, Math.max(0, minute - 15) * 0.017));

const BARON_MS = 180_000;
const ELDER_MS = 150_000;
const INHIB_RESPAWN_MS = 300_000;

export type Kill = TimelineEvent & {
  type: 'CHAMPION_KILL';
  killerId: number;
  victimId: number;
  assistingParticipantIds?: number[];
  bounty?: number;
  shutdownBounty?: number;
  position?: { x: number; y: number };
};
export type Building = TimelineEvent & {
  type: 'BUILDING_KILL';
  killerId: number;
  assistingParticipantIds?: number[];
  teamId: number; // side that LOST the building
  buildingType: string;
  laneType?: string;
  towerType?: string;
};
export type Monster = TimelineEvent & {
  type: 'ELITE_MONSTER_KILL';
  killerId: number;
  killerTeamId: number;
  assistingParticipantIds?: number[];
  monsterType: string;
  monsterSubType?: string;
  position?: { x: number; y: number };
};
export type ScoredEvent = Kill | Building | Monster;

export class GameTimeline {
  readonly teamOf: Map<number, number>;
  readonly kills: Kill[];
  readonly buildings: Building[];
  readonly monsters: Monster[];
  readonly blueWin: boolean;
  readonly endMs: number;
  private readonly souls: { teamId: number; timestamp: number }[];
  private readonly deaths: { teamId: number; from: number; to: number }[];

  constructor(
    readonly match: MatchDto,
    readonly timeline: TimelineDto,
  ) {
    const parts = match.info.participants;
    this.teamOf = new Map(parts.map((p) => [p.participantId, p.teamId]));
    this.blueWin = parts.find((p) => p.teamId === 100)!.win;
    const events = timeline.info.frames.flatMap((f) => f.events);
    this.kills = events.filter(isChampionKill) as Kill[];
    this.buildings = events.filter((e) => e.type === 'BUILDING_KILL') as Building[];
    this.monsters = events.filter(isEliteMonsterKill) as Monster[];
    this.souls = events.filter((e) => e.type === 'DRAGON_SOUL_GIVEN') as unknown as { teamId: number; timestamp: number }[];
    this.endMs = timeline.info.frames.at(-1)!.timestamp;
    this.deaths = this.kills.map((k) => {
      const minute = k.timestamp / 60_000;
      const frame = this.frameIndexAt(k.timestamp);
      const level = timeline.info.frames[frame]!.participantFrames[String(k.victimId)]?.level ?? 1;
      return { teamId: this.teamOf.get(k.victimId)!, from: k.timestamp, to: k.timestamp + respawnMs(level, minute) };
    });
  }

  /** Team that got the kill (executions count for the victim's enemies). */
  killerTeam(k: Kill): number {
    if (k.killerId > 0) return this.teamOf.get(k.killerId)!;
    return this.teamOf.get(k.victimId) === 100 ? 200 : 100;
  }

  frameIndexAt(t: number): number {
    const frames = this.timeline.info.frames;
    let i = 0;
    while (i + 1 < frames.length && frames[i + 1]!.timestamp <= t) i++;
    return i;
  }

  private teamTotal(frameIdx: number, teamId: number, stat: 'totalGold' | 'xp'): number {
    const pf = this.timeline.info.frames[frameIdx]!.participantFrames;
    let sum = 0;
    for (const [id, team] of this.teamOf) if (team === teamId) sum += pf[String(id)]?.[stat] ?? 0;
    return sum;
  }

  private killGold(k: Kill): number {
    return (k.bounty ?? 300) + (k.shutdownBounty ?? 0);
  }

  /** Blue-minus-red gold at time t; `inclusive` includes kills exactly at t. */
  goldDiffAt(t: number, inclusive: boolean): number {
    const frames = this.timeline.info.frames;
    const i = this.frameIndexAt(t);
    const t0 = frames[i]!.timestamp;
    const base = this.teamTotal(i, 100, 'totalGold') - this.teamTotal(i, 200, 'totalGold');
    if (i + 1 >= frames.length) return base;
    const t1 = frames[i + 1]!.timestamp;
    const next = this.teamTotal(i + 1, 100, 'totalGold') - this.teamTotal(i + 1, 200, 'totalGold');
    const inInterval = this.kills.filter((k) => k.timestamp > t0 && k.timestamp <= t1);
    const sgn = (k: Kill) => (this.killerTeam(k) === 100 ? 1 : -1);
    const eventGold = inInterval.reduce((s, k) => s + sgn(k) * this.killGold(k), 0);
    const soFar = inInterval
      .filter((k) => (inclusive ? k.timestamp <= t : k.timestamp < t))
      .reduce((s, k) => s + sgn(k) * this.killGold(k), 0);
    const frac = (t - t0) / Math.max(1, t1 - t0);
    return base + soFar + (next - base - eventGold) * frac;
  }

  private xpDiffAt(t: number): number {
    const frames = this.timeline.info.frames;
    const i = this.frameIndexAt(t);
    const a = this.teamTotal(i, 100, 'xp') - this.teamTotal(i, 200, 'xp');
    if (i + 1 >= frames.length) return a;
    const b = this.teamTotal(i + 1, 100, 'xp') - this.teamTotal(i + 1, 200, 'xp');
    const frac = (t - frames[i]!.timestamp) / Math.max(1, frames[i + 1]!.timestamp - frames[i]!.timestamp);
    return a + (b - a) * frac;
  }

  stateAt(t: number, inclusive = true): GameState {
    const before = (e: { timestamp: number }) => (inclusive ? e.timestamp <= t : e.timestamp < t);
    const towerDiff = this.buildings
      .filter((b) => b.buildingType === 'TOWER_BUILDING' && before(b))
      .reduce((s, b) => s + (b.teamId === 200 ? 1 : -1), 0);
    const inhibDiff = this.buildings
      .filter((b) => b.buildingType === 'INHIBITOR_BUILDING' && before(b) && t - b.timestamp < INHIB_RESPAWN_MS)
      .reduce((s, b) => s + (b.teamId === 200 ? 1 : -1), 0);
    const mons = this.monsters.filter(before);
    const buff = (type: string, ms: number) => {
      const last = mons.filter((m) => m.monsterType === type || m.monsterSubType === type).at(-1);
      return last && t - last.timestamp < ms ? (last.killerTeamId === 100 ? 1 : -1) : 0;
    };
    const dragonDiff = mons
      .filter((m) => m.monsterType === 'DRAGON' && m.monsterSubType !== 'ELDER_DRAGON')
      .reduce((s, m) => s + (m.killerTeamId === 100 ? 1 : -1), 0);
    const soulEvent = this.souls.filter(before).at(-1);
    const deadNow = this.deaths.filter((d) => (inclusive ? d.from <= t : d.from < t) && d.to > t);
    return {
      minute: t / 60_000,
      goldDiff: this.goldDiffAt(t, inclusive),
      xpDiff: this.xpDiffAt(t),
      towerDiff,
      inhibDiff,
      dragonDiff,
      soul: soulEvent ? (soulEvent.teamId === 100 ? 1 : soulEvent.teamId === 200 ? -1 : 0) : 0,
      baron: buff('BARON_NASHOR', BARON_MS),
      elder: buff('ELDER_DRAGON', ELDER_MS),
      deadDiff: deadNow.filter((d) => d.teamId === 200).length - deadNow.filter((d) => d.teamId === 100).length,
    };
  }

  /** Kills, buildings, and epic monsters in time order. */
  scoredEvents(): ScoredEvent[] {
    return [...this.kills, ...this.buildings, ...this.monsters].sort((a, b) => a.timestamp - b.timestamp);
  }
}
