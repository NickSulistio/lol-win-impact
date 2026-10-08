import type { Config } from '../config';
import { Store, type PeerFilter } from '../db';
import { apexLpScore } from '../rank';
import { renderTable } from '../report';
import { RiotClient } from '../riot/client';
import { accountRegionFor } from '../riot/routing';
import type { MatchDto, TimelineDto } from '../riot/types';
import { FEATURE_NAMES, loadModel, predict, saveModel, train, type ModelEvaluation, type WinModel } from '../wp/model';
import { GameTimeline, type GameState } from '../wp/state';
import { computeWpa, type Category, type DeathRecord, type Phase, type PlayerWpa } from '../wp/wpa';
import { parseRiotId } from './analyze';

const MODEL_PATH = 'data/wp-model.json';
const pp = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}`;
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/**
 * One-minute snapshots (game state + result) from every stored ranked game of 15+ minutes.
 * Games are loaded one at a time so memory stays flat as the dataset grows.
 */
function snapshotRows(store: Store): { rows: { id: string; state: GameState; blueWin: boolean }[]; matchIds: string[] } {
  const ids = store.db.prepare('SELECT match_id FROM matches WHERE queue_id IN (420, 440)').all() as { match_id: string }[];
  const rows: { id: string; state: GameState; blueWin: boolean }[] = [];
  const matchIds: string[] = [];
  for (const { match_id } of ids) {
    const g = store.loadGame(match_id);
    if (!g || g.match.info.gameDuration < 15 * 60) continue;
    matchIds.push(match_id);
    const gt = new GameTimeline(g.match, g.timeline);
    for (const f of g.timeline.info.frames) {
      if (f.timestamp >= 60_000) rows.push({ id: match_id, state: gt.stateAt(f.timestamp), blueWin: gt.blueWin });
    }
  }
  return { rows, matchIds };
}

/** Trains the win model, reports held-out accuracy and calibration, then refits on everything. */
export async function wpTrain(config: Config): Promise<void> {
  const store = new Store(config.dbPath);
  try {
    const { rows, matchIds } = snapshotRows(store);
    const games = matchIds;
    const test = (id: string) => hash(id) % 5 === 0;
    const model = train(rows.filter((r) => !test(r.id)), games.filter((id) => !test(id)).length);
    const held = rows.filter((r) => test(r.id));
    console.log(`Trained on ${model.trainedOn.matches} matches; testing on ${games.length - model.trainedOn.matches} held-out matches.\n`);

    const buckets: [string, (s: GameState) => boolean][] = [
      ['5 min', (s) => Math.round(s.minute) === 5],
      ['10 min', (s) => Math.round(s.minute) === 10],
      ['15 min', (s) => Math.round(s.minute) === 15],
      ['20 min', (s) => Math.round(s.minute) === 20],
      ['25 min', (s) => Math.round(s.minute) === 25],
      ['30 min', (s) => Math.round(s.minute) === 30],
      ['all minutes', () => true],
    ];
    console.log(
      renderTable(
        ['Game time', 'Accuracy', 'Log loss', 'n'],
        buckets.map(([label, pred]) => {
          const b = held.filter((r) => pred(r.state));
          const ps = b.map((r) => predict(model, r.state));
          const acc = b.filter((r, i) => (ps[i]! > 0.5) === r.blueWin).length / Math.max(1, b.length);
          const ll = -b.reduce((s, r, i) => s + Math.log(Math.min(1 - 1e-9, Math.max(1e-9, r.blueWin ? ps[i]! : 1 - ps[i]!))), 0) / Math.max(1, b.length);
          return [label, `${(acc * 100).toFixed(1)}%`, ll.toFixed(3), String(b.length)];
        }),
        new Set([1, 2, 3]),
      ),
    );

    console.log('\nCalibration (held out): when the model says X%, how often does blue win?');
    const cal = Array.from({ length: 5 }, (_, i) => {
      const lo = i / 5;
      const b = held.filter((r) => {
        const p = predict(model, r.state);
        return p >= lo && p < lo + 0.2;
      });
      const avgP = b.reduce((s, r) => s + predict(model, r.state), 0) / Math.max(1, b.length);
      const actual = b.filter((r) => r.blueWin).length / Math.max(1, b.length);
      return [`${lo * 100}-${lo * 100 + 20}%`, `${(avgP * 100).toFixed(0)}%`, `${(actual * 100).toFixed(0)}%`, String(b.length)];
    });
    console.log(renderTable(['Predicted', 'Avg predicted', 'Actual', 'n'], cal, new Set([1, 2, 3])));

    const ps = held.map((r) => predict(model, r.state));
    const clampLog = (p: number) => Math.log(Math.min(1 - 1e-9, Math.max(1e-9, p)));
    const evaluation: ModelEvaluation = {
      heldOutMatches: games.length - model.trainedOn.matches,
      accuracy: Array.from({ length: 35 }, (_, i) => i + 1).flatMap((minute) => {
        const idx = held.map((r, i) => (Math.round(r.state.minute) === minute ? i : -1)).filter((i) => i >= 0);
        if (idx.length < 30) return [];
        return [{ minute, accuracy: idx.filter((i) => (ps[i]! > 0.5) === held[i]!.blueWin).length / idx.length, n: idx.length }];
      }),
      overallAccuracy: held.filter((r, i) => (ps[i]! > 0.5) === r.blueWin).length / held.length,
      logLoss: -held.reduce((s, r, i) => s + clampLog(r.blueWin ? ps[i]! : 1 - ps[i]!), 0) / held.length,
      baselineLogLoss: Math.log(2),
      calibration: Array.from({ length: 10 }, (_, i) => {
        const idx = ps.map((p, j) => (p >= i / 10 && (p < (i + 1) / 10 || i === 9) ? j : -1)).filter((j) => j >= 0);
        return {
          predicted: idx.reduce((s, j) => s + ps[j]!, 0) / Math.max(1, idx.length),
          actual: idx.filter((j) => held[j]!.blueWin).length / Math.max(1, idx.length),
          n: idx.length,
        };
      }).filter((b) => b.n > 0),
    };
    const final = { ...train(rows, games.length), evaluation };
    saveModel(MODEL_PATH, final);
    console.log('\nCoefficients (log-odds; "x time" terms scale with minutes/30):');
    console.log(renderTable(['Feature', 'Weight'], FEATURE_NAMES.map((n, i) => [n, final.weights[i]!.toFixed(3)]), new Set([1])));
    console.log(`\nSaved ${MODEL_PATH} (${final.trainedOn.matches} matches, ${final.trainedOn.rows} snapshots).`);
  } finally {
    store.close();
  }
}

export interface WpaOptions {
  riotId: string;
  role: string;
  sinceMs?: number;
  queue?: number;
  minLp?: number;
  champions?: string[];
}

const CATS: Category[] = ['economy', 'kills', 'deaths', 'objectives', 'structures'];
const PHASES: Phase[] = ['laning', 'mid', 'late'];

function average(rows: PlayerWpa[]) {
  const n = Math.max(1, rows.length);
  const sum = (f: (r: PlayerWpa) => number) => rows.reduce((s, r) => s + f(r), 0) / n;
  return {
    n: rows.length,
    total: sum((r) => r.total),
    cats: Object.fromEntries(CATS.map((c) => [c, sum((r) => r.byCategory[c])])) as Record<Category, number>,
    phases: Object.fromEntries(PHASES.map((p) => [p, sum((r) => r.byPhase[p])])) as Record<Phase, number>,
    deathsPerGame: sum((r) => r.deaths.length),
    costPerDeath: rows.flatMap((r) => r.deaths).reduce((s, d) => s + d.cost, 0) / Math.max(1, rows.flatMap((r) => r.deaths).length),
  };
}

/** Per-game WPA for a player vs peers, plus his costliest deaths for review. */
export async function wpa(config: Config, opts: WpaOptions): Promise<void> {
  const client = new RiotClient({ apiKey: config.apiKey, limits: config.limits });
  const store = new Store(config.dbPath);
  let model: WinModel;
  try {
    model = loadModel(MODEL_PATH);
  } catch {
    throw new Error('No win model yet. Run: npm run cli -- wp-train');
  }
  try {
    const { gameName, tagLine } = parseRiotId(opts.riotId);
    const account = await client.getAccountByRiotId(accountRegionFor(config.platform), gameName, tagLine);
    const role = opts.role.toUpperCase();
    const score = (refs: { matchId: string; puuid: string }[]) =>
      refs.flatMap(({ matchId, puuid }) => {
        const g = store.loadGame(matchId);
        if (!g || g.match.info.gameDuration < 15 * 60) return [];
        const p = computeWpa(g.match, g.timeline, model).find((x) => x.puuid === puuid);
        return p ? [p] : [];
      });

    const mine = score(
      store
        .playerGames(account.puuid, 5000, { queueId: opts.queue, sinceMs: opts.sinceMs })
        .filter((g) => g.teamPosition === role)
        .map((g) => ({ matchId: g.matchId, puuid: account.puuid })),
    );
    const filter: PeerFilter = {
      role,
      excludePuuid: account.puuid,
      queueId: opts.queue,
      minRankScore: opts.minLp === undefined ? undefined : apexLpScore(opts.minLp),
    };
    const peers = score(store.peerGameRefs(filter));
    console.log(
      `Win model: ${model.trainedOn.matches} matches. ${account.gameName}: ${mine.length} ${role} games; peers: ${peers.length} games.\n` +
        'Values are win-probability points per game for his team (+5.0 = his actions added 5% win chance per game).\n',
    );

    const cols: { name: string; rows: PlayerWpa[] }[] = [
      { name: 'Him', rows: mine },
      ...(opts.champions ?? []).map((c) => ({ name: c, rows: mine.filter((r) => r.champion === c) })),
      { name: 'His wins', rows: mine.filter((r) => r.win) },
      { name: 'His losses', rows: mine.filter((r) => !r.win) },
      { name: 'Peers', rows: peers },
      { name: 'Peer wins', rows: peers.filter((r) => r.win) },
      { name: 'Peer losses', rows: peers.filter((r) => !r.win) },
    ];
    const avgs = cols.map((c) => average(c.rows));
    const line = (label: string, f: (a: ReturnType<typeof average>) => string) => [label, ...avgs.map(f)];
    console.log(
      renderTable(
        ['Per game', ...cols.map((c) => c.name)],
        [
          line('Games', (a) => String(a.n)),
          line('Total WPA', (a) => pp(a.total)),
          ...CATS.map((c) => line(`  ${c}`, (a) => pp(a.cats[c]))),
          ...PHASES.map((p) => line(`  ${p === 'laning' ? 'laning (0-14m)' : p === 'mid' ? 'mid (14-25m)' : 'late (25m+)'}`, (a) => pp(a.phases[p]))),
          line('Deaths per game', (a) => a.deathsPerGame.toFixed(2)),
          line('Avg cost per death', (a) => pp(-a.costPerDeath)),
        ],
        new Set(cols.map((_, i) => i + 1)),
      ),
    );

    // Where his deaths cost the most, by context.
    const contexts = (rows: PlayerWpa[]) => {
      const m = new Map<string, { n: number; cost: number }>();
      for (const d of rows.flatMap((r) => r.deaths)) {
        for (const c of d.context.map((x) => x.replace(/\d+g /, '').replace(/ after$/, ''))) {
          const e = m.get(c) ?? { n: 0, cost: 0 };
          e.n++;
          e.cost += d.cost;
          m.set(c, e);
        }
      }
      return m;
    };
    const mc = contexts(mine);
    const pc = contexts(peers);
    console.log('\nDeaths by context (a death can have several):');
    console.log(
      renderTable(
        ['Context', 'His deaths/game', 'His avg cost', 'Peer deaths/game', 'Peer avg cost', 'His total cost/game'],
        [...mc.entries()]
          .sort((a, b) => b[1].cost - a[1].cost)
          .map(([k, v]) => {
            const p = pc.get(k) ?? { n: 0, cost: 0 };
            return [
              k,
              (v.n / mine.length).toFixed(2),
              pp(-v.cost / v.n),
              (p.n / Math.max(1, peers.length)).toFixed(2),
              p.n ? pp(-p.cost / p.n) : '-',
              pp(-v.cost / mine.length),
            ];
          }),
        new Set([1, 2, 3, 4, 5]),
      ),
    );

    const worst: (DeathRecord & { champ: string })[] = mine
      .flatMap((r) => r.deaths.map((d) => ({ ...d, champ: r.champion })))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 12);
    console.log('\nCostliest deaths (for VOD review):');
    console.log(
      renderTable(
        ['Match', 'Champion', 'Time', 'Win% before', 'Cost', 'Context'],
        worst.map((d) => [
          d.matchId,
          d.champ,
          `${Math.floor(d.t / 60_000)}:${String(Math.floor((d.t % 60_000) / 1000)).padStart(2, '0')}`,
          `${Math.round(d.wpBefore * 100)}%`,
          pp(-d.cost),
          d.context.join(', '),
        ]),
        new Set([3, 4]),
      ),
    );
  } finally {
    store.close();
  }
}
