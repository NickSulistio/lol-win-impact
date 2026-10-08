// Subset of Riot DTOs this project reads. Raw JSON is stored in full, so
// new fields can be used later without refetching.

export interface AccountDto {
  puuid: string;
  gameName?: string;
  tagLine?: string;
}

export interface LeagueEntryDto {
  queueType: string; // RANKED_SOLO_5x5, RANKED_FLEX_SR
  tier: string;
  rank: string; // division I-IV
  puuid: string;
  leaguePoints: number;
  wins: number;
  losses: number;
}

export interface LeagueListDto {
  tier: string;
  queue: string;
  entries: Omit<LeagueEntryDto, 'tier' | 'queueType'>[];
}

export type TeamPosition = 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY' | '';

export interface ParticipantDto {
  puuid: string;
  participantId: number;
  teamId: number; // 100 = blue, 200 = red
  teamPosition: TeamPosition;
  championName: string;
  riotIdGameName?: string;
  riotIdTagline?: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  goldEarned: number;
  totalDamageDealtToChampions: number;
  visionScore: number;
  challenges?: Record<string, number | undefined>;
}

export interface MatchDto {
  metadata: { matchId: string; participants: string[] };
  info: {
    gameCreation: number;
    /** Seconds when gameEndTimestamp is present, milliseconds in pre-11.20 matches. */
    gameDuration: number;
    gameEndTimestamp?: number;
    gameMode: string;
    gameVersion: string;
    queueId: number;
    participants: ParticipantDto[];
  };
}

export interface Position {
  x: number;
  y: number;
}

export interface ParticipantFrameDto {
  participantId: number;
  totalGold: number;
  xp: number;
  level: number;
  minionsKilled: number;
  jungleMinionsKilled: number;
  position?: Position;
}

export interface BaseEvent {
  type: string;
  timestamp: number;
}

export interface ChampionKillEvent extends BaseEvent {
  type: 'CHAMPION_KILL';
  killerId: number; // 0 = tower/minion/execute
  victimId: number;
  assistingParticipantIds?: number[];
  position?: Position;
}

export interface EliteMonsterKillEvent extends BaseEvent {
  type: 'ELITE_MONSTER_KILL';
  killerId: number;
  killerTeamId: number;
  monsterType: string; // DRAGON, BARON_NASHOR, RIFTHERALD, HORDE, ATAKHAN
  monsterSubType?: string;
  assistingParticipantIds?: number[];
  position?: Position;
}

export interface ItemPurchasedEvent extends BaseEvent {
  type: 'ITEM_PURCHASED';
  participantId: number;
  itemId: number;
}

export type TimelineEvent = BaseEvent & Record<string, unknown>;

export interface FrameDto {
  timestamp: number;
  participantFrames: Record<string, ParticipantFrameDto>;
  events: TimelineEvent[];
}

export interface TimelineDto {
  metadata: { matchId: string; participants: string[] };
  info: {
    frameInterval: number;
    frames: FrameDto[];
    participants?: { participantId: number; puuid: string }[];
  };
}

export const isChampionKill = (e: TimelineEvent): e is TimelineEvent & ChampionKillEvent =>
  e.type === 'CHAMPION_KILL';

export const isEliteMonsterKill = (e: TimelineEvent): e is TimelineEvent & EliteMonsterKillEvent =>
  e.type === 'ELITE_MONSTER_KILL';

export const isItemPurchased = (e: TimelineEvent): e is TimelineEvent & ItemPurchasedEvent =>
  e.type === 'ITEM_PURCHASED';

export interface ChampionMasteryDto {
  puuid: string;
  championId: number;
  championLevel: number;
  championPoints: number;
  lastPlayTime: number;
}
