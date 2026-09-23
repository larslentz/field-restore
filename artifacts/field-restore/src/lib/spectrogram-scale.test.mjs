import assert from 'node:assert/strict';
import test from 'node:test';
import { anchoredLevelScaleCeiling } from './spectrogram-scale.ts';

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