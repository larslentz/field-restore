import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_WIND_HISTORY_SEGMENTS, recordWindHistory, windActivityAt, windActivityAtSorted } from './wind-history.ts';

test('wind activity stays unknown until a confirmed detector event', () => {
  const events = [
    { moduleId: 'wind', frame: 100, active: false },
    { moduleId: 'wind', frame: 500, active: true },
    { moduleId: 'other', frame: 700, active: true },
    { moduleId: 'wind', frame: 900, active: false },
  ];

  assert.equal(windActivityAt(events, 'wind', 99), null);
  assert.equal(windActivityAt(events, 'wind', 100), false);
  assert.equal(windActivityAt(events, 'wind', 750), true);
  assert.equal(windActivityAt(events, 'wind', 900), false);
  assert.equal(windActivityAt(events, 'missing', 1000), null);
  assert.equal(windActivityAtSorted(events, 'wind', 750), true);
});

test('a repeated loop visit takes priority over earlier events from later source times', () => {
  const events = [
    { moduleId: 'wind', frame: 100, active: false },
    { moduleId: 'wind', frame: 900, active: true },
    { moduleId: 'wind', frame: 100, active: true },
  ];
  assert.equal(windActivityAt(events, 'wind', 150), true);
});

test('records active and idle heard spans without filling seek gaps', () => {
  let history = [];
  const add = (frame, active) => { history = recordWindHistory(history, 'wind', frame, active, 1000); };
  add(1000, false);
  add(1200, false);
  add(1300, true);
  add(1500, true);
  add(5000, true);
  add(5100, false);

  assert.deepEqual(history, [
    { moduleId: 'wind', startFrame: 1000, endFrame: 1300, active: false },
    { moduleId: 'wind', startFrame: 1300, endFrame: 1500, active: true },
    { moduleId: 'wind', startFrame: 5000, endFrame: 5100, active: true },
    { moduleId: 'wind', startFrame: 5100, endFrame: 5100, active: false },
  ]);
});

test('backward seeks create separate visits and history remains bounded', () => {
  let history = [];
  for (let index = 0; index < MAX_WIND_HISTORY_SEGMENTS + 15; index++) {
    history = recordWindHistory(history, 'wind', index % 2 ? 100 : 200, !!(index % 2), 1000);
  }

  assert.equal(history.length, MAX_WIND_HISTORY_SEGMENTS);
  assert.equal(history[0].active, true);
  assert.equal(history.at(-1).active, false);
});

test('a restarted playback visit keeps even a short seek gap unconfirmed', () => {
  let history = recordWindHistory([], 'wind', 1000, true, 1000);
  history = recordWindHistory(history, 'wind', 1200, true, 1000, true);
  assert.deepEqual(history, [
    { moduleId: 'wind', startFrame: 1000, endFrame: 1000, active: true },
    { moduleId: 'wind', startFrame: 1200, endFrame: 1200, active: true },
  ]);
});

test('invalid frame and sample-rate inputs leave history unchanged', () => {
  const history = [{ moduleId: 'wind', startFrame: 10, endFrame: 20, active: true }];
  assert.equal(recordWindHistory(history, 'wind', Number.NaN, false, 1000), history);
  assert.equal(recordWindHistory(history, 'wind', 30, false, 0), history);
});