import type { FrameDto, MatchDto, ParticipantDto, TimelineDto, TimelineEvent } from '../src/riot/types';

const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;

/**
 * 30-minute game. Participant 1 (blue TOP) out-farms participant 6 (red TOP):
 * 8 vs 6 CS/min, 400 vs 350 gold/min, 500 vs 450 XP/min.
 */
export function makeGame(overrides: { durationSec?: number; matchId?: string } = {}): {
  match: MatchDto;
  timeline: TimelineDto;
} {
  const durationSec = overrides.durationSec ?? 1800;
  const matchId = overrides.matchId ?? 'NA1_1';

  const participants: ParticipantDto[] = Array.from({ length: 10 }, (_, i) => {
    const id = i + 1;
    const isP1 = id === 1;
    return {
      puuid: `p${id}`,
      participantId: id,
      teamId: id <= 5 ? 100 : 200,
      teamPosition: POSITIONS[i % 5]!,
      championName: `Champ${id}`,
      win: id <= 5,
      kills: isP1 ? 3 : 2,
      deaths: isP1 ? 2 : 1,
      assists: isP1 ? 2 : 1,
      totalMinionsKilled: isP1 ? 200 : 150,
      neutralMinionsKilled: isP1 ? 10 : 0,
      goldEarned: 10_000,
      totalDamageDealtToChampions: isP1 ? 20_000 : 10_000,
      visionScore: 30,
    };
  });

  const events: Record<number, TimelineEvent[]> = {
    0: [{ type: 'ITEM_PURCHASED', timestamp: 10_000, participantId: 1, itemId: 1055 }],
    5: [
      // Solo death deep on red side, then red takes dragon 30s later.
      { type: 'CHAMPION_KILL', timestamp: 300_000, killerId: 6, victimId: 1, position: { x: 12_000, y: 12_000 } },
      { type: 'ELITE_MONSTER_KILL', timestamp: 330_000, killerId: 7, killerTeamId: 200, monsterType: 'DRAGON' },
    ],
    6: [{ type: 'ITEM_PURCHASED', timestamp: 400_000, participantId: 1, itemId: 3044 }],
    // Assisted death on own side, no objective follows.
    8: [
      {
        type: 'CHAMPION_KILL',
        timestamp: 480_000,
        killerId: 7,
        victimId: 1,
        assistingParticipantIds: [6],
        position: { x: 2_000, y: 2_000 },
      },
    ],
  };

  const lastMinute = Math.floor(durationSec / 60);
  const frames: FrameDto[] = Array.from({ length: lastMinute + 1 }, (_, m) => ({
    timestamp: m === 0 ? 0 : m * 60_000 + 20,
    participantFrames: Object.fromEntries(
      participants.map((p) => {
        const isP1 = p.participantId === 1;
        return [
          String(p.participantId),
          {
            participantId: p.participantId,
            minionsKilled: m * (isP1 ? 8 : 6),
            jungleMinionsKilled: 0,
            totalGold: 500 + m * (isP1 ? 400 : 350),
            xp: m * (isP1 ? 500 : 450),
            level: 1 + Math.floor(m / 2),
          },
        ];
      }),
    ),
    events: events[m] ?? [],
  }));

  const match: MatchDto = {
    metadata: { matchId, participants: participants.map((p) => p.puuid) },
    info: {
      gameCreation: 1_700_000_000_000,
      gameDuration: durationSec,
      gameEndTimestamp: 1_700_000_000_000 + durationSec * 1000,
      gameMode: 'CLASSIC',
      gameVersion: '14.20.1',
      queueId: 420,
      participants,
    },
  };
  const timeline: TimelineDto = {
    metadata: { matchId, participants: match.metadata.participants },
    info: { frameInterval: 60_000, frames },
  };
  return { match, timeline };
}
