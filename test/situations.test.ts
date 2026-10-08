import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSituations } from '../src/insights/situations';
import type { TimelineEvent } from '../src/riot/types';
import type { WinModel } from '../src/wp/model';
import { makeGame } from './fixtures';

const model: WinModel = { weights: [0, 0.6, -0.4, 0, 0.05, 0.2, 0.3, 0.7, 0.3, 0.2, 0.4], trainedOn: { matches: 0, rows: 0, at: '' } };

test('classifies solo-kill follow-ups and won-fight conversions', () => {
  const g = makeGame();
  g.timeline.info.frames[3]!.events.push(
    { type: 'CHAMPION_KILL', timestamp: 190_000, killerId: 1, victimId: 6, bounty: 300 } as TimelineEvent,
    { type: 'TURRET_PLATE_DESTROYED', timestamp: 230_000, teamId: 200, laneType: 'TOP_LANE', killerId: 1 } as TimelineEvent,
  );
  g.timeline.info.frames[11]!.events.push(
    { type: 'CHAMPION_KILL', timestamp: 660_000, killerId: 1, victimId: 6, bounty: 300 } as TimelineEvent,
    { type: 'ITEM_PURCHASED', timestamp: 700_000, participantId: 1, itemId: 1 } as TimelineEvent,
  );
  g.timeline.info.frames[20]!.events.push(
    { type: 'CHAMPION_KILL', timestamp: 1_200_000, killerId: 1, victimId: 7, bounty: 300 } as TimelineEvent,
    { type: 'CHAMPION_KILL', timestamp: 1_205_000, killerId: 2, victimId: 8, bounty: 300 } as TimelineEvent,
    { type: 'CHAMPION_KILL', timestamp: 1_210_000, killerId: 9, victimId: 3, bounty: 300 } as TimelineEvent,
    { type: 'BUILDING_KILL', timestamp: 1_260_000, killerId: 1, teamId: 200, buildingType: 'TOWER_BUILDING', laneType: 'MID_LANE' } as TimelineEvent,
  );
  const s = findSituations(g.match, g.timeline, 'p1', model);
  const solo = s.filter((x) => x.kind === 'solo-kill-in-lane').map((x) => x.response);
  assert.deepEqual(solo, ['takes plate/tower within 90s', 'recalls within 90s']);
  assert.deepEqual(s.filter((x) => x.kind === 'team-won-fight').map((x) => x.response), ['converts: he takes tower/objective']);
  assert.deepEqual(s.filter((x) => x.kind === 'joined-teamfight').map((x) => x.response), ['survives']);
  assert.ok(s.every((x) => Number.isFinite(x.dWp)));
});
