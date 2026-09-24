import assert from 'node:assert/strict';
import test from 'node:test';
import { makeModule } from './edit-chain.ts';
import { moduleFrequencyResponseDb } from './frequency-response.ts';

const response = (module, hz) => moduleFrequencyResponseDb(module, 48000, hz);

test('high-pass curve follows cutoff and Q settings', () => {
  const filter = makeModule('wind', { params: { cutoff: 100, q: 0.7 } });
  assert.ok(response(filter, 25) < -20);
  assert.ok(Math.abs(response(filter, 100) + 3) < 0.5);
  assert.ok(Math.abs(response(filter, 10000)) < 0.1);
  filter.params.cutoff = 200;
  assert.ok(response(filter, 100) < -10);
});

test('low shelf curve follows gain and frequency', () => {
  const shelf = makeModule('eq', { params: { mode: 'low-shelf', frequency: 100, q: 0.7, gain: 6 } });
  assert.ok(Math.abs(response(shelf, 20) - 6) < 0.6);
  assert.ok(Math.abs(response(shelf, 10000)) < 0.2);
  shelf.params.gain = -6;
  assert.ok(response(shelf, 20) < -5);
});

test('three-band response follows the actual shared upper band', () => {
  const eq = makeModule('eq', { params: { mode: 'three-band', low: 0, mid: 0, high: 0 } });
  assert.ok(Math.abs(response(eq, 1000)) < 0.01);
  eq.params.low = 6;
  assert.ok(response(eq, 20) > response(eq, 10000));
  eq.params.low = 0;
  eq.params.high = 6;
  assert.ok(response(eq, 10000) > 0);
  eq.params.mid = -12;
  assert.ok(response(eq, 10000) < 0);
});