import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db';
import { computeMatchMetrics } from '../src/metrics/compute';
import { apexLpScore, formatRank, rankScore } from '../src/rank';
import { mainRole, summarize } from '../src/report';
import { makeGame } from './fixtures';

function seeded(): Store {
  const store = new Store(':memory:');
  for (let i = 1; i <= 3; i++) {
    const { match, timeline } = makeGame({ matchId: `NA1_${i}` });
    store.saveMatch(match, timeline, computeMatchMetrics(match, timeline));
  }
  return store;
}

test('stores matches and benchmarks a player against role peers', () => {
  const store = seeded();
  assert.equal(store.hasMatch('NA1_1'), true);
  assert.equal(store.hasMatch('NA1_9'), false);
  assert.deepEqual(store.counts(), { matches: 3, playerGames: 30, players: 10 });

  const games = store.playerGames('p1', 20);
  assert.equal(games.length, 3);
  assert.equal(mainRole(games), 'TOP');

  // Only peer in TOP is p6 (3 games) -> falls back to per-game values.
  const filter = { role: 'TOP', excludePuuid: 'p1' };
  assert.deepEqual(store.perGameValues('csDiffAt10', filter), [-20, -20, -20]);
  const cs = summarize(store, games, filter).find((s) => s.def.key === 'csDiffAt10')!;
  assert.equal(cs.yours, 20);
  assert.equal(cs.betterThan, 1);
  assert.equal(cs.basis, 'games');

  assert.ok(store.uncrawledPuuids(100).includes('p1'));
  store.markCrawled('p1');
  assert.ok(!store.uncrawledPuuids(100).includes('p1'));
  store.close();
});

test('peer filters by rank, champion, and queue', () => {
  const store = seeded();
  store.upsertRanks('na1', [
    { puuid: 'p6', tier: 'MASTER', division: 'I', lp: 900 },
    { puuid: 'p7', tier: 'MASTER', division: 'I', lp: 100 },
  ]);
  const top = { role: 'TOP', excludePuuid: 'p1' };
  assert.equal(store.perGameValues('csAt10', { ...top, minRankScore: apexLpScore(600) }).length, 3);
  assert.equal(store.perGameValues('csAt10', { ...top, minRankScore: apexLpScore(950) }).length, 0);
  assert.equal(store.perGameValues('csAt10', { ...top, champions: ['Champ6'] }).length, 3);
  assert.equal(store.perGameValues('csAt10', { ...top, champions: ['Riven'] }).length, 0);
  assert.equal(store.perGameValues('csAt10', { ...top, queueId: 420 }).length, 3);
  assert.equal(store.perGameValues('csAt10', { ...top, queueId: 440 }).length, 0);
  assert.deepEqual(store.peerCounts(top), { games: 3, players: 1 });

  // Ladder crawl candidates: only p6 clears 600 LP; seen-on-champion players come first.
  assert.deepEqual(store.uncrawledPuuids(10, { minRankScore: apexLpScore(600) }), ['p6']);
  assert.equal(store.uncrawledPuuids(1, { preferChampions: ['Champ3'] })[0], 'p3');
  store.close();
});

test('rank scores order tiers and the shared apex ladder', () => {
  assert.ok(rankScore({ tier: 'DIAMOND', division: 'I', lp: 99 }) < rankScore({ tier: 'MASTER', division: 'I', lp: 0 }));
  assert.ok(rankScore({ tier: 'EMERALD', division: 'IV', lp: 0 }) < rankScore({ tier: 'EMERALD', division: 'III', lp: 0 }));
  assert.equal(rankScore({ tier: 'GRANDMASTER', division: 'I', lp: 1000 }), apexLpScore(1000));
  assert.equal(formatRank({ tier: 'MASTER', division: 'I', lp: 852 }), 'Master 852 LP');
  assert.equal(formatRank({ tier: 'GOLD', division: 'II', lp: 40 }), 'Gold II 40 LP');
});

test('playerGames filters by season start and parseSince accepts seasons or dates', async () => {
  const { parseSince } = await import('../src/season');
  const store = seeded();
  const end = 1_700_000_000_000 + 1800 * 1000;
  assert.equal(store.playerGames('p1', 100, { sinceMs: end }).length, 3);
  assert.equal(store.playerGames('p1', 100, { sinceMs: end + 1 }).length, 0);
  assert.equal(parseSince('2026'), Date.parse('2026-01-08T20:00:00Z'));
  assert.equal(parseSince('2026-05-01'), Date.parse('2026-05-01'));
  assert.throws(() => parseSince('soon'));
  store.close();
});
