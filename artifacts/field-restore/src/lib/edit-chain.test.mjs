import assert from 'node:assert/strict';
import test from 'node:test';
import {
  makeDefaultChain,
  makeCommonFieldChain,
  makeLowRumbleRemoval,
  makeModule,
  makeProcessingChain,
  makeRestorationReport,
  renderChain,
  restoreSavedChain,
  toggleEditableModules,
  withoutLegacyDcModules,
} from './edit-chain.ts';

const legacyDc = { id: 'legacy-dc', type: 'dc', name: 'DC Offset', enabled: true, params: { mode: 'Auto', amount: 0 } };
const gain = { id: 'gain', type: 'gain', name: 'Gain', enabled: true, params: { db: 0 } };

test('editable presets never expose DC removal', () => {
  assert.equal(makeDefaultChain().some((module) => module.type === 'dc'), false);
});

test('default and common-field chains bypass optional Hum and Wind cleanup', () => {
  const defaults = makeDefaultChain();
  const commonField = makeCommonFieldChain();

  for (const chain of [defaults, commonField]) {
    for (const name of ['Hum Removal', 'Wind Removal']) {
      assert.equal(chain.find((module) => module.name === name)?.enabled, false, `${name} should start bypassed`);
    }
    assert.equal(chain.find((module) => module.name === 'Low Rumble Removal')?.enabled, true);
  }
});

test('reopening an empty saved chain uses Common Field without changing nonempty choices', () => {
  for (const stored of [[], [legacyDc]]) {
    const restored = restoreSavedChain(stored);
    assert.deepEqual(restored.map((module) => module.name), makeCommonFieldChain().map((module) => module.name));
    assert.equal(restored.find((module) => module.name === 'Hum Removal')?.enabled, false);
    assert.equal(restored.find((module) => module.name === 'Wind Removal')?.enabled, false);
    assert.equal(restored.find((module) => module.name === 'Low Rumble Removal')?.enabled, true);
  }
  const stored = [
    { ...makeModule('wind'), enabled: false },
    { ...makeModule('hum'), enabled: false, params: { mode: 'Static', frequency: 50, reduction: 4 } },
  ];
  assert.deepEqual(restoreSavedChain(stored), stored);
  assert.deepEqual(restoreSavedChain([legacyDc, ...stored]), stored);
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
  assert.deepEqual(addedModule.params, { mode: 'Fixed low rumble', cutoff: 55.5, q: 0.38, lowEndEnabled: 1, lowEndFrequency: 55, lowEndQ: .4, lowEndGain: 2 });
  assert.deepEqual(addedModule.params, presetModule.params);
  assert.notEqual(addedModule.id, presetModule.id);
});

test('wind and low rumble have separate low-end settings without a standalone edit', () => {
  const defaults = makeDefaultChain();
  assert.equal(defaults.some((module) => module.name === 'Bring Back the Low End'), false);
  const wind = defaults.find((module) => module.name === 'Wind Removal');
  const lowRumble = defaults.find((module) => module.name === 'Low Rumble Removal');
  assert.equal(wind.params.lowEndEnabled, 0);
  assert.equal(wind.params.lowEndScope, 'Whole recording');
  assert.equal(lowRumble.params.lowEndEnabled, 1);
  assert.deepEqual(
    ['lowEndFrequency', 'lowEndQ', 'lowEndGain'].map((key) => wind.params[key]),
    [55, .4, 2],
  );
  assert.deepEqual(
    ['lowEndFrequency', 'lowEndQ', 'lowEndGain'].map((key) => lowRumble.params[key]),
    [55, .4, 2],
  );
  assert.notEqual(wind.params, lowRumble.params);
});

test('default chain and add menu create one fade with independent sides', () => {
  const defaults = makeDefaultChain().filter((module) => module.type === 'fade');
  assert.deepEqual(defaults.map((module) => module.name), ['Fade In/Out']);
  assert.deepEqual(defaults[0].params, { in: 7, out: 7, inEnabled: 1, outEnabled: 1 });
  const added = makeModule('fade');
  assert.deepEqual(added.params, defaults[0].params);
  assert.notEqual(added.id, defaults[0].id);
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