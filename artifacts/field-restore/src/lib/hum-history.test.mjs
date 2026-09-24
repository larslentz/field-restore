import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_HUM_HISTORY_SEGMENTS, recordHumHistory } from './hum-history.ts';

test('records heard changes, no-filter decisions, and leaves skipped positions uncovered', () => {
  let history = [];
  const add = (frame, frequencies) => { history = recordHumHistory(history, 'hum', frame, frequencies, 1000); };
  add(1000, []);
  add(1200, []);
  add(1300, [60]);
  add(1500, [60]);
  add(5000, [50]);
  add(5100, []);
  assert.deepEqual(history, [
    { moduleId: 'hum', startFrame: 1000, endFrame: 1300, frequencies: [] },
    { moduleId: 'hum', startFrame: 1300, endFrame: 1500, frequencies: [60] },
    { moduleId: 'hum', startFrame: 5000, endFrame: 5100, frequencies: [50] },
    { moduleId: 'hum', startFrame: 5100, endFrame: 5100, frequencies: [] },
  ]);
});

test('loop and backward seeks create distinct visits; storage remains bounded', () => {
  let history = [];
  for (let i = 0; i < MAX_HUM_HISTORY_SEGMENTS + 15; i++)
    history = recordHumHistory(history, 'hum', i % 2 ? 100 : 200, [i], 1000);
  assert.equal(history.length, MAX_HUM_HISTORY_SEGMENTS);
  assert.equal(history[0].frequencies[0], 15);
  assert.equal(history.at(-1).frequencies[0], MAX_HUM_HISTORY_SEGMENTS + 14);
});