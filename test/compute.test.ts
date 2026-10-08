import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMatchMetrics, isDeepInEnemyHalf } from '../src/metrics/compute';
import { betterThan, median } from '../src/metrics/stats';
import { makeGame } from './fixtures';

test('computes lane, economy, and death metrics for a participant', () => {
  const { match, timeline } = makeGame();
  const rows = computeMatchMetrics(match, timeline);
  assert.equal(rows.length, 10);

  const p1 = rows.find((r) => r.puuid === 'p1')!;
  const m = p1.metrics;
  assert.equal(m.csAt10, 80);
  assert.equal(m.csDiffAt10, 20);
  assert.equal(m.goldDiffAt10, 500);
  assert.equal(m.xpDiffAt10, 500);
  assert.equal(m.goldDiffAt15, 750);
  assert.equal(m.csPerMin, 7);
  assert.equal(m.kda, 2.5);
  assert.equal(m.killParticipation, 5 / 11);
  assert.equal(m.damageShare, 20_000 / 60_000);
  assert.equal(m.visionPerMin, 1);
  assert.equal(m.deaths, 2);
  assert.equal(m.soloDeaths, 1);
  assert.equal(m.deathsBeforeEnemyObjective, 1);
  assert.equal(m.deathsInEnemyHalf, 1);
  assert.ok(Math.abs(m.firstBackMin! - 400 / 60) < 1e-9);

  // Lane opponent sees the mirrored diff.
  const p6 = rows.find((r) => r.puuid === 'p6')!;
  assert.equal(p6.metrics.csDiffAt10, -20);
});

test('skips remakes and nulls timeline metrics the game never reached', () => {
  const remake = makeGame({ durationSec: 200 });
  assert.deepEqual(computeMatchMetrics(remake.match, remake.timeline), []);

  const { match, timeline } = makeGame({ durationSec: 13 * 60 });
  const p1 = computeMatchMetrics(match, timeline).find((r) => r.puuid === 'p1')!;
  assert.equal(p1.metrics.csDiffAt10, 20);
  assert.equal(p1.metrics.goldDiffAt15, null);
});

test('enemy-half detection is mirrored per team', () => {
  assert.equal(isDeepInEnemyHalf(100, { x: 12_000, y: 12_000 }), true);
  assert.equal(isDeepInEnemyHalf(200, { x: 12_000, y: 12_000 }), false);
  assert.equal(isDeepInEnemyHalf(200, { x: 2_000, y: 2_000 }), true);
  assert.equal(isDeepInEnemyHalf(100, { x: 7_400, y: 7_400 }), false); // mid river
});

test('betterThan respects metric direction and ties', () => {
  assert.equal(betterThan(5, [1, 2, 5, 8], 'higher'), 2.5 / 4);
  assert.equal(betterThan(5, [1, 2, 5, 8], 'lower'), 1.5 / 4);
  assert.equal(betterThan(5, [1, 2], 'neutral'), null);
  assert.equal(median([3, 1, 2, 10]), 2.5);
});
