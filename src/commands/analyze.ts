import type { Config } from '../config';
import { Store, type PeerFilter } from '../db';
import { ingestMatches } from '../ingest';
import { apexLpScore, formatRank, rankScore } from '../rank';
import { mainRole, renderChampionPool, renderGames, renderSummary, summarize } from '../report';
import { RiotClient } from '../riot/client';
import { accountRegionFor, regionFor } from '../riot/routing';

export interface AnalyzeOptions {
  riotId: string;
  /** Max games. With `sinceMs`, an upper bound on how far back to page. */
  count: number;
  /** Only games ending after this (epoch ms), e.g. the season start. */
  sinceMs?: number;
  queue?: number;
  role?: string;
  /** Peers must be at least Master + this many LP (current ladder rank). */
  minLp?: number;
  /** Extra per-champion breakdowns, e.g. ["Riven", "Camille"]. */
  champions?: string[];
}

const SOLO_QUEUE = 420;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function parseRiotId(riotId: string): { gameName: string; tagLine: string } {
  const idx = riotId.lastIndexOf('#');
  if (idx <= 0 || idx === riotId.length - 1) {
    throw new Error(`Riot ID must look like "Name#TAG", got "${riotId}"`);
  }
  return { gameName: riotId.slice(0, idx), tagLine: riotId.slice(idx + 1) };
}

export async function analyze(config: Config, opts: AnalyzeOptions): Promise<void> {
  const client = new RiotClient({ apiKey: config.apiKey, limits: config.limits });
  const store = new Store(config.dbPath);
  const region = regionFor(config.platform);
  // Ranks are solo-queue ladder ranks, so rank-filtered comparisons use solo queue only.
  const queueId = opts.queue ?? (opts.minLp !== undefined ? SOLO_QUEUE : undefined);

  try {
    const { gameName, tagLine } = parseRiotId(opts.riotId);
    const account = await client.getAccountByRiotId(accountRegionFor(config.platform), gameName, tagLine);
    const solo = (await client.getLeagueEntries(config.platform, account.puuid)).find(
      (e) => e.queueType === 'RANKED_SOLO_5x5',
    );
    const rank = solo ? { tier: solo.tier, division: solo.rank, lp: solo.leaguePoints } : undefined;
    if (rank) store.upsertRanks(config.platform, [{ puuid: account.puuid, ...rank }]);
    console.log(
      `Player ${account.gameName ?? gameName}#${account.tagLine ?? tagLine} (${config.platform}) - ` +
        (rank ? `${formatRank(rank)}, ${solo!.wins}W ${solo!.losses}L` : 'unranked in solo queue'),
    );

    const idQuery = {
      type: queueId ? undefined : ('ranked' as const),
      queue: queueId,
      startTime: opts.sinceMs === undefined ? undefined : Math.floor(opts.sinceMs / 1000),
    };
    const ids =
      opts.sinceMs === undefined
        ? await client.getMatchIds(region, account.puuid, { ...idQuery, count: opts.count })
        : await client.getAllMatchIds(region, account.puuid, idQuery, opts.count);
    if (opts.sinceMs !== undefined && ids.length === opts.count) {
      console.log(`Stopped at --count ${opts.count}; older games in the range were skipped.`);
    }
    console.log(`Found ${ids.length} matches, fetching new ones...`);
    const res = await ingestMatches(client, store, region, ids, console.log);
    console.log(`Fetched ${res.fetched}, cached ${res.cached}, failed ${res.failed}.\n`);
    store.markCrawled(account.puuid);

    const games = store.playerGames(account.puuid, opts.count, { queueId, sinceMs: opts.sinceMs });
    if (games.length === 0) {
      console.log('No analyzable games (remakes are excluded).');
      return;
    }
    const span = `${isoDate(games.at(-1)!.gameEndTimestamp)} to ${isoDate(games[0]!.gameEndTimestamp)}`;
    console.log(`${games.length} games analyzed (${span}), ${Math.max(0, ids.length - games.length)} remakes/unavailable skipped.\n`);
    if (games.length > 25) {
      console.log(renderChampionPool(games));
      console.log('\nLast 10 games:');
      console.log(renderGames(games.slice(0, 10)));
    } else {
      console.log(renderGames(games));
    }

    const role = opts.role?.toUpperCase() ?? mainRole(games);
    if (!role) {
      console.log("\nNo role data in these games (non-Summoner's Rift queue?).");
      return;
    }
    const base: PeerFilter = {
      role,
      excludePuuid: account.puuid,
      queueId,
      minRankScore: opts.minLp === undefined ? undefined : apexLpScore(opts.minLp),
    };
    const peerLabel =
      opts.minLp === undefined
        ? 'all players in the local dataset'
        : `players currently Master ${opts.minLp}+ LP` +
          (rank && rankScore(rank) < base.minRankScore! ? ' (above the player)' : '');

    const slices: { title: string; champions?: string[] }[] = [{ title: `${role}, all champions` }];
    for (const champ of opts.champions ?? []) slices.push({ title: `${role}, ${champ}`, champions: [champ] });

    for (const slice of slices) {
      const mine = games.filter(
        (g) => g.teamPosition === role && (!slice.champions || slice.champions.includes(g.championName)),
      );
      const filter = { ...base, champions: slice.champions };
      const peers = store.peerCounts(filter);
      console.log(
        `\n== ${slice.title}: ${mine.length} of your games vs ${peers.games} games from ${peers.players} ${peerLabel}`,
      );
      if (mine.length === 0) {
        console.log('No games of yours in this slice; raise --count.');
        continue;
      }
      console.log(renderSummary(summarize(store, mine, filter)));
    }

    if (store.counts().players < 200) {
      console.log('\nBenchmarks are thin. Grow the peer dataset with: npm run crawl -- --players 20');
    }
  } finally {
    store.close();
  }
}
