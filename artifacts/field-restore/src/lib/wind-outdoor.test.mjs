import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encodeWav } from './audio.ts';
import { makeModule, renderChain } from './edit-chain.ts';
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

async function renderFile(file, metadata, module, chunkFrames) {
  const events = [];
  const processor = createStreamingEditChain([module], rate, frames, 0, [], undefined,
    (_id, frame, active) => events.push({ frame, active }));
  const output = [new Float32Array(frames), new Float32Array(frames)];
  for (let start = 0; start < frames; start += chunkFrames) {
    const chunk = await readFrames(file, metadata, start, Math.min(chunkFrames, frames - start));
    processor.process(chunk, start).forEach((channel, c) => output[c].set(channel, start));
  }
  return { output, events };
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
