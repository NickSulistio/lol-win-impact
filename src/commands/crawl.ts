import type { Config } from '../config';
import { Store } from '../db';
import { ingestMatches } from '../ingest';
import { apexLpScore } from '../rank';
import { RiotApiError, RiotClient, type ApexTier } from '../riot/client';
import { regionFor } from '../riot/routing';

export interface CrawlOptions {
  players: number;
  count: number;
  /** Crawl ladder players at Master + this LP or above (requires seed-ranks). */
  minLp?: number;
  /** Crawl players already seen on these champions first. */
  preferChampions?: string[];
  /** Then crawl players already seen in this role (e.g. TOP). */
  preferRole?: string;
}

const SOLO_QUEUE = 420;

/**
 * Snowball crawl: fetch recent games for players we know about. Each match adds 10
 * participants to the benchmark pool. With minLp, candidates come from the apex ladder
 * and only solo-queue games are fetched, so peer ranks are meaningful.
 */
export async function crawl(config: Config, opts: CrawlOptions): Promise<void> {
  const client = new RiotClient({ apiKey: config.apiKey, limits: config.limits });
  const store = new Store(config.dbPath);
  const region = regionFor(config.platform);
  const minRankScore = opts.minLp === undefined ? undefined : apexLpScore(opts.minLp);

  try {
    if (minRankScore !== undefined && store.rankCount(minRankScore) === 0) {
      console.log('No ladder players stored at that LP. Run "npm run cli -- seed-ranks" first.');
      return;
    }
    const puuids = store.uncrawledPuuids(opts.players, { minRankScore, preferChampions: opts.preferChampions, preferRole: opts.preferRole?.toUpperCase() });
    if (puuids.length === 0) {
      console.log('Nothing to crawl. Run "analyze" (or "seed-ranks" with --min-lp) first.');
      return;
    }
    const estimate = puuids.length * (1 + opts.count * 2);
    console.log(`Crawling ${puuids.length} players (up to ~${estimate} requests)...`);

    for (const [i, puuid] of puuids.entries()) {
      const ids = await client.getMatchIds(region, puuid, {
        count: opts.count,
        ...(minRankScore === undefined ? { type: 'ranked' as const } : { queue: SOLO_QUEUE }),
      });
      const res = await ingestMatches(client, store, region, ids);
      store.markCrawled(puuid);
      console.log(
        `[${i + 1}/${puuids.length}] ${puuid.slice(0, 8)}… fetched ${res.fetched}, cached ${res.cached}, failed ${res.failed}`,
      );
    }
    const totals = store.counts();
    console.log(`Dataset: ${totals.matches} matches, ${totals.players} players, ${totals.playerGames} player-games.`);
  } finally {
    store.close();
  }
}

/** Stores the current Master/Grandmaster/Challenger solo-queue ladder (3 requests). */
export async function seedRanks(config: Config): Promise<void> {
  const client = new RiotClient({ apiKey: config.apiKey, limits: config.limits });
  const store = new Store(config.dbPath);
  try {
    for (const tier of ['challenger', 'grandmaster', 'master'] as ApexTier[]) {
      const league = await client.getApexLeague(config.platform, tier);
      store.upsertRanks(
        config.platform,
        league.entries.map((e) => ({ puuid: e.puuid, tier: league.tier, division: e.rank, lp: e.leaguePoints })),
      );
      console.log(`${league.tier}: ${league.entries.length} players`);
    }
  } finally {
    store.close();
  }
}

/**
 * Stores each ladder player's top-3 mastery champions (1 request per player, on the platform
 * host, so it does not compete with match downloads). Lets `crawl --prefer` target real mains.
 */
export async function findMains(config: Config, opts: { minLp: number; players: number; champions: string[] }): Promise<void> {
  const client = new RiotClient({ apiKey: config.apiKey, limits: config.limits });
  const store = new Store(config.dbPath);
  try {
    const minRankScore = apexLpScore(opts.minLp);
    const names = store.championNames();
    const todo = store.uncheckedMasteryPuuids(minRankScore, opts.players);
    console.log(`Checking top champions for ${todo.length} players (Master ${opts.minLp}+ LP)...`);
    for (const [i, puuid] of todo.entries()) {
      try {
        const top = await client.getTopMasteries(config.platform, puuid, 3);
        store.saveMasteries(puuid, top.map((m) => ({ champion: names.get(m.championId) ?? `#${m.championId}`, points: m.championPoints })));
      } catch (err) {
        if (err instanceof RiotApiError && (err.status === 401 || err.status === 403)) throw err;
        console.log(`  ${puuid.slice(0, 8)}… failed: ${(err as Error).message}`);
      }
      if ((i + 1) % 100 === 0 || i === todo.length - 1) {
        const c = store.mainCounts(opts.champions, minRankScore);
        console.log(`[${i + 1}/${todo.length}] mains so far: ${c.map((x) => `${x.champion} ${x.mains}`).join(', ')}`);
      }
    }
    for (const c of store.mainCounts(opts.champions, minRankScore)) console.log(`${c.champion}: ${c.mains} mains at Master ${opts.minLp}+ LP (${c.crawled} crawled)`);
  } finally {
    store.close();
  }
}
