import assert from 'node:assert/strict';
import test from 'node:test';
import { isFixedLowRumble, isLegacyWind, makeDefaultChain, makeLowRumbleRemoval, makeModule, renderChain, withoutLegacyDcModules } from './edit-chain.ts';
import { parseChainPresets } from './chain-presets.ts';
import { createStreamingEditChain } from './streaming-edit-chain.ts';

const sampleRate = 24000;
const count = sampleRate * 4;
const wind = (detection = 'Medium', removal = 'Medium') =>
  ({ ...makeModule('wind'), params: { mode: 'Automatic', detection, removal } });

function sampleInput(from = sampleRate, to = sampleRate * 3) {
  let seed = 12345;
  let low = 0;
  let slow = 0;
  return Float32Array.from({ length: count }, (_, i) => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const random = (seed / 0xffffffff - .5) * 2;
    low += .035 * (random - low);
    slow += .001 * (low - slow);
    const gust = i >= from && i < to ? (low - slow) * 1.4 : 0;
    return gust + .045 * Math.sin(2 * Math.PI * 530 * i / sampleRate);
  });
}

function rms(data, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += data[i] ** 2;
  return Math.sqrt(sum / (to - from));
}

function toneLevel(samples, frequency, from, to) {
  let sine = 0; let cosine = 0;
  for (let i = from; i < to; i++) {
    const phase = 2 * Math.PI * frequency * i / sampleRate;
    sine += samples[i] * Math.sin(phase);
    cosine += samples[i] * Math.cos(phase);
  }
  return 2 * Math.hypot(sine, cosine) / (to - from);
}

test('wind bursts engage only where detected, spare quiet passages and wanted upper tones', () => {
  const input = sampleInput();
  const events = [];
  const output = createStreamingEditChain([wind()], sampleRate, count, 0, [],
    undefined, (_id, frame, active) => events.push({ frame, active })).process([input], 0)[0];
  assert.ok(events.some(({ frame, active }) => active && frame > sampleRate && frame < sampleRate * 3), 'gust should activate');
  assert.ok(events.some(({ frame, active }) => !active && frame > sampleRate * 3), 'reduction should release');
  assert.ok(rms(output, sampleRate * 2, sampleRate * 2.5) < rms(input, sampleRate * 2, sampleRate * 2.5) * .88);
  assert.ok(toneLevel(output, 530, sampleRate * 2, sampleRate * 2.5) >
    toneLevel(input, 530, sampleRate * 2, sampleRate * 2.5) * .94);
  assert.ok(Math.abs(rms(output, sampleRate / 2, sampleRate) - rms(input, sampleRate / 2, sampleRate)) < 1e-5);
});

test('persistent broadband rumble is reduced, while a single wanted bass tone is spared', () => {
  const persistent = sampleInput(0, count);
  const events = [];
  const output = createStreamingEditChain([wind()], sampleRate, count, 0, [], undefined,
    (_id, frame, active) => events.push({ frame, active })).process([persistent], 0)[0];
  assert.ok(events.some(({ frame, active }) => active && frame < sampleRate));
  assert.ok(!events.some(({ frame, active }) => !active && frame > sampleRate * 2));
  assert.ok(rms(output, sampleRate * 3, sampleRate * 3.5) < rms(persistent, sampleRate * 3, sampleRate * 3.5) * .9);
  const bass = Float32Array.from({ length: count }, (_, i) => .12 * Math.sin(2 * Math.PI * 80 * i / sampleRate));
  const cleaned = createStreamingEditChain([wind()], sampleRate, count).process([bass], 0)[0];
  assert.ok(toneLevel(cleaned, 80, sampleRate * 2, sampleRate * 3) >
    toneLevel(bass, 80, sampleRate * 2, sampleRate * 3) * .98, 'steady wanted bass should be protected');
});

test('detection and removal levels are independent and bypass leaves input untouched', () => {
  const input = sampleInput();
  const states = ['Low', 'Medium', 'High'].map((detection) => {
    const events = [];
    createStreamingEditChain([wind(detection)], sampleRate, count, 0, [], undefined,
      (_id, frame, active) => events.push({ frame, active })).process([input], 0);
    return events.filter(({ active }) => active).length;
  });
  assert.ok(states[0] <= states[1] && states[1] <= states[2]);
  const levels = ['Low', 'Medium', 'High'].map((removal) => {
    const output = createStreamingEditChain([wind('High', removal)], sampleRate, count).process([input], 0)[0];
    return rms(Float32Array.from(output, (sample, i) => sample - input[i]), sampleRate * 2, sampleRate * 2.5);
  });
  assert.ok(levels[0] < levels[1] && levels[1] < levels[2]);
  assert.deepEqual(createStreamingEditChain([{ ...wind(), enabled: false }], sampleRate, count).process([input], 0)[0], input);
});

