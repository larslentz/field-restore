import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encodeWav } from './audio.ts';
import { AUTOMATIC_DC_REMOVAL, makeModule, renderChain } from './edit-chain.ts';
import { controlledClippedWind } from './fixtures/controlled-clipped-wind.mjs';
import { parseWavMetadata, readFrames } from './large-wav.ts';
import { createStreamingEditChain } from './streaming-edit-chain.ts';

// Real recorded gusts, synthetic calls: see fixtures/README.md for permission,
// source times, transformations, and the intentionally limited scope.
const rate = 24000;
const frames = rate * 6;
const fixtureBytes = readFileSync(new URL('./fixtures/wind-night-stereo.wav', import.meta.url));
const fixtureFile = new Blob([fixtureBytes]);
const fixtureMetadata = await parseWavMetadata(fixtureFile);
const recorded = await readFrames(fixtureFile, fixtureMetadata, 0, fixtureMetadata.frameCount);

function hybridPassage(routing) {
  const references = [1, 3].map((harmonic) => ({
    harmonic, sine: new Float32Array(frames), cosine: new Float32Array(frames),
  }));
  const call = new Float32Array(frames);
  for (const start of [.4, 1.6, 4.8]) {
    const duration = .45;
    for (let j = 0; j < duration * rate; j++) {
      const elapsed = j / rate;
      const i = Math.round(start * rate) + j;
      const envelope = Math.sin(Math.PI * elapsed / duration) ** 2;
      const phase = 2 * Math.PI * (105 * elapsed + 30 * elapsed * elapsed / (2 * duration));
      call[i] = envelope * (.045 * Math.sin(phase)
        + .013 * Math.sin(2 * phase) + .006 * Math.sin(3 * phase));
      for (const reference of references) {
        reference.sine[i] = envelope * Math.sin(reference.harmonic * phase);
        reference.cosine[i] = envelope * Math.cos(reference.harmonic * phase);
      }
    }
  }
  const wanted = [call, Float32Array.from(call, (sample) => sample * .72)];
  const background = [new Float32Array(frames), new Float32Array(frames)];
  for (let channel = 0; channel < 2; channel++) {
    if (routing === 'right-mic-only' && channel === 0) continue;
    const bed = recorded[routing === 'right-mic-only' ? 0 : channel];
    for (let i = 0; i < bed.length; i++) {
      const taper = Math.min(1, i / (rate * .01), (bed.length - 1 - i) / (rate * .01));
      background[channel][rate + i] = bed[i] * taper;
    }
  }
  const input = wanted.map((channel, c) =>
    Float32Array.from(channel, (sample, i) => sample + background[c][i]));
  return { input, wanted, background, references };
}

function render(input, module) {
  const events = [];
  const output = renderChain(input, [module], rate, {}, undefined, undefined,
    (_id, frame, active) => events.push({ frame, active }));
  return { output, events };
}

async function renderFile(file, metadata, module, chunkFrames, prefixModules = []) {
  const events = [];
  const processor = createStreamingEditChain([...prefixModules, module], rate, frames, 0, [], undefined,
    (_id, frame, active) => events.push({ frame, active }));
  const output = [new Float32Array(frames), new Float32Array(frames)];
  for (let start = 0; start < frames; start += chunkFrames) {
    const chunk = await readFrames(file, metadata, start, Math.min(chunkFrames, frames - start));
    const original = chunk.map((channel) => channel.slice());
    processor.process(chunk, start).forEach((channel, c) => output[c].set(channel, start));
    assert.deepEqual(chunk, original, 'processing must not mutate bounded source reads');
  }
  return { output, events, snapshot: processor.snapshot() };
}

