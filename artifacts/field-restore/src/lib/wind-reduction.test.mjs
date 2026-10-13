import assert from 'node:assert/strict';
import test from 'node:test';
import { isFixedLowRumble, isLegacyWind, makeDefaultChain, makeLowRumbleRemoval, makeModule, renderChain, withoutLegacyDcModules } from './edit-chain.ts';
import { parseChainPresets } from './chain-presets.ts';
import { createStreamingEditChain } from './streaming-edit-chain.ts';
import { WIND_COMPENSATION_TIMING, WindProcessor, windCompensationTiming, windCrossoverFrequency, windReductionPercent, windSmoothing } from './wind-reduction.ts';

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

function highRateWindInput(rate, durationSeconds = 4) {
  const frames = rate * durationSeconds;
  return [0, 1].map((channel) => {
    let seed = 12345 + channel * 17;
    let low = 0;
    let slow = 0;
    const lowAlpha = 1 - Math.exp(-2 * Math.PI * 135 / rate);
    const slowAlpha = 1 - Math.exp(-2 * Math.PI * 4 / rate);
    return Float32Array.from({ length: frames }, (_, frame) => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      const random = (seed / 0xffffffff - .5) * 2;
      low += lowAlpha * (random - low);
      slow += slowAlpha * (low - slow);
      const gust = frame >= rate && frame < rate * 3 ? (low - slow) * 1.4 : 0;
      return gust + (channel ? .03 : .045) * Math.sin(2 * Math.PI * 530 * frame / rate + channel * .2);
    });
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

function crossoverPassage(crossoverHz, kind, channel, withWind) {
  const frames = sampleRate * 6;
  const gain = channel === 0 ? 1 : .72;
  const phaseOffset = channel * .23;
  const lowFrequency = crossoverHz * .65;
  const callStart = crossoverHz * .78;
  const callEnd = crossoverHz * .98;
  const callDuration = .4;
  const callStarts = [.5, 1.5, 4.8];
  const samples = new Float32Array(frames);
  const referenceSine = new Float32Array(frames);
  const referenceCosine = new Float32Array(frames);
  let seed = 9871;
  let low = 0;
  let slow = 0;

  for (let i = 0; i < frames; i++) {
    let wanted = 0;
    let sine = 0;
    let cosine = 0;
    if (kind === 'tone') {
      const phase = 2 * Math.PI * lowFrequency * i / sampleRate;
      sine = Math.sin(phase);
      cosine = Math.cos(phase);
      wanted = .035 * sine;
    } else {
      const callStartFrame = callStarts.find((start) =>
        i >= start * sampleRate && i < (start + callDuration) * sampleRate);
      if (callStartFrame !== undefined) {
        const elapsed = i / sampleRate - callStartFrame;
        const phase = 2 * Math.PI * (callStart * elapsed
          + (callEnd - callStart) * elapsed * elapsed / (2 * callDuration)) + phaseOffset;
        const envelope = Math.sin(Math.PI * elapsed / callDuration) ** 2;
        sine = envelope * Math.sin(phase);
        cosine = envelope * Math.cos(phase);
        wanted = .05 * sine + .012 * envelope * Math.sin(2 * phase);
      }
    }
    referenceSine[i] = sine;
    referenceCosine[i] = cosine;

    seed = (1664525 * seed + 1013904223) >>> 0;
    const random = (seed / 0xffffffff - .5) * 2;
    low += .035 * (random - low);
    slow += .001 * (low - slow);
    const gust = withWind && channel === 1 && i >= sampleRate && i < sampleRate * 3
      ? (low - slow) * 1.4 : 0;
    samples[i] = gain * wanted + gust;
  }
  return { samples, referenceSine, referenceCosine, gain };
}

function componentLevel(samples, referenceSine, referenceCosine, from, to) {
  let ss = 0; let sc = 0; let cc = 0; let ys = 0; let yc = 0;
  for (let i = from; i < to; i++) {
    const sine = referenceSine[i];
    const cosine = referenceCosine[i];
    ss += sine * sine;
    sc += sine * cosine;
    cc += cosine * cosine;
    ys += samples[i] * sine;
    yc += samples[i] * cosine;
  }
  const determinant = ss * cc - sc * sc;
  const sineGain = (ys * cc - yc * sc) / determinant;
  const cosineGain = (yc * ss - ys * sc) / determinant;
  return Math.hypot(sineGain, cosineGain);
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

test('96 kHz stereo wind compensation stays finite and smooth through quiet-to-gust transitions', () => {
  const rate = 96000;
  const input = highRateWindInput(rate);
  const original = input.map((channel) => new Float32Array(channel));
  const events = [];
  const envelope = [];
  new WindProcessor(rate, input.length, 'Medium', 'Medium',
    (frame, active) => events.push({ frame, active }))
    .process(input, (frame, amount) => envelope.push(amount));

  assert.ok(events.some(({ frame, active }) => active && frame >= rate && frame < rate * 3),
    'the high-rate gust should be detected');
  assert.ok(events.some(({ frame, active }) => !active && frame > rate * 3),
    'the detector should release after the gust');
  assert.ok(input.every((channel) => channel.every(Number.isFinite)), 'processed stereo output must stay finite');
  for (let channel = 0; channel < input.length; channel++) {
    assert.deepEqual(input[channel].slice(0, rate), original[channel].slice(0, rate),
      'the quiet opening should remain untouched before wind is detected');
  }
  const largestStep = envelope.slice(1).reduce((largest, value, index) =>
    Math.max(largest, Math.abs(value - envelope[index])), 0);
  assert.ok(envelope.some((amount) => amount > .9), 'compensation should reach the gust');
  assert.ok(largestStep <= .001, `96 kHz compensation envelope step ${largestStep} should remain smooth`);
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

test('raised crossovers attenuate wanted bass and low calls only during linked wind reduction', () => {
  for (const crossoverHz of [140, 300, 700]) {
    for (const kind of ['tone', 'call']) {
      const left = crossoverPassage(crossoverHz, kind, 0, true);
      const right = crossoverPassage(crossoverHz, kind, 1, true);
      const input = [left.samples, right.samples];
      const module = {
        ...wind(),
        params: { mode: 'Automatic', detection: 'Medium', reduction: 72, crossoverHz, smoothing: 50 },
      };
      const memoryEvents = [];
      const memory = renderChain(input, [module], sampleRate, {}, undefined, undefined,
        (_id, frame, active) => memoryEvents.push({ frame, active }));
      const streamedEvents = [];
      const frames = input[0].length;
      const streamedProcessor = createStreamingEditChain([module], sampleRate, frames, 0, [], undefined,
        (_id, frame, active) => streamedEvents.push({ frame, active }));
      const streamed = input.map(() => new Float32Array(frames));
      for (let start = 0; start < frames; start += 257) {
        const end = Math.min(frames, start + 257);
        streamedProcessor.process(input.map((channel) => channel.slice(start, end)), start)
          .forEach((channel, index) => streamed[index].set(channel, start));
      }

      assert.deepEqual(streamed, memory,
        `${kind} near ${crossoverHz} Hz must match between memory and streamed rendering`);
      assert.deepEqual(streamedEvents, memoryEvents,
        `${kind} near ${crossoverHz} Hz must have matching detector decisions`);
      assert.ok(memoryEvents.some(({ active, frame }) => active && frame >= sampleRate && frame < sampleRate * 3),
        `right-channel gust should activate linked reduction for ${kind} near ${crossoverHz} Hz`);
      assert.ok(memoryEvents.some(({ active, frame }) => !active && frame > sampleRate * 3),
        'the detector should release after the gust');
      assert.ok(memory.every((channel) => channel.every(Number.isFinite)), 'stereo output must remain finite');
      assert.ok(memory.every((channel) => channel.every((value) => Math.abs(value) < 1)),
        'the crossover response must remain bounded without clipping');

      const componentAt = (channel, fromSeconds, toSeconds) => {
        const source = channel === 0 ? left : right;
        return componentLevel(memory[channel], source.referenceSine, source.referenceCosine,
          Math.round(fromSeconds * sampleRate), Math.round(toSeconds * sampleRate)) / source.gain;
      };
      const cleanLevel = kind === 'tone'
        ? componentAt(0, 5, 5.8)
        : componentAt(0, 4.88, 5.02);
      const cleanInputLevel = kind === 'tone'
        ? componentLevel(left.samples, left.referenceSine, left.referenceCosine,
          sampleRate * 5, sampleRate * 5.8)
        : componentLevel(left.samples, left.referenceSine, left.referenceCosine,
          sampleRate * 4.88, sampleRate * 5.02);
      assert.ok(Math.abs(cleanLevel - cleanInputLevel) < cleanInputLevel * .01,
        `clean ${kind} should remain unchanged when the detector is idle at ${crossoverHz} Hz ` +
          `(processed ${cleanLevel}, input ${cleanInputLevel}; events ${JSON.stringify(memoryEvents)})`);

      const windFrom = kind === 'tone' ? 1.5 : 1.58;
      const windTo = kind === 'tone' ? 2.5 : 1.72;
      const leftWindLevel = componentAt(0, windFrom, windTo);
      const rightWindLevel = componentAt(1, windFrom, windTo);
      assert.ok(leftWindLevel > 0 && leftWindLevel < .95,
        `wanted ${kind} below or near ${crossoverHz} Hz should be attenuated, not erased or amplified`);
      assert.ok(rightWindLevel > 0 && rightWindLevel < .95,
        `the clean channel should receive the same linked ${kind} attenuation during a right-channel gust`);
      assert.ok(Math.abs(leftWindLevel - rightWindLevel) < .12,
        'stereo-linked reduction should not create an unexpected left/right level split');
    }
  }
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

test('continuous wind controls change reduction, crossover and envelope smoothing', () => {
  const input = sampleInput();
  const makeTuned = (params) => ({
    ...makeModule('wind'),
    params: { mode: 'Automatic', detection: 'High', reduction: 72, crossoverHz: 140, smoothing: 50,
      lowEndEnabled: 1, lowEndScope: 'Detected wind only', lowEndFrequency: 55, lowEndQ: .4, lowEndGain: 6, ...params },
  });
  const render = (params) => renderChain([input], [makeTuned(params)], sampleRate)[0];
  const none = render({ reduction: 0 });
  const gentle = render({ reduction: 30 });
  const strong = render({ reduction: 90 });
  assert.deepEqual(none, input, 'zero reduction must preserve the input and avoid invalid compensation envelopes');
  const change = (audio) => rms(Float32Array.from(audio, (sample, i) => sample - input[i]), sampleRate * 2, sampleRate * 2.5);
  assert.ok(change(gentle) < change(strong), 'higher reduction should apply more of the high-pass');
  assert.notDeepEqual(render({ crossoverHz: 700 }), render({ crossoverHz: 140 }),
    'crossover should change the reducer frequency boundary');
  assert.notDeepEqual(render({ smoothing: 0 }), render({ smoothing: 100 }),
    'smoothing should change how quickly the reduction envelope moves');
  assert.deepEqual(windReductionPercent(undefined, 'Low'), 38);
  assert.deepEqual(windReductionPercent(undefined, 'Medium'), 72);
  assert.deepEqual(windReductionPercent(undefined, 'High'), 96);
  assert.deepEqual(windReductionPercent(140), 100);
  assert.deepEqual(windCrossoverFrequency(2000, 24000), 1600);
  assert.deepEqual(windSmoothing(-10), 0);
});

test('memory, chunks, stereo, and restored loops have identical detector state and audio', () => {
  const input = sampleInput();
  const channels = [input, Float32Array.from(input, (value, i) => value * .65 + .01 * Math.sin(i * .23))];
  const module = {
    ...wind(),
    params: { mode: 'Automatic', detection: 'Medium', reduction: 84, crossoverHz: 680, smoothing: 72 },
  };
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
      mode: 'Automatic', detection: 'Medium', reduction: 72, crossoverHz: 140, smoothing: 50,
      compensationAttackMs: 25, compensationReleaseMs: 180,
    }));
  assert.equal(makeModule('wind').name, 'Wind Removal');
  assert.equal(normalized[0].name, 'Wind Removal');
  assert.equal(normalized[1].name, 'Gust cleanup');
  const migratedHigh = withoutLegacyDcModules([{ ...oldWind, params: { mode: 'Automatic', detection: 'Low', removal: 'High' } }])[0];
  assert.equal(migratedHigh.name, 'Wind Removal');
  assert.equal(migratedHigh.params.reduction, 96);
  assert.equal(migratedHigh.params.detection, 'Low');
  assert.equal(migratedHigh.params.removal, undefined);
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