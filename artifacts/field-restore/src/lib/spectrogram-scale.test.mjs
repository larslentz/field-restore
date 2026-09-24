import assert from 'node:assert/strict';
import test from 'node:test';
import { anchoredFrequencyViewMin, anchoredLevelScaleCeiling, anchoredTimeViewStart, frequencyScaleTicks, levelScaleTicks } from './spectrogram-scale.ts';

test('keeps the grabbed level under the pointer while preserving the span', () => {
  const span = 80;
  const ceiling = anchoredLevelScaleCeiling(-40, 75, 300, span, -180, 24);
  assert.equal(ceiling, -20);
  assert.equal(ceiling - span, -100);
  assert.equal(ceiling - (75 / 300) * span, -40);
});

test('stops a translated level scale at its supported bounds', () => {
  assert.equal(anchoredLevelScaleCeiling(20, 200, 200, 80, -180, 24), 24);
  assert.equal(anchoredLevelScaleCeiling(-175, 0, 200, 80, -180, 24), -100);
});

test('fixed dB labels move with the shared full-height level scale', () => {
  const before = levelScaleTicks(-20, 85, 452);
  const after = levelScaleTicks(-15, 85, 452);
  const original = before.find((tick) => tick.level === -25);
  const moved = after.find((tick) => tick.level === -25);
  assert.ok(original && moved);
  assert.ok(moved.y > original.y);
  assert.equal(moved.y - original.y, 5 / 85 * 452);
  assert.ok(after.every((tick) => tick.y >= 0 && tick.y <= 452));
});

test('frequency dragging keeps the grabbed value under the pointer and preserves the span', () => {
  const span = 4000;
  const minimum = anchoredFrequencyViewMin(3000, 85, 200, span, 24000);
  assert.equal(minimum, 700);
  assert.equal(minimum + (1 - 85 / 200) * span, 3000);
  assert.equal(minimum + span, 4700);
});

test('frequency panning stops at zero and Nyquist, including a full-band view', () => {
  assert.equal(anchoredFrequencyViewMin(3000, -200, 200, 4000, 8000), 0);
  assert.equal(anchoredFrequencyViewMin(3000, 400, 200, 4000, 8000), 4000);
  assert.equal(anchoredFrequencyViewMin(3000, 400, 200, 8000, 8000), 0);
});

test('fixed frequency labels travel with the spectrogram in both channel panes', () => {
  const before = frequencyScaleTicks(1000, 5000, 200);
  const after = frequencyScaleTicks(1500, 5500, 200);
  const original = before.find((tick) => tick.frequency === 3000);
  const moved = after.find((tick) => tick.frequency === 3000);
  assert.ok(original && moved);
  assert.equal(moved.y - original.y, 25);
  assert.ok(after.every((tick) => tick.y >= 0 && tick.y <= 200));
});

test('keeps the grabbed time under the pointer while preserving the visible span', () => {
  const viewStart = anchoredTimeViewStart(45, 300, 600, 20, 120);
  assert.equal(viewStart, 35);
  assert.equal(viewStart + (300 / 600) * 20, 45);
});

test('keeps pointer-anchored time zoom within the recording bounds', () => {
  assert.equal(anchoredTimeViewStart(2, 300, 600, 20, 120), 0);
  assert.equal(anchoredTimeViewStart(118, 300, 600, 20, 120), 100);
  assert.equal(anchoredTimeViewStart(60, 300, 600, 200, 120), 0);
});