import assert from 'node:assert/strict';
import test from 'node:test';
import { makeLowRumbleRemoval, makeModule } from './edit-chain.ts';
import { moduleFrequencyResponseDb } from './frequency-response.ts';

const response = (module, hz) => moduleFrequencyResponseDb(module, 48000, hz);

test('high-pass curve follows cutoff and Q settings', () => {
  const filter = makeLowRumbleRemoval();
  filter.params.lowEndEnabled = 0;
  filter.params.cutoff = 100;
  filter.params.q = .7;
  assert.ok(response(filter, 25) < -20);
  assert.ok(Math.abs(response(filter, 100) + 3) < 0.5);
  assert.ok(Math.abs(response(filter, 10000)) < 0.1);
  filter.params.cutoff = 200;
  assert.ok(response(filter, 100) < -10);
});

test('automatic wind reduction does not claim a static frequency response', () => {
  const wind = makeModule('wind');
  assert.equal(response(wind, 25), 0);
  wind.params.lowEndEnabled = 1;
  assert.ok(response(wind, 25) > 1);
  wind.params.lowEndGain = -6;
  assert.ok(response(wind, 25) < -4);
});

test('low-rumble curve includes the enabled low-end shelf and excludes it when off', () => {
  const filter = makeLowRumbleRemoval();
  const boosted = response(filter, 25);
  filter.params.lowEndEnabled = 0;
  assert.ok(boosted > response(filter, 25) + 1);
  filter.params.lowEndEnabled = 1;
  filter.params.lowEndGain = 6;
  assert.ok(response(filter, 25) > boosted + 2.7);
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