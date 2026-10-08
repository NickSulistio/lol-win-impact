import type { Config } from '../config';
import { Store } from '../db';
import { explainAll, type Explanation } from '../insights/explain';
import { findSituations, type Situation } from '../insights/situations';
import { apexLpScore } from '../rank';
import { RiotClient } from '../riot/client';
import { accountRegionFor } from '../riot/routing';
import { loadModel } from '../wp/model';
import { parseRiotId } from './analyze';

export interface ExplainOptions {
  riotId: string;
  role: string;
  sinceMs?: number;
  queue?: number;
  minLp?: number;
  champions: string[];
  /** Only show explanations whose gap is clear of noise. */
  significantOnly: boolean;
  top: number;
}

const pp = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}`;

/** Finds the gaps between him and peers (and between his own choices) and explains each one. */
export async function explain(config: Config, opts: ExplainOptions): Promise<void> {
  const client = new RiotClient({ apiKey: config.apiKey, limits: config.limits });
  const store = new Store(config.dbPath);
  try {
    const model = loadModel('data/wp-model.json');
    const { gameName, tagLine } = parseRiotId(opts.riotId);
    const account = await client.getAccountByRiotId(accountRegionFor(config.platform), gameName, tagLine);
    const role = opts.role.toUpperCase();
    const collect = (refs: { matchId: string; puuid: string }[]): Situation[] =>
      refs.flatMap(({ matchId, puuid }) => {
        const g = store.loadGame(matchId);
        return g ? findSituations(g.match, g.timeline, puuid, model) : [];
      });
    const myGames = store.playerGames(account.puuid, 5000, { queueId: opts.queue, sinceMs: opts.sinceMs }).filter((g) => g.teamPosition === role);
    const mine = collect(myGames.map((g) => ({ matchId: g.matchId, puuid: account.puuid })));
    const peerRefs = store.peerGameRefs({ role, excludePuuid: account.puuid, queueId: opts.queue, minRankScore: opts.minLp === undefined ? undefined : apexLpScore(opts.minLp) });
    const peers = collect(peerRefs);

    const all = explainAll(mine, peers, myGames.length, opts.champions);
    const shown = all.filter((e) => !opts.significantOnly || e.significant).slice(0, opts.top);
    console.log(`${account.gameName}: ${myGames.length} ${role} games vs ${peerRefs.length} peer games. ${all.filter((e) => e.significant).length} of ${all.length} gaps are clear of noise.\n`);
    console.log('Ranked by win chance per game the gap is worth. Gap = change in win chance per case over the situation window.\n');
    for (const [i, e] of shown.entries()) printExplanation(i + 1, e);
  } finally {
    store.close();
  }
}

function printExplanation(i: number, e: Explanation): void {
  const label = e.type === 'response-contrast' ? 'difference' : 'gap vs peers';
  console.log(`${i}. ${e.title}`);
  console.log(`   ${label} ${pp(e.gap)} ±${(e.ci * 100).toFixed(1)} per case${e.significant ? '' : ' (could be noise)'} · worth ${pp(e.perGame)} per game · ${e.n.a} vs ${e.n.b} cases`);
  for (const line of e.summary) console.log(`   - ${line}`);
  console.log('');
}
