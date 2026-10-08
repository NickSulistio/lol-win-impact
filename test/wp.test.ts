import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimelineEvent } from '../src/riot/types';
import type { WinModel } from '../src/wp/model';
import { GameTimeline } from '../src/wp/state';
import { computeWpa } from '../src/wp/wpa';
import { makeGame } from './fixtures';

// Hand-set model: only gold and dead players matter.
const model: WinModel = { weights: [0, 0.6, -0.4, 0, 0.05, 0.2, 0.3, 0.7, 0.3, 0.2, 0.4], trainedOn: { matches: 0, rows: 0, at: '' } };

test('state jumps by the kill bounty and tracks dead players and buildings', () => {
  const g = makeGame();
  g.timeline.info.frames[20]!.events.push(
    { type: 'CHAMPION_KILL', timestamp: 1_210_000, killerId: 6, victimId: 2, bounty: 300, shutdownBounty: 200 } as TimelineEvent,
    { type: 'BUILDING_KILL', timestamp: 1_220_000, killerId: 7, teamId: 100, buildingType: 'TOWER_BUILDING' } as TimelineEvent,
  );
  const gt = new GameTimeline(g.match, g.timeline);
  const before = gt.stateAt(1_210_000, false);
  const after = gt.stateAt(1_210_000, true);
  assert.equal(Math.round(before.goldDiff - after.goldDiff), 500); // red got 300 + 200 shutdown
  assert.equal(after.deadDiff - before.deadDiff, -1); // a blue player is now dead
  assert.equal(gt.stateAt(1_230_000).towerDiff, -1); // red destroyed a blue tower
  assert.equal(gt.stateAt(1_500_000).deadDiff, 0); // respawned
});

test('kill credit: killer and assists share the gain, victim takes the loss', () => {
  const g = makeGame();
  g.timeline.info.frames[20]!.events.push({
    type: 'CHAMPION_KILL', timestamp: 1_210_000, killerId: 1, victimId: 6, assistingParticipantIds: [2, 3], bounty: 300,
  } as TimelineEvent);
  const players = computeWpa(g.match, g.timeline, model);
  const p = (id: number) => players.find((x) => x.participantId === id)!;
  const gain = p(1).byCategory.kills * 2;
  assert.ok(gain > 0);
  assert.ok(Math.abs(p(2).byCategory.kills - gain / 4) < 1e-12);
  assert.ok(Math.abs(p(6).byCategory.deaths + gain) < 1e-12);
  assert.ok(p(6).deaths.some((d) => d.t === 1_210_000 && Math.abs(d.cost - gain) < 1e-12));
  // Economy is zero-sum per lane: p1 out-farms p6 every minute in the fixture.
  assert.ok(p(1).byCategory.economy > 0);
  assert.ok(Math.abs(p(1).byCategory.economy + p(6).byCategory.economy) < 1e-12);
});