// First differences, not second differences or an audibility claim. Subtract
// aligned differences BEFORE taking absolute values to isolate the correction.
function discontinuities(source, baseline, output, from, until, selected) {
  const metrics = { sourceJump: 0, dcJump: 0, outputJump: 0, correctionJump: 0, excessJump: 0 };
  for (let c = 0; c < source.length; c++) {
    for (let i = Math.max(1, from); i < Math.min(source[c].length, until); i++) {
      if (selected && !selected.has(i)) continue;
      const raw = source[c][i] - source[c][i - 1];
      const dc = baseline[c][i] - baseline[c][i - 1];
      const processed = output[c][i] - output[c][i - 1];
      metrics.sourceJump = Math.max(metrics.sourceJump, Math.abs(raw));
      metrics.dcJump = Math.max(metrics.dcJump, Math.abs(dc));
      metrics.outputJump = Math.max(metrics.outputJump, Math.abs(processed));
      metrics.correctionJump = Math.max(metrics.correctionJump, Math.abs(processed - dc));
      metrics.excessJump = Math.max(metrics.excessJump, Math.abs(processed) - Math.abs(dc));
    }
  }
  return metrics;
}

test('jump measurements distinguish pre-existing clipping edges from processor-added edges', () => {
  const source = [Float32Array.of(-1, 1, 1, 1)];
  const unchanged = discontinuities(source, source, source, 1, 4);
  assert.equal(unchanged.sourceJump, 2);
  assert.equal(unchanged.outputJump, 2);
  assert.equal(unchanged.correctionJump, 0);
  assert.equal(unchanged.excessJump, 0);
  const changed = discontinuities(source, source, [Float32Array.of(-1, 1, .5, 1)], 1, 4);
  assert.equal(changed.sourceJump, 2);
  assert.equal(changed.outputJump, 2, 'global output maximum alone would miss the injected edge');
  assert.equal(changed.correctionJump, .5);
  assert.equal(changed.excessJump, .5);
});

const aroundFrames = (positions, radius) => {
  const selected = new Set();
  for (const position of positions) {
    for (let i = position - radius; i <= position + radius; i++) selected.add(i);
  }
  return selected;
};

// Fixture-specific first-difference regression ceilings in normalized amplitude.
// Higher crossovers remove more fast-varying content from the hard-clipped signal.
// These budgets allow that expected filter response, not arbitrary new clicks;
// they are NOT audibility thresholds. See the baseline measurements in README.md.
const correctionBudgets = {
  8: { 40: .010, 140: .025, 300: .050, 700: .115, 1600: .270 },
  24: { 40: .018, 140: .055, 300: .110, 700: .250, 1600: .560 },
};
const detectorBudgets = {
  8: { 40: .004, 140: .008, 300: .016, 700: .035, 1600: .080 },
  24: { 40: .003, 140: .003, 300: .003, 700: .003, 1600: .003 },
};
const clippedIdentities = {
  8: { hash: '607ca3a398538802df688a5a5bb6b48378db1d28af171bba27bcfd696d3c87f6', rails: [8419, 838] },
  24: { hash: '570764dffd067e85a026f0f542c529f4372ac704acdf830f6f00db5ab6cc2332', rails: [31859, 19434] },
};

