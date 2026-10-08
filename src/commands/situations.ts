import type { Config } from '../config';
import { Store, type PeerFilter } from '../db';
import { findSituations, SITUATIONS, type Situation, type SituationKind } from '../insights/situations';
import { apexLpScore } from '../rank';
import { renderTable } from '../report';
import { RiotClient } from '../riot/client';
import { accountRegionFor } from '../riot/routing';
import { loadModel } from '../wp/model';
import { parseRiotId } from './analyze';

export interface SituationOptions {
  riotId: string;
  role: string;
  sinceMs?: number;
  queue?: number;
  minLp?: number;
  champion?: string;
}

const pp = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`;

function summarize(rows: Situation[]) {
  const n = rows.length;
  const mean = n ? rows.reduce((s, r) => s + r.dWp, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rows.reduce((s, r) => s + (r.dWp - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, ci: n > 1 ? (1.96 * sd) / Math.sqrt(n) : NaN, wr: n ? rows.filter((r) => r.win).length / n : 0 };
}

/** "When he does X in situation Y, his team's win chance moves by Z" — with peers for comparison. */
export async function situations(config: Config, opts: SituationOptions): Promise<void> {
  const client = new RiotClient({ apiKey: config.apiKey, limits: config.limits });
  const store = new Store(config.dbPath);
  const model = loadModel('data/wp-model.json');
  try {
    const { gameName, tagLine } = parseRiotId(opts.riotId);
    const account = await client.getAccountByRiotId(accountRegionFor(config.platform), gameName, tagLine);
    const role = opts.role.toUpperCase();
    const collect = (refs: { matchId: string; puuid: string }[]) =>
      refs.flatMap(({ matchId, puuid }) => {
        const g = store.loadGame(matchId);
        if (!g) return [];
        const me = g.match.info.participants.find((p) => p.puuid === puuid);
        if (opts.champion && me?.championName !== opts.champion) return [];
        return findSituations(g.match, g.timeline, puuid, model);
      });

    const myGames = store
      .playerGames(account.puuid, 5000, { queueId: opts.queue, sinceMs: opts.sinceMs })
      .filter((g) => g.teamPosition === role);
    const mine = collect(myGames.map((g) => ({ matchId: g.matchId, puuid: account.puuid })));
    const filter: PeerFilter = {
      role,
      excludePuuid: account.puuid,
      queueId: opts.queue,
      minRankScore: opts.minLp === undefined ? undefined : apexLpScore(opts.minLp),
    };
    const peerRefs = store.peerGameRefs(filter);
    const peers = collect(peerRefs);

    console.log(
      `${account.gameName}${opts.champion ? ` (${opts.champion})` : ''}: ${myGames.length} ${role} games. Peers: ${peerRefs.length} games.\n` +
        'Change = his team\'s win probability over the window (model-based, so the starting game state is accounted for).\n' +
        '"vs best" = how much worse each response is than the best one for him; * = 95% interval excludes zero.\n',
    );

    const rules: { text: string; gain: number; ci: number; n: number }[] = [];
    for (const [kind, def] of Object.entries(SITUATIONS) as [SituationKind, (typeof SITUATIONS)[SituationKind]][]) {
      const m = mine.filter((s) => s.kind === kind);
      const p = peers.filter((s) => s.kind === kind);
      if (!m.length) continue;
      const stats = def.responses.map((r) => ({ r, me: summarize(m.filter((s) => s.response === r)), peer: summarize(p.filter((s) => s.response === r)) }));
      console.log(`## ${def.title} (${def.window}) - ${m.length} times for him, ${(m.length / myGames.length).toFixed(2)}/game`);
      console.log(
        renderTable(
          ['What he did', 'His share', 'His change', '95% +/-', 'His WR', 'Peer share', 'Peer change', 'Peer WR'],
          stats.map((s) => [
            s.r,
            `${Math.round((100 * s.me.n) / m.length)}% (${s.me.n})`,
            s.me.n ? pp(s.me.mean) : '-',
            s.me.n > 1 ? (s.me.ci * 100).toFixed(1) : '-',
            s.me.n ? `${Math.round(s.me.wr * 100)}%` : '-',
            p.length ? `${Math.round((100 * s.peer.n) / p.length)}% (${s.peer.n})` : '-',
            s.peer.n ? pp(s.peer.mean) : '-',
            s.peer.n ? `${Math.round(s.peer.wr * 100)}%` : '-',
          ]),
          new Set([1, 2, 3, 4, 5, 6, 7]),
        ),
      );
      console.log('');
      // Rule: best response vs his most common other response, if both have 10+ samples.
      const usable = stats.filter((s) => s.me.n >= 10).sort((a, b) => b.me.mean - a.me.mean);
      if (usable.length >= 2) {
        const best = usable[0]!;
        const usual = usable.slice(1).sort((a, b) => b.me.n - a.me.n)[0]!;
        const diff = best.me.mean - usual.me.mean;
        const ci = Math.hypot(best.me.ci, usual.me.ci);
        rules.push({
          text: `${def.title.replace(/^He is |^He /, '').replace(/^His /, 'his ')}: "${best.r}" instead of "${usual.r}"`,
          gain: diff,
          ci,
          n: best.me.n + usual.me.n,
        });
      }
    }

    console.log('## Rules for him, ranked by win-probability gain (best response vs his next most common one)');
    console.log(
      renderTable(
        ['When...', 'Gain', '95% +/-', 'n'],
        rules
          .sort((a, b) => b.gain - a.gain)
          .map((r) => [r.text, `${pp(r.gain)}${r.gain - r.ci > 0 ? ' *' : ''}`, (r.ci * 100).toFixed(1), String(r.n)]),
        new Set([1, 2, 3]),
      ),
    );
  } finally {
    store.close();
  }
}
