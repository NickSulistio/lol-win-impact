import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MetricKey, MetricValues, ParticipantMetrics } from './metrics/compute';
import { rankScore, type RankInfo } from './rank';
import type { MatchDto, TeamPosition, TimelineDto } from './riot/types';

type SqlParam = string | number;

/** Which other players' games count as peers. */
export interface PeerFilter {
  role: string;
  excludePuuid: string;
  /** Only players whose stored current rank score is at least this (see rank.ts). */
  minRankScore?: number;
  champions?: string[];
  queueId?: number;
}

function peerWhere(f: PeerFilter): { sql: string; params: SqlParam[] } {
  const clauses = ['pm.team_position = ?', 'pm.puuid != ?'];
  const params: SqlParam[] = [f.role, f.excludePuuid];
  if (f.minRankScore !== undefined) {
    clauses.push('pm.puuid IN (SELECT puuid FROM player_ranks WHERE score >= ?)');
    params.push(f.minRankScore);
  }
  if (f.champions?.length) {
    clauses.push(`pm.champion IN (${f.champions.map(() => '?').join(',')})`);
    params.push(...f.champions);
  }
  if (f.queueId !== undefined) {
    clauses.push('pm.match_id IN (SELECT match_id FROM matches WHERE queue_id = ?)');
    params.push(f.queueId);
  }
  return { sql: clauses.join(' AND '), params };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matches (
  match_id      TEXT PRIMARY KEY,
  queue_id      INTEGER,
  game_version  TEXT,
  game_end_ts   INTEGER,
  match_json    TEXT NOT NULL,
  timeline_json TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS participant_metrics (
  match_id      TEXT NOT NULL,
  puuid         TEXT NOT NULL,
  team_position TEXT NOT NULL,
  champion      TEXT NOT NULL,
  win           INTEGER NOT NULL,
  game_end_ts   INTEGER NOT NULL,
  kills         INTEGER NOT NULL,
  deaths        INTEGER NOT NULL,
  assists       INTEGER NOT NULL,
  metrics_json  TEXT NOT NULL,
  PRIMARY KEY (match_id, puuid)
);
CREATE INDEX IF NOT EXISTS idx_pm_puuid ON participant_metrics(puuid, game_end_ts);
CREATE INDEX IF NOT EXISTS idx_pm_role  ON participant_metrics(team_position);
CREATE TABLE IF NOT EXISTS crawled_players (
  puuid      TEXT PRIMARY KEY,
  crawled_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS player_ranks (
  puuid      TEXT PRIMARY KEY,
  platform   TEXT NOT NULL,
  tier       TEXT NOT NULL,
  division   TEXT NOT NULL,
  lp         INTEGER NOT NULL,
  score      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ranks_score ON player_ranks(score);
CREATE TABLE IF NOT EXISTS champion_mastery (
  puuid TEXT NOT NULL,
  champion TEXT NOT NULL,
  rank_idx INTEGER NOT NULL, -- 0 = most played
  points INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (puuid, champion)
);
CREATE TABLE IF NOT EXISTS mastery_checked (puuid TEXT PRIMARY KEY, checked_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_matches_queue ON matches(queue_id);
`;

interface MetricRow {
  match_id: string;
  puuid: string;
  team_position: string;
  champion: string;
  win: number;
  game_end_ts: number;
  kills: number;
  deaths: number;
  assists: number;
  metrics_json: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  hasMatch(matchId: string): boolean {
    return this.db.prepare('SELECT 1 FROM matches WHERE match_id = ?').get(matchId) !== undefined;
  }

  /** Saves raw payloads and derived metrics atomically. */
  saveMatch(match: MatchDto, timeline: TimelineDto, metrics: ParticipantMetrics[]): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO matches
           (match_id, queue_id, game_version, game_end_ts, match_json, timeline_json, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          match.metadata.matchId,
          match.info.queueId,
          match.info.gameVersion,
          match.info.gameEndTimestamp ?? match.info.gameCreation,
          JSON.stringify(match),
          JSON.stringify(timeline),
          Date.now(),
        );
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO participant_metrics
         (match_id, puuid, team_position, champion, win, game_end_ts, kills, deaths, assists, metrics_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const m of metrics) {
        insert.run(
          m.matchId,
          m.puuid,
          m.teamPosition,
          m.championName,
          m.win ? 1 : 0,
          m.gameEndTimestamp,
          m.kills,
          m.deaths,
          m.assists,
          JSON.stringify(m.metrics),
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Most recent analyzed games for a player, newest first. */
  playerGames(puuid: string, limit: number, opts: { queueId?: number; sinceMs?: number } = {}): ParticipantMetrics[] {
    const clauses = ['puuid = ?'];
    const params: SqlParam[] = [puuid];
    if (opts.queueId !== undefined) {
      clauses.push('match_id IN (SELECT match_id FROM matches WHERE queue_id = ?)');
      params.push(opts.queueId);
    }
    if (opts.sinceMs !== undefined) {
      clauses.push('game_end_ts >= ?');
      params.push(opts.sinceMs);
    }
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM participant_metrics WHERE ${clauses.join(' AND ')} ORDER BY game_end_ts DESC LIMIT ?`)
      .all(...params) as unknown as MetricRow[];
    return rows.map(toParticipantMetrics);
  }

  /** Per-game values of a metric across peers matching the filter. */
  perGameValues(key: MetricKey, filter: PeerFilter): number[] {
    const path = `$.${key}`;
    const where = peerWhere(filter);
    const rows = this.db
      .prepare(
        `SELECT json_extract(pm.metrics_json, ?) AS v FROM participant_metrics pm
         WHERE ${where.sql} AND json_extract(pm.metrics_json, ?) IS NOT NULL`,
      )
      .all(path, ...where.params, path) as { v: number }[];
    return rows.map((r) => r.v);
  }

  /** Per-player averages across peers matching the filter, for players with at least minGames samples. */
  perPlayerMeans(key: MetricKey, filter: PeerFilter, minGames: number): number[] {
    const path = `$.${key}`;
    const where = peerWhere(filter);
    const rows = this.db
      .prepare(
        `SELECT AVG(json_extract(pm.metrics_json, ?)) AS v, COUNT(json_extract(pm.metrics_json, ?)) AS n
         FROM participant_metrics pm WHERE ${where.sql}
         GROUP BY pm.puuid HAVING n >= ?`,
      )
      .all(path, path, ...where.params, minGames) as { v: number }[];
    return rows.map((r) => r.v);
  }

  /** Number of peer games and distinct peer players matching the filter. */
  peerCounts(filter: PeerFilter): { games: number; players: number } {
    const where = peerWhere(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS games, COUNT(DISTINCT pm.puuid) AS players FROM participant_metrics pm WHERE ${where.sql}`)
      .get(...where.params) as { games: number; players: number };
    return { games: row.games, players: row.players };
  }

  /** (match, player) pairs for every peer game matching the filter. */
  peerGameRefs(filter: PeerFilter): { matchId: string; puuid: string }[] {
    const where = peerWhere(filter);
    const rows = this.db
      .prepare(`SELECT pm.match_id AS matchId, pm.puuid AS puuid FROM participant_metrics pm WHERE ${where.sql}`)
      .all(...where.params) as { matchId: string; puuid: string }[];
    return rows.map((r) => ({ matchId: r.matchId, puuid: r.puuid }));
  }

  loadGame(matchId: string): { match: MatchDto; timeline: TimelineDto } | undefined {
    const row = this.db.prepare('SELECT match_json, timeline_json FROM matches WHERE match_id = ?').get(matchId) as
      | { match_json: string; timeline_json: string }
      | undefined;
    return row && { match: JSON.parse(row.match_json), timeline: JSON.parse(row.timeline_json) };
  }

  upsertRanks(platform: string, rows: (RankInfo & { puuid: string })[]): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO player_ranks (puuid, platform, tier, division, lp, score, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const r of rows) stmt.run(r.puuid, platform, r.tier, r.division, r.lp, rankScore(r), now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  rankCount(minRankScore: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM player_ranks WHERE score >= ?').get(minRankScore) as { n: number }).n;
  }

  /**
   * Players to crawl next. With minRankScore, candidates come from the stored ladder;
   * otherwise from players seen in stored matches. Players already seen on
   * preferChampions are crawled first (one-tricks are likely to play them again).
   */
  uncrawledPuuids(limit: number, opts: { minRankScore?: number; preferChampions?: string[]; preferRole?: string } = {}): string[] {
    const champs = opts.preferChampions ?? [];
    // Mains (champion in their top-2 mastery) first, then players seen on the champions in stored games.
    const inList = champs.map(() => '?').join(',');
    const pref = champs.length
      ? `(1000 * (SELECT COUNT(*) FROM champion_mastery cm WHERE cm.puuid = c.puuid AND cm.rank_idx < 2 AND cm.champion IN (${inList}))
          + (SELECT COUNT(*) FROM participant_metrics p2 WHERE p2.puuid = c.puuid AND p2.champion IN (${inList})))`
      : '0';
    // Players already seen in this role are likely to play it again: more peer games per request.
    const rolePref = opts.preferRole
      ? '(SELECT COUNT(*) FROM participant_metrics p3 WHERE p3.puuid = c.puuid AND p3.team_position = ?)'
      : '0';
    const source =
      opts.minRankScore === undefined
        ? 'SELECT DISTINCT puuid FROM participant_metrics'
        : 'SELECT puuid FROM player_ranks WHERE score >= ?';
    const params: SqlParam[] = [...champs, ...champs, ...(opts.preferRole ? [opts.preferRole] : []), ...(opts.minRankScore === undefined ? [] : [opts.minRankScore]), limit];
    const rows = this.db
      .prepare(
        `SELECT c.puuid, ${pref} AS pref, ${rolePref} AS role_pref FROM (${source}) c
         WHERE c.puuid NOT IN (SELECT puuid FROM crawled_players)
         ORDER BY pref DESC, role_pref DESC, RANDOM() LIMIT ?`,
      )
      .all(...params) as { puuid: string }[];
    return rows.map((r) => r.puuid);
  }

  /** Champion id -> name, from stored match data. */
  championNames(): Map<number, string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT json_extract(j.value, '$.championId') AS id, json_extract(j.value, '$.championName') AS name
         FROM (SELECT match_json FROM matches ORDER BY game_end_ts DESC LIMIT 1500) m, json_each(m.match_json, '$.info.participants') j`,
      )
      .all() as { id: number; name: string }[];
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Ladder players at/above minRankScore whose top champions are not stored yet, highest LP first. */
  uncheckedMasteryPuuids(minRankScore: number, limit: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT puuid FROM player_ranks WHERE score >= ? AND puuid NOT IN (SELECT puuid FROM mastery_checked)
           ORDER BY score DESC LIMIT ?`,
        )
        .all(minRankScore, limit) as { puuid: string }[]
    ).map((r) => r.puuid);
  }

  saveMasteries(puuid: string, top: { champion: string; points: number }[]): void {
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM champion_mastery WHERE puuid = ?').run(puuid);
      const ins = this.db.prepare('INSERT INTO champion_mastery (puuid, champion, rank_idx, points, checked_at) VALUES (?, ?, ?, ?, ?)');
      top.forEach((m, i) => ins.run(puuid, m.champion, i, m.points, now));
      this.db.prepare('INSERT OR REPLACE INTO mastery_checked (puuid, checked_at) VALUES (?, ?)').run(puuid, now);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** "Main" = the champion is in the player's top 2 by mastery. */
  mainCounts(champions: string[], minRankScore?: number): { champion: string; mains: number; crawled: number }[] {
    return champions.map((c) => {
      const base = `FROM champion_mastery m ${minRankScore === undefined ? '' : 'JOIN player_ranks r ON r.puuid = m.puuid AND r.score >= ?'} WHERE m.champion = ? AND m.rank_idx < 2`;
      const params: SqlParam[] = [...(minRankScore === undefined ? [] : [minRankScore]), c];
      const mains = (this.db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...params) as { n: number }).n;
      const crawled = (this.db.prepare(`SELECT COUNT(*) AS n ${base} AND m.puuid IN (SELECT puuid FROM crawled_players)`).get(...params) as { n: number }).n;
      return { champion: c, mains, crawled };
    });
  }

  markCrawled(puuid: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO crawled_players (puuid, crawled_at) VALUES (?, ?)')
      .run(puuid, Date.now());
  }

  counts(): { matches: number; playerGames: number; players: number } {
    const get = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      matches: get('SELECT COUNT(*) AS n FROM matches'),
      playerGames: get('SELECT COUNT(*) AS n FROM participant_metrics'),
      players: get('SELECT COUNT(DISTINCT puuid) AS n FROM participant_metrics'),
    };
  }
}

function toParticipantMetrics(row: MetricRow): ParticipantMetrics {
  return {
    matchId: row.match_id,
    puuid: row.puuid,
    championName: row.champion,
    teamPosition: row.team_position as TeamPosition,
    win: row.win === 1,
    gameEndTimestamp: row.game_end_ts,
    kills: row.kills,
    deaths: row.deaths,
    assists: row.assists,
    metrics: JSON.parse(row.metrics_json) as MetricValues,
  };
}
