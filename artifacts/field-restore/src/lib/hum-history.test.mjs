import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_HUM_HISTORY_SEGMENTS, recordHumHistory, visibleHumHistory } from './hum-history.ts';

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

test('spectrogram projection clips retained visits but never fills gaps or scans the file', () => {
  const history = [
    { moduleId: 'hum-a', startFrame: 100, endFrame: 150, frequencies: [60] },
    { moduleId: 'hum-b', startFrame: 200, endFrame: 200, frequencies: [] },
    { moduleId: 'hum-a', startFrame: 800, endFrame: 900, frequencies: [50] },
  ];
  const visible = visibleHumHistory(history, 100, 1.2, 1);
  assert.deepEqual(visible.map(({ segment, seekFrame }) => ({ segment, seekFrame })), [
    { segment: history[0], seekFrame: 120 },
    { segment: history[1], seekFrame: 200 },
  ]);
  assert.equal(visible[0].left, 0);
  assert.ok(Math.abs(visible[0].right - .3) < 1e-10);
  assert.ok(Math.abs(visible[1].left - .8) < 1e-10);
  assert.equal(visible[1].left, visible[1].right);
  assert.deepEqual(visibleHumHistory(history, 100, 3, 1), []);
  assert.deepEqual(visibleHumHistory(history, 0, 0, 1), []);
});

test('replaying a hum dot does not draw copies over the same heard positions', () => {
  const history = [
    { moduleId: 'hum', startFrame: 100, endFrame: 200, frequencies: [60] },
    { moduleId: 'hum', startFrame: 150, endFrame: 230, frequencies: [60] },
    { moduleId: 'hum', startFrame: 225, endFrame: 250, frequencies: [60] },
    { moduleId: 'hum', startFrame: 300, endFrame: 320, frequencies: [60] },
    { moduleId: 'hum', startFrame: 160, endFrame: 180, frequencies: [] },
    { moduleId: 'other-hum', startFrame: 160, endFrame: 180, frequencies: [60] },
  ];
  const visible = visibleHumHistory(history, 100, 0, 4);
  assert.deepEqual(visible.map(({ segment, seekFrame, right }) =>
    ({ moduleId: segment.moduleId, frequencies: segment.frequencies, seekFrame, endFrame: right * 400 })), [
    { moduleId: 'hum', frequencies: [60], seekFrame: 100, endFrame: 250 },
    { moduleId: 'hum', frequencies: [], seekFrame: 160, endFrame: 180 },
    { moduleId: 'other-hum', frequencies: [60], seekFrame: 160, endFrame: 180 },
    { moduleId: 'hum', frequencies: [60], seekFrame: 300, endFrame: 320 },
  ]);
});

test('spectrogram projection remains bounded even when given an oversized history', () => {
  const history = Array.from({ length: MAX_HUM_HISTORY_SEGMENTS + 5 }, (_, frame) =>
    ({ moduleId: 'hum', startFrame: frame, endFrame: frame, frequencies: [] }));
  const visible = visibleHumHistory(history, 100, 0, 2);
  assert.equal(visible.length, MAX_HUM_HISTORY_SEGMENTS);
  assert.equal(visible[0].seekFrame, 5);
});