import assert from 'node:assert/strict';
import test from 'node:test';
import {
  makeBringBackLowEnd,
  makeDefaultChain,
  makeLowRumbleRemoval,
  makeProcessingChain,
  makeRestorationReport,
  renderChain,
  withoutLegacyDcModules,
} from './edit-chain.ts';

const legacyDc = { id: 'legacy-dc', type: 'dc', name: 'DC Offset', enabled: true, params: { mode: 'Auto', amount: 0 } };
const gain = { id: 'gain', type: 'gain', name: 'Gain', enabled: true, params: { db: 0 } };

test('editable presets never expose DC removal', () => {
  assert.equal(makeDefaultChain().some((module) => module.type === 'dc'), false);
});

test('new low rumble removal matches the default preset with an independent ID', () => {
  const presetModule = makeDefaultChain().find((module) => module.name === 'Low Rumble Removal');
  const addedModule = makeLowRumbleRemoval();
  assert.ok(presetModule);
  assert.equal(addedModule.type, 'wind');
  assert.deepEqual(addedModule.params, { mode: 'Fixed low rumble', cutoff: 55.5, q: 0.38 });
  assert.deepEqual(addedModule.params, presetModule.params);
  assert.notEqual(addedModule.id, presetModule.id);
});

test('new bring back the low end matches the default low-shelf preset with an independent ID', () => {
  const presetModule = makeDefaultChain().find((module) => module.name === 'Bring Back the Low End');
  const addedModule = makeBringBackLowEnd();
  assert.ok(presetModule);
  assert.equal(addedModule.type, 'eq');
  assert.equal(addedModule.params.mode, 'low-shelf');
  assert.equal(addedModule.params.frequency, 55);
  assert.equal(addedModule.params.q, 0.4);
  assert.equal(addedModule.params.gain, 3);
  assert.deepEqual(addedModule.params, presetModule.params);
  assert.notEqual(addedModule.id, presetModule.id);
});

test('legacy DC modules are absorbed into exactly one automatic baseline stage', () => {
  const editable = withoutLegacyDcModules([legacyDc, gain, { ...legacyDc, id: 'legacy-dc-2' }]);
  assert.deepEqual(editable, [gain]);

  const processing = makeProcessingChain([legacyDc, gain, { ...legacyDc, id: 'legacy-dc-2' }]);
  assert.equal(processing[0].id, 'automatic-dc-removal');
  assert.equal(processing.filter((module) => module.type === 'dc').length, 1);
  assert.deepEqual(processing.slice(1), [gain]);
});

test('in-memory processing includes automatic DC correction', () => {
  const input = [Float32Array.from({ length: 4096 }, () => 0.25)];
  const output = renderChain(input, makeProcessingChain([]), 48000);
  const tailMean = output[0].slice(-512).reduce((sum, value) => sum + value, 0) / 512;
  assert.ok(Math.abs(tailMean) < 0.001, `expected DC-corrected tail, received ${tailMean}`);
});

test('restoration reports record automatic DC correction without editable DC modules', () => {
  const report = makeRestorationReport({
    source: 'field.wav',
    sampleRate: 48000,
    channels: 2,
    duration: 1,
    container: 'RIFF',
    modules: [legacyDc, gain],
    selection: [0, 1],
    exportedAt: '2026-09-23T00:00:00.000Z',
  });

  assert.equal(report.automaticDcOffsetRemoval, true);
  assert.equal(report.modules.some((module) => module.type === 'dc'), false);
  assert.match(report.limitations[0], /Automatic DC offset removal/);
});