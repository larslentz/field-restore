import assert from 'node:assert/strict';
import test from 'node:test';
import {
  makeBringBackLowEnd,
  makeDefaultChain,
  makeLowRumbleRemoval,
  makeProcessingChain,
  makeRestorationReport,
  renderChain,
  toggleEditableModules,
  withoutLegacyDcModules,
} from './edit-chain.ts';

const legacyDc = { id: 'legacy-dc', type: 'dc', name: 'DC Offset', enabled: true, params: { mode: 'Auto', amount: 0 } };
const gain = { id: 'gain', type: 'gain', name: 'Gain', enabled: true, params: { db: 0 } };

test('editable presets never expose DC removal', () => {
  assert.equal(makeDefaultChain().some((module) => module.type === 'dc'), false);
});

test('chain check mark toggles all editable modules while retaining their settings', () => {
  const disabled = { ...gain, id: 'gain-2', enabled: false, params: { db: 3 } };
  const mixed = [gain, disabled];
  const allOn = toggleEditableModules(mixed);
  assert.deepEqual(allOn.map((module) => module.enabled), [true, true]);
  assert.deepEqual(allOn.map((module) => module.params), mixed.map((module) => module.params));
  assert.deepEqual(toggleEditableModules(allOn).map((module) => module.enabled), [false, false]);
  assert.deepEqual(toggleEditableModules([disabled]).map((module) => module.enabled), [true]);
  assert.deepEqual(toggleEditableModules([]), []);
  assert.equal(makeProcessingChain(toggleEditableModules(allOn))[0].enabled, true);
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
  assert.equal(addedModule.params.gain, 2);
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
  const input = [Float32Array.from({ length: 48000 }, () => 0.25)];
  const output = renderChain(input, makeProcessingChain([]), 48000);
  const tailMean = output[0].slice(-512).reduce((sum, value) => sum + value, 0) / 512;
  assert.ok(Math.abs(tailMean) < 0.001, `expected DC-corrected tail, received ${tailMean}`);
  assert.ok(Math.abs(output[0][0] - input[0][0]) < 1e-7, 'the filter must not invent a startup step');
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
  assert.match(report.limitations[1], /Previously saved projects may sound different.*original recordings remain untouched/);
});