for (const gain of [8, 24]) {
  test(`controlled digitally clipped outdoor wind (${gain}x, not microphone overload)`, async (t) => {
    const recordedBefore = recorded.map((channel) => channel.slice());
    const input = controlledClippedWind(recorded, rate, gain);
    const original = input.map((channel) => channel.slice());
    const railEdges = [];
    for (const [c, channel] of input.entries()) {
      const clipped = channel.filter((sample) => Math.abs(sample) === 1);
      assert.equal(clipped.length, clippedIdentities[gain].rails[c], 'derivation must retain its rail occupancy');
      assert.ok(clipped.length > rate * .02, 'both microphones must actually saturate');
      assert.ok(clipped.some((sample) => sample === 1) && clipped.some((sample) => sample === -1),
        'the derivative must reach both clipping rails');
      for (let i = 1; i < channel.length; i++) {
        if ((Math.abs(channel[i]) === 1) !== (Math.abs(channel[i - 1]) === 1)) railEdges.push(i);
      }
      assert.ok(channel.subarray(0, rate).every((sample) => sample === 0));
      assert.ok(channel.subarray(3 * rate).every((sample) => sample === 0));
    }
    assert.ok(railEdges.length > 100, 'exercise repeated entry into and release from saturation');
    const baseline = renderChain(input, [AUTOMATIC_DC_REMOVAL], rate);
    const file = encodeWav({ channels: input, sampleRate: rate, duration: 6,
      name: `controlled-digital-clipping-${gain}x.wav` });
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    assert.equal(fileBytes.length, 1152044);
    assert.equal(createHash('sha256').update(fileBytes).digest('hex'), clippedIdentities[gain].hash,
      'controlled derivative must retain its documented identity');
    const metadata = await parseWavMetadata(file);
    assert.equal(metadata.audioFormat, 3, 'float WAV preserves the staged rails exactly');
    assert.equal(metadata.frameCount, frames);
    assert.equal(metadata.channels, 2);
    assert.equal(metadata.sampleRate, rate);

    const railProbes = aroundFrames(railEdges, 2);
    const seams = [257, 4093].flatMap((size) => {
      const positions = [];
      for (let i = size; i < frames; i += size) positions.push(i);
      return positions;
    });
    const seamProbes = aroundFrames(seams, 2);
    let firstHistory;
    for (const crossoverHz of [40, 140, 300, 700, 1600]) {
      const module = { ...makeModule('wind'),
        params: { mode: 'Automatic', detection: 'Medium', reduction: 72, crossoverHz, smoothing: 50 } };
      const events = [];
      const output = renderChain(input, [AUTOMATIC_DC_REMOVAL, module], rate, {}, undefined, undefined,
        (_id, frame, active) => events.push({ frame, active }));
      assert.ok(events.some(({ active, frame }) => active && frame >= rate && frame < 2 * rate),
        'clipped gust must engage the detector');
      assert.ok(events.some(({ active, frame }) => !active && frame >= 3 * rate && frame < 4 * rate),
        'detector must release after the clipped gust');
      if (firstHistory) assert.deepEqual(events, firstHistory, 'crossover must not change detector history');
      firstHistory = events;
      assert.ok(output.every((channel) => channel.every((sample) =>
        Number.isFinite(sample) && Math.abs(sample) < (gain === 8 ? .9 : 1.4))),
      'output must be finite and bounded (not a promise of unclipped export headroom)');

      // Compare the independent memory path to a one-shot streaming state, then
      // compare that complete state to both non-detector-aligned read schedules.
      const single = createStreamingEditChain([AUTOMATIC_DC_REMOVAL, module], rate, frames);
      assert.deepEqual(single.process(input, 0), output);
      for (const chunkFrames of [257, 4093]) {
        const streamed = await renderFile(file, metadata, module, chunkFrames, [AUTOMATIC_DC_REMOVAL]);
        assert.deepEqual(streamed.output, output, `${crossoverHz} Hz / ${chunkFrames} frames: sample parity`);
        assert.deepEqual(streamed.events, events, 'complete detector history must match, including idle blips');
        assert.deepEqual(streamed.snapshot, single.snapshot(),
          'filter, partial-window, detector, and fade history must survive chunk boundaries');
      }

      const probes = [
        ['whole', 1, frames],
        ['onset', rate, Math.round(1.2 * rate)],
        ['release', Math.round(2.8 * rate), 4 * rate],
      ];
      const metrics = Object.fromEntries(probes.map(([name, from, until]) =>
        [name, discontinuities(input, baseline, output, from, until)]));
      for (const [name, selected] of [
        ['railEdges', railProbes],
        ['detectorTransitions', aroundFrames(events.map(({ frame }) => frame), Math.round(.002 * rate))],
        ['wavSeams', seamProbes],
      ]) metrics[name] = discontinuities(input, baseline, output, 1, frames, selected);
      // Global bounds cover every rail edge, detector transition, and read seam.
      // Explicit local probes keep onset/release failures easy to identify.
      for (const [name, measured] of Object.entries(metrics)) {
        const budget = name === 'detectorTransitions'
          ? detectorBudgets[gain][crossoverHz] : correctionBudgets[gain][crossoverHz];
        assert.ok(measured.correctionJump < budget,
          `${crossoverHz} Hz ${name}: Wind-added difference ${measured.correctionJump}`);
        assert.ok(measured.excessJump < budget,
          `${crossoverHz} Hz ${name}: jump enlargement over DC-only ${measured.excessJump}`);
      }
      assert.ok(metrics.whole.sourceJump > .05, 'source must contain non-trivial pre-existing jumps');
      assert.ok(output.every((channel) => channel.subarray(5 * rate).every((sample) => Math.abs(sample) < .0001)),
        'late post-gust silence must settle after detector and envelope release');
      const peak = output.reduce((max, channel) =>
        channel.reduce((value, sample) => Math.max(value, Math.abs(sample)), max), 0);
      t.diagnostic(JSON.stringify({ gain, crossoverHz, peak, metrics }));
      assert.deepEqual(input, original, 'all rendering paths must leave staged source samples immutable');
    }
    assert.deepEqual(recorded, recordedBefore, 'derivation must not alter the permission-cleared original');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), fileBytes, 'clipped WAV bytes must remain immutable');
  });
}

