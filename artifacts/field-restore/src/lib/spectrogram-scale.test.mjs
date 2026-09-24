import assert from 'node:assert/strict';
import test from 'node:test';
import { anchoredLevelScaleCeiling, anchoredTimeViewStart, levelScaleTicks } from './spectrogram-scale.ts';

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