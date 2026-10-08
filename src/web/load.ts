import type { Config } from '../config';
import { Store } from '../db';
import { apexLpScore } from '../rank';
import { RiotClient } from '../riot/client';
import { accountRegionFor } from '../riot/routing';
import { parseRiotId } from '../commands/analyze';
import { loadModel } from '../wp/model';
import { buildReport, type ReportData } from './build';

export interface ReportQuery {
  riotId: string;
  role: string;
  since?: string;
  sinceMs?: number;
  queue?: number;
  minLp?: number;
  champions: string[];
}

/** Resolve the Riot ID (one API call), then build the report from stored games. */
export async function loadReportData(config: Config, q: ReportQuery): Promise<ReportData> {
  const client = new RiotClient({ apiKey: config.apiKey, limits: config.limits });
  const { gameName, tagLine } = parseRiotId(q.riotId);
  const account = await client.getAccountByRiotId(accountRegionFor(config.platform), gameName, tagLine);
  const store = new Store(config.dbPath);
  try {
    const role = q.role.toUpperCase();
    const peerRefs = store.peerGameRefs({
      role,
      excludePuuid: account.puuid,
      queueId: q.queue,
      minRankScore: q.minLp === undefined ? undefined : apexLpScore(q.minLp),
    });
    return buildReport(store, loadModel('data/wp-model.json'), {
      puuid: account.puuid,
      name: `${account.gameName}#${account.tagLine}`,
      role,
      season: q.since ? `Season ${q.since}${q.queue === 420 ? ' solo queue' : ''}` : 'All stored games',
      sinceMs: q.sinceMs,
      queue: q.queue,
      peerRefs,
      peerLabel: q.minLp === undefined ? 'stored' : `Master ${q.minLp}+ LP`,
      champions: q.champions,
    });
  } finally {
    store.close();
  }
}