function component(samples, reference, fromSeconds, toSeconds) {
  let ss = 0; let sc = 0; let cc = 0; let ys = 0; let yc = 0;
  for (let i = Math.round(fromSeconds * rate); i < Math.round(toSeconds * rate); i++) {
    const sine = reference.sine[i];
    const cosine = reference.cosine[i];
    ss += sine * sine; sc += sine * cosine; cc += cosine * cosine;
    ys += samples[i] * sine; yc += samples[i] * cosine;
  }
  const determinant = ss * cc - sc * sc;
  assert.ok(determinant > 0, 'the measurement must include a non-empty call');
  return Math.hypot((ys * cc - yc * sc) / determinant, (yc * ss - ys * sc) / determinant);
}

function relativeError(actual, expected, fromSeconds, toSeconds) {
  let error = 0; let energy = 0;
  for (let i = Math.round(fromSeconds * rate); i < Math.round(toSeconds * rate); i++) {
    error += (actual[i] - expected[i]) ** 2;
    energy += expected[i] ** 2;
  }
  assert.ok(energy > 0, 'the clean probe must contain wanted audio');
  return Math.sqrt(error / energy);
}

test('the compact real-wind fixture retains its documented identity and stereo format', () => {
  assert.equal(fixtureBytes.length, 192078);
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'),
    '9d5a5c086c01054015a90ba6c856ba53a9cc0c00f226f817a09e2c3ecfe8a364');
  assert.equal(fixtureMetadata.sampleRate, rate);
  assert.equal(fixtureMetadata.channels, 2);
  assert.equal(fixtureMetadata.bitsPerSample, 16);
  assert.equal(fixtureMetadata.frameCount, rate * 2);
  assert.notDeepEqual(recorded[0], recorded[1], 'the fixture must not silently become dual mono');
});