test('memory, chunks, stereo, and restored loops have identical detector state and audio', () => {
  const input = sampleInput();
  const channels = [input, Float32Array.from(input, (value, i) => value * .65 + .01 * Math.sin(i * .23))];
  const module = wind();
  const whole = renderChain(channels, [module], sampleRate);
  const processor = createStreamingEditChain([module], sampleRate, count);
  const chunked = channels.map(() => new Float32Array(count));
  let snapshot;
  const loopStart = 257 * 150;
  for (let from = 0; from < count; from += 257) {
    if (from === loopStart) snapshot = processor.snapshot();
    processor.process(channels.map((channel) => channel.slice(from, from + 257)), from)
      .forEach((channel, index) => chunked[index].set(channel, from));
  }
  assert.deepEqual(chunked, whole);
  processor.restore(snapshot);
  assert.deepEqual(processor.process(channels.map((channel) => channel.slice(loopStart, loopStart + 257)), loopStart),
    whole.map((channel) => channel.slice(loopStart, loopStart + 257)));
});

test('stereo-linked detection responds when gusts occur only in the right channel', () => {
  const noisy = sampleInput();
  const clean = Float32Array.from({ length: count }, (_, i) => .045 * Math.sin(2 * Math.PI * 530 * i / sampleRate));
  const events = [];
  const result = createStreamingEditChain([wind()], sampleRate, count, 0, [], undefined,
    (_id, frame, active) => events.push({ frame, active })).process([clean, noisy], 0);
  assert.ok(events.some(({ active }) => active));
  assert.ok(rms(result[1], sampleRate * 2, sampleRate * 2.5) < rms(noisy, sampleRate * 2, sampleRate * 2.5) * .9);
  assert.ok(toneLevel(result[0], 530, sampleRate * 2, sampleRate * 2.5) >
    toneLevel(clean, 530, sampleRate * 2, sampleRate * 2.5) * .94);
});

test('legacy projects and presets convert Wind / Rumble but retain fixed Low Rumble Removal', () => {
  const oldWind = { id: 'w', type: 'wind', name: 'Wind / Rumble', enabled: true, params: { cutoff: 100, q: .7 } };
  const renamedWind = { ...oldWind, id: 'renamed', name: 'Gust cleanup' };
  const oldLow = { ...oldWind, id: 'low', name: 'Low Rumble Removal', params: { cutoff: 55.5, q: .38 } };
  const renamedLow = { ...oldLow, name: 'First bass cut' };
  const normalized = withoutLegacyDcModules([oldWind, renamedWind, oldLow, renamedLow]);
  assert.ok(isLegacyWind(oldWind));
  assert.deepEqual(normalized.slice(0, 2).map((module) => module.params),
    Array(2).fill({ mode: 'Automatic', detection: 'Medium', removal: 'Medium' }));
  assert.equal(makeModule('wind').name, 'Wind / Rumble Removal');
  assert.equal(normalized[0].name, 'Wind / Rumble Removal');
  assert.equal(normalized[1].name, 'Gust cleanup');
  assert.equal(withoutLegacyDcModules([{ ...oldWind, params: { mode: 'Automatic', detection: 'Low', removal: 'High' } }])[0].name,
    'Wind / Rumble Removal');
  assert.equal(isFixedLowRumble({ ...oldWind, name: 'Wind / Rumble Removal', params: { cutoff: 55.5, q: .38 } }), false);
  assert.ok(normalized.slice(2).every(isFixedLowRumble));
  assert.ok(makeDefaultChain().some((module) => module.type === 'wind' && module.params.mode === 'Automatic'));
  assert.ok(isFixedLowRumble(makeLowRumbleRemoval()));
  const preset = parseChainPresets(JSON.stringify([{ name: 'old', modules: [oldWind, oldLow] }]))[0];
  assert.equal(withoutLegacyDcModules(preset.modules)[0].params.mode, 'Automatic');
  assert.equal(withoutLegacyDcModules(preset.modules)[1].params.mode, 'Fixed low rumble');
});