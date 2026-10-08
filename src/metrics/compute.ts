import {
  isChampionKill,
  isEliteMonsterKill,
  isItemPurchased,
  type FrameDto,
  type MatchDto,
  type ParticipantDto,
  type ParticipantFrameDto,
  type TeamPosition,
  type TimelineDto,
} from '../riot/types';

export type Direction = 'higher' | 'lower' | 'neutral';

export interface MetricDef {
  key: string;
  label: string;
  direction: Direction;
  decimals: number;
  percent?: boolean;
}

export const METRICS = [
  { key: 'csAt10', label: 'CS @10', direction: 'higher', decimals: 1 },
  { key: 'csDiffAt10', label: 'CS diff @10 vs lane opp', direction: 'higher', decimals: 1 },
  { key: 'goldDiffAt10', label: 'Gold diff @10', direction: 'higher', decimals: 0 },
  { key: 'xpDiffAt10', label: 'XP diff @10', direction: 'higher', decimals: 0 },
  { key: 'goldDiffAt15', label: 'Gold diff @15', direction: 'higher', decimals: 0 },
  { key: 'csPerMin', label: 'CS / min', direction: 'higher', decimals: 1 },
  { key: 'kda', label: 'KDA', direction: 'higher', decimals: 2 },
  { key: 'killParticipation', label: 'Kill participation', direction: 'higher', decimals: 0, percent: true },
  { key: 'damageShare', label: 'Team damage share', direction: 'higher', decimals: 0, percent: true },
  { key: 'visionPerMin', label: 'Vision score / min', direction: 'higher', decimals: 2 },
  { key: 'deaths', label: 'Deaths', direction: 'lower', decimals: 1 },
  { key: 'soloDeaths', label: 'Deaths with no enemy assist', direction: 'lower', decimals: 1 },
  { key: 'deathsBeforeEnemyObjective', label: 'Deaths <60s before enemy objective', direction: 'lower', decimals: 2 },
  { key: 'deathsInEnemyHalf', label: 'Deaths deep in enemy half', direction: 'lower', decimals: 1 },
  { key: 'firstBackMin', label: 'First back (min, approx)', direction: 'neutral', decimals: 1 },
] as const satisfies readonly MetricDef[];

export type MetricKey = (typeof METRICS)[number]['key'];
export type MetricValues = Record<MetricKey, number | null>;

export interface ParticipantMetrics {
  matchId: string;
  puuid: string;
  championName: string;
  teamPosition: TeamPosition;
  win: boolean;
  gameEndTimestamp: number;
  kills: number;
  deaths: number;
  assists: number;
  metrics: MetricValues;
}

/** Games shorter than this are remakes and are excluded from analysis. */
export const MIN_GAME_SECONDS = 300;
/** Death this long before an enemy elite monster kill counts as "threw the objective". */
const OBJECTIVE_WINDOW_MS = 60_000;
/** Starting items are bought before this; the first purchase after it marks the first back. */
const LEFT_BASE_MS = 90_000;
/** Summoner's Rift diagonal: blue fountain ~(0,0), red ~(14800,14900). x+y ≈ 14800 is mid-river. */
const RIVER_DIAGONAL = 14_800;
const DEEP_MARGIN = 1_500;

export function gameDurationSeconds(match: MatchDto): number {
  const { gameDuration, gameEndTimestamp } = match.info;
  return gameEndTimestamp ? gameDuration : gameDuration / 1000;
}

/** First frame at or after the given minute, or undefined if the game ended earlier. */
export function frameAtMinute(timeline: TimelineDto, minute: number): FrameDto | undefined {
  return timeline.info.frames.find((f) => f.timestamp >= minute * 60_000);
}

const cs = (f: ParticipantFrameDto) => f.minionsKilled + f.jungleMinionsKilled;
const gold = (f: ParticipantFrameDto) => f.totalGold;
const xp = (f: ParticipantFrameDto) => f.xp;

function statAt(
  frame: FrameDto | undefined,
  p: ParticipantDto,
  stat: (f: ParticipantFrameDto) => number,
): number | null {
  const pf = frame?.participantFrames[String(p.participantId)];
  return pf ? stat(pf) : null;
}

