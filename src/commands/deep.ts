import type { Config } from '../config';
import { Store, type PeerFilter } from '../db';
import { computeGameFeatures, type GameFeatures } from '../insights/features';
import { renderDeepReport, type Group } from '../insights/report';
import { apexLpScore } from '../rank';
import { RiotClient } from '../riot/client';
import { accountRegionFor } from '../riot/routing';
import { parseRiotId } from './analyze';

export interface DeepOptions {
  riotId: string;
  role: string;
  sinceMs?: number;
  queue?: number;
  minLp?: number;
  champions?: string[];
}

/** Phase-by-phase analysis from stored games only (run `analyze` first to fetch them). */
export async function deep(config: Config, opts: DeepOptions): Promise<void> {
  const client = new RiotClient({ apiKey: config.apiKey, limits: config.limits });
  const store = new Store(config.dbPath);
  try {
    const { gameName, tagLine } = parseRiotId(opts.riotId);
    const account = await client.getAccountByRiotId(accountRegionFor(config.platform), gameName, tagLine);
    const role = opts.role.toUpperCase();

    const features = (refs: { matchId: string; puuid: string }[]): GameFeatures[] =>
      refs.flatMap(({ matchId, puuid }) => {
        const game = store.loadGame(matchId);
        const f = game && computeGameFeatures(game.match, game.timeline, puuid);
        return f ? [f] : [];
      });

    const mine = store
      .playerGames(account.puuid, 5000, { queueId: opts.queue, sinceMs: opts.sinceMs })
      .filter((g) => g.teamPosition === role);
    if (!mine.length) {
      console.log(`No stored ${role} games for ${opts.riotId}. Run "analyze" first.`);
      return;
    }
    const you = features(mine.map((g) => ({ matchId: g.matchId, puuid: account.puuid })));

    const filter: PeerFilter = {
      role,
      excludePuuid: account.puuid,
      queueId: opts.queue,
      minRankScore: opts.minLp === undefined ? undefined : apexLpScore(opts.minLp),
    };
    const peerGames = features(store.peerGameRefs(filter));
    const peerPlayers = new Set(peerGames.map((g) => g.puuid)).size;

    const groups: Group[] = [{ name: 'Him', games: you }];
    for (const champ of opts.champions ?? []) {
      groups.push({ name: champ, games: you.filter((g) => g.champion === champ) });
    }
    const wins = you.filter((g) => g.win).length;
    console.log(
      `${account.gameName}#${account.tagLine}: ${you.length} ${role} games (${wins}-${you.length - wins}). ` +
        `Peers: ${peerGames.length} ${role} games from ${peerPlayers} players` +
        (opts.minLp === undefined ? '.' : ` currently Master ${opts.minLp}+ LP.`),
    );
    console.log(
      'Columns: his overall average, his per-champion averages, peer average. "vs peers" flags gaps of 0.25 SD+ (averages) or 15%+ (rates).',
    );
    console.log(renderDeepReport(groups, { name: 'Peers', games: peerGames }));
  } finally {
    store.close();
  }
}
