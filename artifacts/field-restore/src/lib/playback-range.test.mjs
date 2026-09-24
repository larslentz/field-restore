import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackRangePlan } from './playback-range.ts';

const base = {
  duration: 10,
  sampleRate: 1000,
  startPosition: 6,
  totalFrames: 10000,
};

test('one-shot selection stops at the right boundary', () => {
  const plan = createPlaybackRangePlan({ ...base, loop: false, selection: [2, 4] });
  assert.equal(plan.hasSelection, true);
  assert.equal(plan.bufferStartFrame, 2000);
  assert.equal(plan.bufferEndFrame, 4000);
  assert.equal(plan.bufferStartOffset, 0);
  assert.equal(plan.timelineStart, 2);
  assert.equal(plan.timelineEnd, 4);
});

test('looped selection repeats only the selected buffer', () => {
  const plan = createPlaybackRangePlan({ ...base, loop: true, selection: [2, 4] });
  assert.equal(plan.bufferLoopStart, 0);
  assert.equal(plan.bufferLoopEnd, 2);
  assert.equal(plan.timelineStart, 2);
  assert.equal(plan.timelineEnd, 4);
});

test('right-to-left selection normalizes to the same boundaries', () => {
  const forward = createPlaybackRangePlan({ ...base, loop: false, selection: [2, 4] });
  const reversed = createPlaybackRangePlan({ ...base, loop: false, selection: [4, 2] });
  assert.deepEqual(reversed, forward);
});

test('sub-sample boundaries include every selected sample without exceeding the enclosing frames', () => {
  const plan = createPlaybackRangePlan({ ...base, loop: false, selection: [2.0004, 3.9994] });
  assert.equal(plan.bufferStartFrame, 2000);
  assert.equal(plan.bufferEndFrame, 4000);
  assert.equal(plan.timelineStart, 2);
  assert.equal(plan.timelineEnd, 4);
});

test('a click without a range seeks into the full recording', () => {
  const plan = createPlaybackRangePlan({ ...base, loop: false, selection: [6, 6] });
  assert.equal(plan.hasSelection, false);
  assert.equal(plan.bufferStartFrame, 0);
  assert.equal(plan.bufferEndFrame, 10000);
  assert.equal(plan.bufferStartOffset, 6);
  assert.equal(plan.timelineStart, 6);
  assert.equal(plan.timelineStartFrame, 6000);
  assert.equal(plan.timelineEnd, 10);
});

test('a full-file loop preserves its nonzero seek frame as the loop boundary', () => {
  const plan = createPlaybackRangePlan({ ...base, loop: true, selection: [6, 6], startPosition: 8.5 });
  assert.equal(plan.hasSelection, false);
  assert.equal(plan.timelineStart, 8.5);
  assert.equal(plan.timelineStartFrame, 8500);
});

test('current and original monitor sources receive identical timeline boundaries', () => {
  const current = createPlaybackRangePlan({ ...base, loop: true, selection: [1.25, 2.75] });
  const original = createPlaybackRangePlan({ ...base, loop: true, selection: [1.25, 2.75] });
  assert.deepEqual(current, original);
});

test('edited trim clips full-track playback and offsets the buffer without changing original playback', () => {
  const edited = createPlaybackRangePlan({ ...base, loop: true, selection: [0, 0], trim: [2, 8], startPosition: 6 });
  const original = createPlaybackRangePlan({ ...base, loop: true, selection: [0, 0], startPosition: 6 });
  assert.equal(edited.bufferStartFrame, 2000);
  assert.equal(edited.bufferEndFrame, 8000);
  assert.equal(edited.bufferStartOffset, 4);
  assert.equal(edited.bufferLoopStart, 4);
  assert.equal(edited.bufferLoopEnd, 6);
  assert.equal(edited.timelineEnd, 8);
  assert.equal(original.bufferStartFrame, 0);
  assert.equal(original.bufferEndFrame, 10000);
});

test('edited selection intersects trim and an outside selection is marked unplayable', () => {
  const partial = createPlaybackRangePlan({ ...base, loop: false, selection: [1, 4], trim: [2, 8] });
  assert.equal(partial.bufferStartFrame, 2000);
  assert.equal(partial.bufferEndFrame, 4000);
  assert.equal(partial.hasSelection, true);
  const outside = createPlaybackRangePlan({ ...base, loop: false, selection: [0, 1], trim: [2, 8], startPosition: 0 });
  assert.equal(outside.hasSelection, false);
  assert.equal(outside.emptySelection, true);
});