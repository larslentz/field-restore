import assert from 'node:assert/strict';
import test from 'node:test';
import { isFixedLowRumble, isLegacyWind, makeDefaultChain, makeLowRumbleRemoval, makeModule, renderChain, withoutLegacyDcModules } from './edit-chain.ts';
import { parseChainPresets } from './chain-presets.ts';
import { createStreamingEditChain } from './streaming-edit-chain.ts';
import { WIND_COMPENSATION_TIMING, WindProcessor, windCompensationTiming } from './wind-reduction.ts';

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

test('the first completed detector window confirms idle as well as active wind', () => {
  const module = wind();
  const events = [];
  const processor = createStreamingEditChain([module], sampleRate, 2400, 0, [], undefined,
    (moduleId, frame, active) => events.push({ moduleId, frame, active }));
  const cleanTone = Float32Array.from({ length: 2400 }, (_, i) => .05 * Math.sin(2 * Math.PI * 530 * i / sampleRate));

  assert.deepEqual(processor.trackedWindActivity(), {});
  processor.process([cleanTone], 0);
  assert.deepEqual(events, [{ moduleId: module.id, frame: 2400, active: false }]);
  assert.deepEqual(processor.trackedWindActivity(), { [module.id]: false });
});

test('the wind envelope used for compensation ramps and releases smoothly', () => {
  const envelope = [];
  new WindProcessor(sampleRate, 1, 'Medium', 'Medium')
    .process([sampleInput()], (_frame, amount) => envelope.push(amount));
  const largestStep = envelope.slice(1).reduce((largest, value, index) =>
    Math.max(largest, Math.abs(value - envelope[index])), 0);
  assert.ok(envelope.some((amount) => amount > .9), 'the gust should reach full compensation');
  assert.ok(largestStep <= .002, `envelope step ${largestStep} should not create an abrupt shelf edge`);
});