for (const routing of ['natural-stereo', 'right-mic-only']) {
  test(`synthetic low calls mixed with real outdoor wind: ${routing}`, async () => {
    const { input, wanted, background, references } = hybridPassage(routing);
    const original = input.map((channel) => channel.slice());
    const wantedReference = renderChain(wanted, [], rate); // mandatory DC correction
    const file = encodeWav({ channels: input, sampleRate: rate, duration: 6, name: 'hybrid.wav' });
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const metadata = await parseWavMetadata(file);
    const retainedThirdHarmonic = [];

    for (const crossoverHz of [140, 300, 700]) {
      const module = {
        ...makeModule('wind'),
        params: { mode: 'Automatic', detection: 'Medium', reduction: 72, crossoverHz, smoothing: 50 },
      };
      const memory = render(input, module);
      const bedOnly = render(background, module);
      const probeEnd = Math.round(1.98 * rate);
      assert.deepEqual(memory.events.filter(({ frame }) => frame <= probeEnd),
        bedOnly.events.filter(({ frame }) => frame <= probeEnd),
        'background subtraction needs identical detector history through the overlap probe');
      if (routing === 'natural-stereo') {
        assert.deepEqual(memory.events, bedOnly.events,
          'this natural-stereo mixture should retain the recorded background detector decisions');
      } else {
        // Known limitation, not a claim that wind is gone: the tonal call
        // briefly classifies this one-mic mixture as idle, then wind re-engages.
        assert.ok(memory.events.some(({ frame, active }) => frame === rate * 2 && !active));
        assert.ok(memory.events.some(({ frame, active }) => frame === rate * 2.1 && active));
      }
      assert.ok(memory.events.some(({ active, frame }) =>
        active && frame >= rate && frame < rate * 1.5), 'the recorded gust must engage reduction');
      assert.ok(memory.events.some(({ active, frame }) =>
        !active && frame >= rate * 3 && frame < rate * 4), 'the detector must release after the gust');
      assert.ok(!render(wanted, module).events.some(({ active }) => active),
        'these synthetic low calls without wind must not trigger the detector');

      for (const chunkFrames of [257, 4093]) {
        const streamed = await renderFile(file, metadata, module, chunkFrames);
        assert.deepEqual(streamed.output, memory.output,
          `${crossoverHz} Hz output must match across bounded ${chunkFrames}-frame WAV reads`);
        assert.deepEqual(streamed.events, memory.events, 'file and memory detector decisions must agree');
      }
      const swapped = render([...input].reverse(), module);
      assert.deepEqual([...swapped.output].reverse(), memory.output, 'swapping mics must swap output only');
      assert.deepEqual(swapped.events, memory.events, 'mic order must not change linked decisions');
      assert.ok(memory.output.every((channel) => channel.every((sample) =>
        Number.isFinite(sample) && Math.abs(sample) < 1)), 'output must stay finite with headroom');

      // The gust-overlap probe ends before detector histories diverge. Do not
      // use this counterfactual subtraction to measure the later idle blip.
      const callResponse = memory.output.map((channel, c) =>
        Float32Array.from(channel, (sample, i) => sample - bedOnly.output[c][i]));
      const levels = [];
      for (let channel = 0; channel < 2; channel++) {
        assert.ok(relativeError(memory.output[channel], wantedReference[channel], .48, .75) < .01,
          'the clean opening call must remain unchanged');
        assert.ok(relativeError(memory.output[channel], wantedReference[channel], 4.88, 5.18) < .01,
          'the late clean call must remain unchanged after detector and envelope release');
        levels[channel] = references.map((reference) =>
          component(callResponse[channel], reference, 1.68, 1.98)
          / component(wantedReference[channel], reference, 1.68, 1.98));
        assert.ok(levels[channel][0] > .15 && levels[channel][0] < .8,
          `${crossoverHz} Hz must attenuate, not erase, the gust-overlap fundamental (${levels[channel][0]})`);
      }
      for (let harmonic = 0; harmonic < references.length; harmonic++) {
        assert.ok(Math.abs(levels[0][harmonic] - levels[1][harmonic]) < .005,
          'linked reduction must apply the same harmonic response to both microphones');
      }
      retainedThirdHarmonic.push(levels[0][1]);
      assert.deepEqual(input, original, 'renders must not modify source samples');
    }
    assert.ok(retainedThirdHarmonic[0] > .85, '140 Hz should retain the upper call harmonic');
    assert.ok(retainedThirdHarmonic[2] < .5, '700 Hz should attenuate the upper call harmonic during gusts');
    assert.ok(retainedThirdHarmonic[0] > retainedThirdHarmonic[1]
      && retainedThirdHarmonic[1] > retainedThirdHarmonic[2],
    'raising the crossover should progressively reduce the upper call harmonic during gusts');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), fileBytes, 'WAV source must stay immutable');
  });
}
