import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeGameFeatures } from '../src/insights/features';
import type { TimelineEvent } from '../src/riot/types';
import { makeGame } from './fixtures';

function withEvents(extra: Record<number, TimelineEvent[]>) {
  const g = makeGame();
  for (const [minute, events] of Object.entries(extra)) g.timeline.info.frames[Number(minute)]!.events.push(...events);
  return g;
}

const kill = (t: number, killerId: number, victimId: number, assists: number[] = [], pos = { x: 7000, y: 7000 }) =>
  ({ type: 'CHAMPION_KILL', timestamp: t, killerId, victimId, assistingParticipantIds: assists, position: pos }) as TimelineEvent;

test('laning features: deaths, ganks, plates, first tower', () => {
  const g = withEvents({
    3: [kill(190_000, 1, 6)], // solo kill on lane opp
    9: [
      kill(545_000, 7, 1, [6]), // ganked by enemy jungler (p7)
      { type: 'TURRET_PLATE_DESTROYED', timestamp: 550_000, teamId: 200, laneType: 'TOP_LANE', killerId: 1 } as TimelineEvent,
    ],
    12: [{ type: 'BUILDING_KILL', timestamp: 730_000, killerId: 1, teamId: 200, buildingType: 'TOWER_BUILDING', laneType: 'TOP_LANE', towerType: 'OUTER_TURRET' } as TimelineEvent],
  });
  const f = computeGameFeatures(g.match, g.timeline, 'p1')!;
  assert.equal(f.gd14, 700);
  assert.equal(f.soloKillsEarly, 1);
  assert.equal(f.laneTakedownsOnOpp, 1);
  // fixture already has a solo death to p6 at 5:00 and a death to p7 (assist p6) at 8:00
  assert.equal(f.earlyDeaths, 3);
  assert.equal(f.gankDeaths, 2);
  assert.equal(f.soloDeathsToOpp, 1);
  assert.equal(f.platesTaken, 1);
  assert.equal(f.firstLaneTower, 'ours');
});

test('teamfight clustering, presence, and first ally death', () => {
  const g = withEvents({
    // Fight 1 (20:00): p1 dies first, blue still wins 2-1.
    20: [kill(1_200_000, 6, 1), kill(1_205_000, 2, 6, [3]), kill(1_212_000, 3, 7, [2])],
    // Fight 2 (25:00): p1 not involved, red wins 3-0.
    25: [kill(1_500_000, 6, 2), kill(1_510_000, 7, 3), kill(1_520_000, 8, 4)],
    // Pick (27:00): 2 deaths only, not a teamfight.
    27: [kill(1_620_000, 1, 9), kill(1_625_000, 1, 10)],
  });
  const f = computeGameFeatures(g.match, g.timeline, 'p1')!;
  assert.equal(f.fights, 2);
  assert.equal(f.fightsPresent, 1);
  assert.equal(f.fightsWonPresent, 1);
  assert.equal(f.fightsLostAbsent, 1);
  assert.equal(f.firstAllyDeaths, 1);
  assert.equal(f.fightDeaths, 1);
  assert.equal(f.midDeaths, 1);
});

test('enemy objective classification: dead vs traded', () => {
  const g = withEvents({
    // Already: p1 dies at 5:00, red dragon at 5:30 -> dead for it.
    22: [
      { type: 'ELITE_MONSTER_KILL', timestamp: 1_320_000, killerId: 7, killerTeamId: 200, monsterType: 'BARON_NASHOR', position: { x: 5000, y: 10400 } } as TimelineEvent,
      { type: 'BUILDING_KILL', timestamp: 1_330_000, killerId: 1, teamId: 200, buildingType: 'TOWER_BUILDING', laneType: 'BOT_LANE', towerType: 'INNER_TURRET' } as TimelineEvent,
    ],
  });
  // Put p1 far away (bot side) at the 22:00 frame.
  g.timeline.info.frames[22]!.participantFrames['1']!.position = { x: 13000, y: 2000 };
  const f = computeGameFeatures(g.match, g.timeline, 'p1')!;
  assert.equal(f.enemyObjectives, 2);
  assert.equal(f.enemyObjDead, 1);
  assert.equal(f.enemyObjFarTraded, 1);
  assert.equal(f.towersAfterLane, 1);
});