test('adjustable compensation fades do not change wind removal and default to its current timing', () => {
  const input = sampleInput();
  const render = (timing) => {
    const envelope = [];
    const events = [];
    const output = [new Float32Array(input)];
    new WindProcessor(sampleRate, 1, 'Medium', 'Medium',
      (frame, active) => events.push({ frame, active }), 0, timing)
      .process(output, (_frame, amount) => envelope.push(amount));
    return { output: output[0], envelope, events };
  };
  const defaults = render(undefined);
  const explicitDefaults = render({
    attackMs: WIND_COMPENSATION_TIMING.attack.defaultMs,
    releaseMs: WIND_COMPENSATION_TIMING.release.defaultMs,
  });
  const slower = render({ attackMs: 100, releaseMs: 500 });

  assert.deepEqual(defaults.output, explicitDefaults.output);
  assert.deepEqual(defaults.envelope, explicitDefaults.envelope);
  assert.deepEqual(defaults.output, slower.output, 'timing controls must not alter the wind reducer crossfade');
  assert.deepEqual(defaults.events, slower.events, 'timing controls must not alter detector decisions');

  const activeFrame = defaults.events.find(({ active }) => active)?.frame;
  const releaseFrame = defaults.events.find(({ active, frame }) => !active && frame > activeFrame)?.frame;
  assert.ok(activeFrame !== undefined && releaseFrame !== undefined);
  const attackProbe = activeFrame + Math.round(sampleRate * .025);
  const releaseProbe = releaseFrame + Math.round(sampleRate * .1);
  assert.ok(slower.envelope[attackProbe] < defaults.envelope[attackProbe],
    'a slower attack should delay the compensation fade-in');
  assert.ok(slower.envelope[releaseProbe] > defaults.envelope[releaseProbe],
    'a slower release should extend the compensation fade-out');

  assert.deepEqual(windCompensationTiming({}), { attackMs: 25, releaseMs: 180 });
  assert.deepEqual(windCompensationTiming({ compensationAttackMs: 1, compensationReleaseMs: 2000 }),
    { attackMs: 5, releaseMs: 1000 });
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

test('low-end compensation can follow the smoothed wind envelope without changing quiet ambience', () => {
  const input = sampleInput();
  const base = wind();
  const gated = {
    ...base,
    params: {
      ...base.params,
      lowEndEnabled: 1,
      lowEndScope: 'Detected wind only',
      lowEndGain: 8,
      compensationAttackMs: 95,
      compensationReleaseMs: 520,
    },
  };
  const unboosted = renderChain([input], [base], sampleRate)[0];
  const inMemory = renderChain([input], [gated], sampleRate)[0];

  assert.deepEqual(inMemory.slice(0, sampleRate), unboosted.slice(0, sampleRate),
    'the clean opening should be byte-for-byte unchanged');
  assert.ok(inMemory.some((value, index) => Math.abs(value - unboosted[index]) > 1e-4),
    'the shelf should engage during detected wind');

  const streamed = createStreamingEditChain([gated], sampleRate, count);
  const streamedAudio = new Float32Array(count);
  let loopSnapshot;
  const loopStart = 257 * 200;
  for (let start = 0; start < count; start += 257) {
    if (start === loopStart) loopSnapshot = streamed.snapshot();
    const end = Math.min(count, start + 257);
    streamed.process([input.slice(start, end)], start)[0].forEach((value, index) => {
      streamedAudio[start + index] = value;
    });
  }
  assert.deepEqual(streamedAudio, inMemory, 'file-backed chunks must match in-memory rendering');
  streamed.restore(loopSnapshot);
  assert.deepEqual(
    streamed.process([input.slice(loopStart, loopStart + 257)], loopStart),
    [inMemory.slice(loopStart, loopStart + 257)],
    'restoring a loop must restore both detector and shelf histories',
  );

  const alwaysOn = {
    ...gated,
    params: { ...gated.params, lowEndScope: 'Whole recording' },
  };
  const wholeRecording = renderChain([input], [alwaysOn], sampleRate)[0];
  assert.ok(wholeRecording.some((value, index) => Math.abs(value - input[index]) > 1e-4),
    'the existing whole-recording mode should remain available');
  const legacyWholeRecording = { ...alwaysOn, params: { ...alwaysOn.params } };
  delete legacyWholeRecording.params.lowEndScope;
  assert.deepEqual(renderChain([input], [legacyWholeRecording], sampleRate)[0], wholeRecording,
    'saved wind edits without a scope setting should retain whole-recording behavior');
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
    Array(2).fill({
      mode: 'Automatic', detection: 'Medium', removal: 'Medium',
      compensationAttackMs: 25, compensationReleaseMs: 180,
    }));
  assert.equal(makeModule('wind').name, 'Wind Removal');
  assert.equal(normalized[0].name, 'Wind Removal');
  assert.equal(normalized[1].name, 'Gust cleanup');
  assert.equal(withoutLegacyDcModules([{ ...oldWind, params: { mode: 'Automatic', detection: 'Low', removal: 'High' } }])[0].name,
    'Wind Removal');
  assert.equal(withoutLegacyDcModules([{ ...oldWind, name: 'Wind / Rumble Removal', params: { mode: 'Automatic', detection: 'Low', removal: 'High' } }])[0].name,
    'Wind Removal');
  assert.equal(isFixedLowRumble({ ...oldWind, name: 'Wind / Rumble Removal', params: { cutoff: 55.5, q: .38 } }), false);
  assert.equal(withoutLegacyDcModules([{ ...oldWind, name: 'Wind / Rumble Removal', params: { cutoff: 55.5, q: .38 } }])[0].params.mode, 'Automatic');
  assert.ok(normalized.slice(2).every(isFixedLowRumble));
  assert.ok(makeDefaultChain().some((module) => module.type === 'wind' && module.params.mode === 'Automatic'));
  assert.ok(isFixedLowRumble(makeLowRumbleRemoval()));
  const preset = parseChainPresets(JSON.stringify([{ name: 'old', modules: [oldWind, oldLow] }]))[0];
  assert.equal(withoutLegacyDcModules(preset.modules)[0].params.mode, 'Automatic');
  assert.equal(withoutLegacyDcModules(preset.modules)[1].params.mode, 'Fixed low rumble');
});