function diffAt(
  frame: FrameDto | undefined,
  p: ParticipantDto,
  opp: ParticipantDto | undefined,
  stat: (f: ParticipantFrameDto) => number,
): number | null {
  if (!opp) return null;
  const mine = statAt(frame, p, stat);
  const theirs = statAt(frame, opp, stat);
  return mine === null || theirs === null ? null : mine - theirs;
}

export function isDeepInEnemyHalf(teamId: number, pos: { x: number; y: number }): boolean {
  const diagonal = pos.x + pos.y;
  return teamId === 100
    ? diagonal > RIVER_DIAGONAL + DEEP_MARGIN
    : diagonal < RIVER_DIAGONAL - DEEP_MARGIN;
}

/** Computes metrics for all 10 participants. Returns [] for remakes. */
export function computeMatchMetrics(match: MatchDto, timeline: TimelineDto): ParticipantMetrics[] {
  const seconds = gameDurationSeconds(match);
  if (seconds < MIN_GAME_SECONDS) return [];
  const minutes = seconds / 60;

  const participants = match.info.participants;
  const events = timeline.info.frames.flatMap((f) => f.events);
  const kills = events.filter(isChampionKill);
  const objectives = events.filter(isEliteMonsterKill);
  const purchases = events.filter(isItemPurchased);
  const frame10 = frameAtMinute(timeline, 10);
  const frame15 = frameAtMinute(timeline, 15);

  const teamTotals = new Map<number, { kills: number; damage: number }>();
  for (const p of participants) {
    const t = teamTotals.get(p.teamId) ?? { kills: 0, damage: 0 };
    t.kills += p.kills;
    t.damage += p.totalDamageDealtToChampions;
    teamTotals.set(p.teamId, t);
  }

  return participants.map((p) => {
    const opp = p.teamPosition
      ? participants.find((o) => o.teamId !== p.teamId && o.teamPosition === p.teamPosition)
      : undefined;
    const team = teamTotals.get(p.teamId)!;
    const myDeaths = kills.filter((k) => k.victimId === p.participantId);
    const enemyObjectives = objectives.filter((o) => o.killerTeamId !== p.teamId);
    const firstBack = purchases.find(
      (e) => e.participantId === p.participantId && e.timestamp > LEFT_BASE_MS,
    );

    const metrics: MetricValues = {
      csAt10: statAt(frame10, p, cs),
      csDiffAt10: diffAt(frame10, p, opp, cs),
      goldDiffAt10: diffAt(frame10, p, opp, gold),
      xpDiffAt10: diffAt(frame10, p, opp, xp),
      goldDiffAt15: diffAt(frame15, p, opp, gold),
      csPerMin: (p.totalMinionsKilled + p.neutralMinionsKilled) / minutes,
      kda: (p.kills + p.assists) / Math.max(1, p.deaths),
      killParticipation: team.kills > 0 ? (p.kills + p.assists) / team.kills : null,
      damageShare: team.damage > 0 ? p.totalDamageDealtToChampions / team.damage : null,
      visionPerMin: p.visionScore / minutes,
      deaths: p.deaths,
      soloDeaths: myDeaths.filter(
        (d) => d.killerId !== 0 && (d.assistingParticipantIds ?? []).length === 0,
      ).length,
      deathsBeforeEnemyObjective: myDeaths.filter((d) =>
        enemyObjectives.some(
          (o) => o.timestamp > d.timestamp && o.timestamp - d.timestamp <= OBJECTIVE_WINDOW_MS,
        ),
      ).length,
      deathsInEnemyHalf: myDeaths.filter((d) => d.position && isDeepInEnemyHalf(p.teamId, d.position))
        .length,
      firstBackMin: firstBack ? firstBack.timestamp / 60_000 : null,
    };

    return {
      matchId: match.metadata.matchId,
      puuid: p.puuid,
      championName: p.championName,
      teamPosition: p.teamPosition,
      win: p.win,
      gameEndTimestamp: match.info.gameEndTimestamp ?? match.info.gameCreation,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      metrics,
    };
  });
}
