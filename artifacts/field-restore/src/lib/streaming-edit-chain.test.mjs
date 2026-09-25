import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeInitialHum, humOpeningReadout, makeLowRumbleRemoval, makeModule, makeProcessingChain, renderChain, withFadeRange } from './edit-chain.ts';
import { analyzeFileInitialHum, createStreamingEditChain } from './streaming-edit-chain.ts';
import { humAnalysisWindowSize } from './hum-removal.ts';
import { generateFloat32WavHeader, parseWavMetadata } from './large-wav.ts';
import { readFrames, writeFloat32WavChunks } from './large-wav.ts';
import { createDemoAudio, encodeWav, parseWav } from './audio.ts';

const sampleRate = 48000;
const totalFrames = 12000;
const modules = [
  { id: 'dc', type: 'dc', name: 'DC', enabled: true, params: { mode: 'Auto', amount: 0 } },
  { id: 'wind', type: 'wind', name: 'Wind', enabled: true, params: { cutoff: 100, q: 0.7 } },
  { id: 'eq', type: 'eq', name: 'EQ', enabled: true, params: { mode: 'low-shelf', frequency: 80, q: 0.5, gain: 2 } },
  { id: 'fade', type: 'fade', name: 'Fade', enabled: true, params: { in: 0.1, out: 0.1 } },
];

function source() {
  return [
    Float32Array.from({ length: totalFrames }, (_, i) => 0.08 + Math.sin(i * 0.031) * 0.3),
    Float32Array.from({ length: totalFrames }, (_, i) => -0.04 + Math.cos(i * 0.027) * 0.25),
  ];
}

function highRateWindSource(rate, durationSeconds = 4) {
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

test('sequential chunks equal one streaming pass across boundaries', () => {
  const input = source();
  const whole = createStreamingEditChain(modules, sampleRate, totalFrames).process(input, 0);
  const chunked = input.map(() => new Float32Array(totalFrames));
  const processor = createStreamingEditChain(modules, sampleRate, totalFrames);
  for (let start = 0; start < totalFrames; start += 257) {
    const end = Math.min(totalFrames, start + 257);
    const output = processor.process(input.map((channel) => channel.slice(start, end)), start);
    output.forEach((channel, index) => chunked[index].set(channel, start));
  }
  chunked.forEach((channel, channelIndex) => {
    for (let i = 0; i < totalFrames; i += 1) assert.equal(channel[i], whole[channelIndex][i]);
  });
});

test('in-memory and file-backed routes produce equivalent restored audio', () => {
  const input = source();
  const processingModules = makeProcessingChain(modules);
  const inMemory = renderChain(input, processingModules, sampleRate, { totalFrames });
  const fileBacked = createStreamingEditChain(processingModules, sampleRate, totalFrames).process(input, 0);
  let greatestDifference = 0;

  inMemory.forEach((channel, channelIndex) => channel.forEach((sample, frame) => {
    greatestDifference = Math.max(greatestDifference, Math.abs(sample - fileBacked[channelIndex][frame]));
  }));

  assert.ok(
    greatestDifference <= 1e-6,
    `expected route outputs within tolerance, greatest difference was ${greatestDifference}`,
  );
});

test('each removal item applies its own low-end shelf consistently across memory, streamed chunks, and snapshots', () => {
  const frames = 8192;
  const input = [
    Float32Array.from({ length: frames }, (_, i) => .18 * Math.sin(2 * Math.PI * 42 * i / sampleRate)),
    Float32Array.from({ length: frames }, (_, i) => .12 * Math.sin(2 * Math.PI * 62 * i / sampleRate)),
  ];
  for (const parent of [makeLowRumbleRemoval(), makeModule('wind')]) {
    const enabled = { ...parent, params: { ...parent.params, lowEndEnabled: 1, lowEndGain: 6, lowEndFrequency: 90 } };
    const off = { ...enabled, params: { ...enabled.params, lowEndEnabled: 0 } };
    const bypassed = { ...enabled, enabled: false };
    const memoryOn = renderChain(input, [enabled], sampleRate);
    const memoryOff = renderChain(input, [off], sampleRate);
    assert.ok(memoryOn[0].some((value, i) => Math.abs(value - memoryOff[0][i]) > 1e-4),
      `${parent.name} shelf must affect the processed signal`);
    assert.deepEqual(renderChain(input, [bypassed], sampleRate), input);
    for (const edit of [enabled, off, bypassed]) {
      const expected = renderChain(input, [edit], sampleRate);
      const processor = createStreamingEditChain([edit], sampleRate, frames);
      const actual = input.map(() => new Float32Array(frames));
      let snapshot;
      for (let start = 0; start < frames; start += 257) {
        if (start === 257) snapshot = processor.snapshot();
        const end = Math.min(frames, start + 257);
        const output = processor.process(input.map((channel) => channel.slice(start, end)), start);
        output.forEach((channel, index) => actual[index].set(channel, start));
      }
      const difference = Math.max(...actual.map((channel, c) =>
        channel.reduce((largest, value, i) => Math.max(largest, Math.abs(value - expected[c][i])), 0)));
      assert.ok(difference < 1e-5, `${parent.name} ${edit.enabled ? edit.params.lowEndEnabled : 'bypassed'} route difference ${difference}`);
      processor.restore(snapshot);
      assert.deepEqual(processor.process(input.map((channel) => channel.slice(257, 514)), 257),
        actual.map((channel) => channel.slice(257, 514)));
    }
  }
});

test('in-memory and streamed fades follow edited Start and End markers, including across chunks', () => {
  const rate = 10;
  const frames = 30;
  const fade = makeModule('fade', { params: { in: 1, out: 1 } });
  const anchored = withFadeRange([fade], 5, 25);
  const input = [Float32Array.from({ length: frames }, () => 1)];
  const memory = renderChain(input, anchored, rate)[0];
  const processor = createStreamingEditChain(anchored, rate, frames);
  const streamed = new Float32Array(frames);
  for (let start = 0; start < frames; start += 7) {
    const end = Math.min(frames, start + 7);
    streamed.set(processor.process([input[0].slice(start, end)], start)[0], start);
  }
  for (const [frame, value] of [[0, 0], [5, 0], [10, .5], [15, 1], [20, .5], [25, 0]]) {
    assert.ok(Math.abs(memory[frame] - value) < 1e-6, `frame ${frame} should be ${value}, got ${memory[frame]}`);
  }
  assert.deepEqual(streamed, memory);
  const trimmedExport = createStreamingEditChain(anchored, rate, frames, 5)
    .process([input[0].slice(5, 25)], 5)[0];
  assert.deepEqual(trimmedExport, memory.slice(5, 25));
  assert.equal(fade.params.fadeStartFrame, undefined, 'render-only bounds must not modify saved edits');
  const inOnly = { ...anchored[0], params: { ...anchored[0].params, outEnabled: 0 } };
  const outOnly = { ...anchored[0], params: { ...anchored[0].params, inEnabled: 0 } };
  assert.equal(renderChain(input, [inOnly], rate)[0][5], 0);
  assert.equal(renderChain(input, [inOnly], rate)[0][25], 1);
  assert.equal(renderChain(input, [outOnly], rate)[0][5], 1);
  assert.equal(renderChain(input, [outOnly], rate)[0][25], 0);
  for (const side of [inOnly, outOnly, { ...anchored[0], enabled: false }]) {
    assert.deepEqual(createStreamingEditChain([side], rate, frames).process(input, 0), renderChain(input, [side], rate));
  }
  assert.deepEqual(renderChain(input, [{ ...anchored[0], enabled: false }], rate), input);
  const shifted = withFadeRange([fade], 8, 22);
  assert.equal(renderChain(input, shifted, rate)[0][8], 0);
  assert.equal(renderChain(input, shifted, rate)[0][22], 0);
});

test('restoring warmed state makes repeated selection loops deterministic', () => {
  const input = source();
  const selectionStart = 3000;
  const selectionEnd = 5000;
  const processor = createStreamingEditChain(modules, sampleRate, totalFrames, 2000);
  processor.process(input.map((channel) => channel.slice(2000, selectionStart)), 2000);
  const warmed = processor.snapshot();
  const selection = input.map((channel) => channel.slice(selectionStart, selectionEnd));
  const first = processor.process(selection, selectionStart);
  processor.restore(warmed);
  const second = processor.process(selection, selectionStart);
  first.forEach((channel, index) => assert.deepEqual(channel, second[index]));
});

test('file-backed processing includes one automatic DC stage after legacy normalization', () => {
  const legacyModules = [
    { id: 'legacy-dc', type: 'dc', name: 'Legacy DC', enabled: true, params: { mode: 'Auto', amount: 0 } },
    { id: 'gain', type: 'gain', name: 'Gain', enabled: true, params: { db: 0 } },
  ];
  const processingModules = makeProcessingChain(legacyModules);
  assert.equal(processingModules.filter((module) => module.type === 'dc').length, 1);
  assert.equal(processingModules[0].id, 'automatic-dc-removal');

  const constant = [Float32Array.from({ length: sampleRate }, () => 0.2)];
  const output = createStreamingEditChain(processingModules, sampleRate, sampleRate).process(constant, 0);
  const tailMean = output[0].slice(-512).reduce((sum, value) => sum + value, 0) / 512;
  assert.ok(Math.abs(tailMean) < 0.001, `expected DC-corrected tail, received ${tailMean}`);
});

function measuredTone(samples, rate, frequency, start, frames) {
  let sine = 0; let cosine = 0;
  for (let i = start; i < start + frames; i++) {
    const phase = 2 * Math.PI * frequency * i / rate;
    sine += samples[i] * Math.sin(phase);
    cosine += samples[i] * Math.cos(phase);
  }
  return 2 * Math.hypot(sine, cosine) / frames;
}

test('automatic DC removal preserves 20–100 Hz with and without offset at common sample rates, mono and stereo', () => {
  for (const rate of [44100, 48000, 96000, 192000]) {
    const count = rate * 2;
    for (const channelCount of [1, 2]) {
      const constant = Array.from({ length: channelCount }, (_, channel) =>
        Float32Array.from({ length: count }, () => channel ? -.32 : .23));
      const removed = createStreamingEditChain(makeProcessingChain([]), rate, count).process(constant, 0);
      for (let channel = 0; channel < channelCount; channel++) {
        assert.ok(Math.abs(removed[channel][count - 1]) < .001, `${rate} Hz channel ${channel}: constant DC remains`);
      }
      for (const offset of [0, .18]) {
        for (const frequency of [20, 50, 100]) {
          const input = Array.from({ length: channelCount }, (_, channel) =>
            Float32Array.from({ length: count }, (_, i) =>
              (channel ? -.7 : 1) * offset + .4 * Math.sin(2 * Math.PI * frequency * i / rate + channel * .4)));
          const memory = renderChain(input, makeProcessingChain([]), rate);
          const streaming = createStreamingEditChain(makeProcessingChain([]), rate, count).process(input, 0);
          for (let channel = 0; channel < channelCount; channel++) {
            const level = measuredTone(memory[channel], rate, frequency, rate, rate);
            assert.ok(Math.abs(level / .4 - 1) < .01, `${rate} Hz, ${frequency} Hz, offset ${offset}, channel ${channel}: ${level}`);
            const mean = memory[channel].subarray(rate).reduce((sum, sample) => sum + sample, 0) / rate;
            assert.ok(Math.abs(mean) < .001, `${rate} Hz, DC residual ${mean}`);
            assert.deepEqual(streaming[channel], memory[channel], 'render paths must produce identical samples');
          }
        }
      }
    }
  }
});

test('DC startup and near-full-scale input remain bounded with continuous state at chunk and loop boundaries', () => {
  const rate = 48000, count = rate * 2, modules = makeProcessingChain([]);
  const input = [Float32Array.from({ length: count }, (_, i) => .03 + .94 * Math.sin(2 * Math.PI * 20 * i / rate))];
  const whole = renderChain(input, modules, rate)[0];
  assert.ok(Math.abs(whole[0] - input[0][0]) < 1e-7);
  assert.ok(whole.every((value) => Number.isFinite(value) && Math.abs(value) <= 1));
  const processor = createStreamingEditChain(modules, rate, count);
  const joined = new Float32Array(count);
  let loopState;
  const loopAt = 4093 * 3;
  for (let start = 0; start < count; start += 4093) {
    if (start === loopAt) loopState = processor.snapshot();
    joined.set(processor.process([input[0].slice(start, start + 4093)], start)[0], start);
    if (start) assert.equal(joined[start] - joined[start - 1], whole[start] - whole[start - 1]);
  }
  assert.deepEqual(joined, whole);
  processor.restore(loopState);
  assert.deepEqual(processor.process([input[0].slice(loopAt, loopAt + 4093)], loopAt)[0],
    whole.slice(loopAt, loopAt + 4093));
  const seek = rate;
  const seekProcessor = createStreamingEditChain(modules, rate, count);
  seekProcessor.process([input[0].slice(0, seek)], 0);
  assert.deepEqual(seekProcessor.process([input[0].slice(seek, seek + 4093)], seek)[0],
    whole.slice(seek, seek + 4093));
});

test('file-backed chunked export matches in-memory output and preserves source bytes', async () => {
  const rate = 44100, count = rate * 2, modules = makeProcessingChain([]);
  const input = [0, 1].map((channel) => Float32Array.from({ length: count }, (_, i) =>
    (channel ? -.12 : .17) + .45 * Math.sin(2 * Math.PI * 20 * i / rate + channel * .3)));
  const file = encodeWav({ channels: input, sampleRate: rate, duration: 2, name: 'original.wav' });
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const metadata = await parseWavMetadata(file);
  const processor = createStreamingEditChain(modules, rate, count);
  const parts = [];
  const stream = { write: async (part) => { parts.push(part); }, close: async () => {}, abort: async () => {} };
  await writeFloat32WavChunks(stream, {
    channels: 2, sampleRate: rate, frameCount: count, chunkFrames: 4093,
    readFrames: (start, frames) => readFrames(file, metadata, start, frames),
    processFrames: (channels, start) => processor.process(channels, start),
  });
  const exported = parseWav(await new Blob(parts).arrayBuffer()).channels;
  const memory = renderChain(input, modules, rate);
  for (let channel = 0; channel < 2; channel++) assert.deepEqual(exported[channel], memory[channel]);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), originalBytes);
});

test('96 kHz stereo wind compensation export and restored playback match finite in-memory audio', async () => {
  const rate = 96000, count = rate * 4;
  const input = highRateWindSource(rate);
  const wind = makeModule('wind', {
    params: {
      lowEndEnabled: 1, lowEndScope: 'Detected wind only', lowEndGain: 8,
      compensationAttackMs: 95, compensationReleaseMs: 520,
    },
  });
  const processingModules = makeProcessingChain([wind]);
  const memory = renderChain(input, processingModules, rate);
  assert.ok(memory.every((channel) => channel.every(Number.isFinite)),
    'in-memory compensation must remain finite on high-rate stereo input');
  const file = encodeWav({ channels: input, sampleRate: rate, duration: 4, name: 'high-rate-wind.wav' });
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const metadata = await parseWavMetadata(file);
  const events = [];
  const processor = createStreamingEditChain(processingModules, rate, count, 0, [], undefined,
    (_id, frame, active) => events.push({ frame, active }));
  const parts = [];
  await writeFloat32WavChunks({ write: async (part) => { parts.push(part); }, close: async () => {}, abort: async () => {} }, {
    channels: 2, sampleRate: rate, frameCount: count, chunkFrames: 4093,
    readFrames: (start, frames) => readFrames(file, metadata, start, frames),
    processFrames: (channels, start) => processor.process(channels, start),
  });
  const exported = parseWav(await new Blob(parts).arrayBuffer()).channels;
  assert.ok(events.some(({ frame, active }) => active && frame >= rate && frame < rate * 3),
    'the streamed high-rate gust should be detected');
  assert.ok(events.some(({ frame, active }) => !active && frame > rate * 3),
    'the streamed detector should release after the gust');
  for (let channel = 0; channel < 2; channel++) {
    assert.ok(exported[channel].every(Number.isFinite), 'exported compensation must remain finite');
    assert.deepEqual(exported[channel], memory[channel],
      'high-rate file-backed export must match in-memory rendering sample-for-sample');
  }
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), originalBytes, 'processing must not modify source audio');

  const loopStart = rate * 2;
  const playback = createStreamingEditChain(processingModules, rate, count);
  for (let start = 0; start < loopStart; start += 4093) {
    const frames = Math.min(4093, loopStart - start);
    playback.process(await readFrames(file, metadata, start, frames), start);
  }
  const snapshot = playback.snapshot();
  const loopInput = await readFrames(file, metadata, loopStart, 4093);
  const firstPass = playback.process(loopInput, loopStart);
  firstPass.forEach((channel, index) =>
    assert.deepEqual(channel, memory[index].slice(loopStart, loopStart + channel.length),
      'high-rate loop playback must match in-memory rendering'));
  playback.restore(snapshot);
  assert.deepEqual(playback.process(loopInput, loopStart), firstPass,
    'restoring a high-rate loop must retain detector and compensation state');
});

test('file-backed detected-wind compensation export and restored playback match memory', async () => {
  const rate = 24000, count = rate * 4;
  const input = [0, 1].map((channel) => {
    let seed = 12345 + channel * 17;
    let low = 0;
    let slow = 0;
    return Float32Array.from({ length: count }, (_, frame) => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      const random = (seed / 0xffffffff - .5) * 2;
      low += .035 * (random - low);
      slow += .001 * (low - slow);
      const gust = frame >= rate && frame < rate * 3 ? (low - slow) * 1.4 : 0;
      return gust + .045 * Math.sin(2 * Math.PI * 530 * frame / rate + channel * .2);
    });
  });
  const wind = makeModule('wind', {
    params: {
      lowEndEnabled: 1, lowEndScope: 'Detected wind only', lowEndGain: 8,
      compensationAttackMs: 95, compensationReleaseMs: 520,
    },
  });
  const processingModules = makeProcessingChain([wind]);
  const memory = renderChain(input, processingModules, rate);
  const file = encodeWav({ channels: input, sampleRate: rate, duration: 4, name: 'wind-compensation.wav' });
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const metadata = await parseWavMetadata(file);
  const processor = createStreamingEditChain(processingModules, rate, count);
  const parts = [];
  await writeFloat32WavChunks({ write: async (part) => { parts.push(part); }, close: async () => {}, abort: async () => {} }, {
    channels: 2, sampleRate: rate, frameCount: count, chunkFrames: 4093,
    readFrames: (start, frames) => readFrames(file, metadata, start, frames),
    processFrames: (channels, start) => processor.process(channels, start),
  });
  const exported = parseWav(await new Blob(parts).arrayBuffer()).channels;
  for (let channel = 0; channel < 2; channel++) assert.deepEqual(exported[channel], memory[channel]);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), originalBytes, 'processing must not modify source audio');

  const loopStart = rate * 2;
  const playback = createStreamingEditChain(processingModules, rate, count);
  for (let start = 0; start < loopStart; start += 4093) {
    const frames = Math.min(4093, loopStart - start);
    playback.process(await readFrames(file, metadata, start, frames), start);
  }
  const snapshot = playback.snapshot();
  const loopInput = await readFrames(file, metadata, loopStart, 4093);
  const firstPass = playback.process(loopInput, loopStart);
  firstPass.forEach((channel, index) =>
    assert.deepEqual(channel, memory[index].slice(loopStart, loopStart + channel.length)));
  playback.restore(snapshot);
  assert.deepEqual(playback.process(loopInput, loopStart), firstPass,
    'restoring the loop must retain wind and compensation state');
});

function toneLevel(samples, frequency, from = 0) {
  let sine = 0;
  let cosine = 0;
  for (let i = from; i < samples.length; i++) {
    const phase = 2 * Math.PI * frequency * i / sampleRate;
    sine += samples[i] * Math.sin(phase);
    cosine += samples[i] * Math.cos(phase);
  }
  return 2 * Math.hypot(sine, cosine) / (samples.length - from);
}

test('confirmed opening tones are filtered from frame zero across memory, chunks, and restored loops', () => {
  const count = sampleRate * 3;
  const input = [0, 1].map((channel) => Float32Array.from({ length: count }, (_, i) =>
    .13 * Math.sin(2 * Math.PI * 73 * i / sampleRate + channel * .3) +
    .07 * Math.sin(2 * Math.PI * 146 * i / sampleRate + channel * .3) +
    .1 * Math.sin(2 * Math.PI * 510 * i / sampleRate),
  ));
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', frequency: 60, reduction: 18 } };
  const seeds = analyzeInitialHum(input, [hum], sampleRate, count);
  assert.ok(seeds[0].some((frequency) => Math.abs(frequency - 73) < 2));
  const whole = renderChain(input, [hum], sampleRate);
  const openingEnd = Math.floor(sampleRate * .24);
  for (let channel = 0; channel < 2; channel++) {
    assert.ok(toneLevel(whole[channel].slice(0, openingEnd), 73) < toneLevel(input[channel].slice(0, openingEnd), 73) * .75, 'opening hum should fall');
    assert.ok(toneLevel(whole[channel].slice(0, openingEnd), 510) < toneLevel(input[channel].slice(0, openingEnd), 510) * .75, 'unrelated sustained tone should also fall');
  }
  const window = humAnalysisWindowSize(sampleRate);
  for (let segment = 0; segment < 3; segment++) {
    const from = segment * window;
    const to = from + window;
    assert.ok(toneLevel(whole[0].slice(from, to), 73, 0) <
      toneLevel(input[0].slice(from, to), 73, 0) * .75,
    `persistent hum should remain filtered in analysis window ${segment + 1}`);
  }
  const streamed = input.map(() => new Float32Array(count));
  const processor = createStreamingEditChain([hum], sampleRate, count, 0, seeds);
  const loopFrame = 4093 * 3;
  let loopState;
  for (let start = 0; start < count; start += 4093) {
    if (start === loopFrame) loopState = processor.snapshot();
    processor.process(input.map((channel) => channel.slice(start, start + 4093)), start)
      .forEach((channel, index) => streamed[index].set(channel, start));
  }
  assert.deepEqual(streamed, whole);
  processor.restore(loopState);
  assert.deepEqual(processor.process(input.map((channel) => channel.slice(loopFrame, loopFrame + 4093)), loopFrame),
    whole.map((channel) => channel.slice(loopFrame, loopFrame + 4093)));
});

test('opening scan does not invent tones from silence or a short take, but detects a lone sustained tone', () => {
  const count = sampleRate;
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', frequency: 60, reduction: 18 } };
  const silence = [new Float32Array(count)];
  const wanted = [Float32Array.from({ length: count }, (_, i) => .13 * Math.sin(2 * Math.PI * 230 * i / sampleRate))];
  const short = [Float32Array.from({ length: humAnalysisWindowSize(sampleRate) }, (_, i) => .13 * Math.sin(2 * Math.PI * 60 * i / sampleRate))];
  for (const input of [silence, short]) {
    assert.deepEqual(analyzeInitialHum(input, [hum], sampleRate, input[0].length), [[]]);
    assert.deepEqual(renderChain(input, [hum], sampleRate), input);
  }
  assert.ok(analyzeInitialHum(wanted, [hum], sampleRate, count)[0].some((frequency) => Math.abs(frequency - 230) < 2));
  assert.ok(toneLevel(renderChain(wanted, [hum], sampleRate)[0], 230) < toneLevel(wanted[0], 230) * .75);
});

test('file-backed opening scan reads only the prefix and matches in-memory detection', async () => {
  const count = sampleRate * 3;
  const input = [Float32Array.from({ length: count }, (_, i) =>
    .12 * Math.sin(2 * Math.PI * 50 * i / sampleRate) + .1 * Math.sin(2 * Math.PI * 500 * i / sampleRate))];
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', reduction: 18 } };
  const header = generateFloat32WavHeader({ channels: 1, sampleRate, frameCount: count });
  const file = new Blob([header, input[0]]);
  const metadata = await parseWavMetadata(file);
  const seeds = await analyzeFileInitialHum(file, metadata, [hum]);
  assert.deepEqual(seeds, analyzeInitialHum(input, [hum], sampleRate, count));
  const output = createStreamingEditChain([hum], sampleRate, count, 0, seeds).process(input, 0)[0];
  assert.deepEqual(output, renderChain(input, [hum], sampleRate)[0]);
  assert.ok(toneLevel(output.slice(0, sampleRate / 4), 50) < toneLevel(input[0].slice(0, sampleRate / 4), 50) * .75);
  assert.ok(toneLevel(output.slice(0, sampleRate / 4), 500) < toneLevel(input[0].slice(0, sampleRate / 4), 500) * .75);
});

test('opening scan readout distinguishes estimates, absence, unavailable scans and bypass', async () => {
  const count = sampleRate * 3;
  const input = [Float32Array.from({ length: count }, (_, i) =>
    .12 * Math.sin(2 * Math.PI * 73 * i / sampleRate) +
    .06 * Math.sin(2 * Math.PI * 146 * i / sampleRate))];
  const hum = { id: 'hum', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', reduction: 18 } };
  const memory = analyzeInitialHum(input, [hum], sampleRate, count);
  const file = new Blob([generateFloat32WavHeader({ channels: 1, sampleRate, frameCount: count }), input[0]]);
  const metadata = await parseWavMetadata(file);
  const backed = await analyzeFileInitialHum(file, metadata, [hum]);
  assert.deepEqual(backed, memory);
  const confirmed = humOpeningReadout(hum, 'complete', backed[0]);
  assert.match(confirmed.detail, /Opening scan confirmed hum/);
  assert.match(confirmed.detail, /73\.\d Hz, 146\.\d Hz/);
  assert.match(confirmed.summary, /~73 Hz \+1/);
  assert.match(humOpeningReadout(hum, 'complete', []).detail, /no confirmed interference/);
  assert.match(humOpeningReadout(hum, 'too-short').detail, /too short/);
  assert.match(humOpeningReadout(hum, 'unavailable').detail, /Relink/);
  assert.match(humOpeningReadout({ ...hum, enabled: false }, 'complete', backed[0]).detail, /bypassed/);
  assert.match(humOpeningReadout({ ...hum, params: { ...hum.params, reduction: 0 } }, 'complete', backed[0]).detail, /disabled/);
  assert.match(humOpeningReadout({ ...hum, params: { ...hum.params, mode: 'Static', frequency: 60 } }, 'complete', backed[0]).detail, /Manual frequency/);
});

test('live hum decisions follow playback frames equally in memory and bounded file chunks', async () => {
  const count = sampleRate * 5;
  const changeFrame = sampleRate * 2;
  const input = [Float32Array.from({ length: count }, (_, i) => {
    const frequency = i < changeFrame ? 73 : 83;
    return .12 * Math.sin(2 * Math.PI * frequency * i / sampleRate) +
      .06 * Math.sin(2 * Math.PI * frequency * 2 * i / sampleRate);
  })];
  const hum = { id: 'hum', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', reduction: 18 } };
  const seeds = analyzeInitialHum(input, [hum], sampleRate, count);
  assert.ok(seeds[0].some((frequency) => Math.abs(frequency - 73) < 2));
  const memoryEvents = [];
  const memory = renderChain(input, [hum], sampleRate, {}, seeds,
    (moduleId, frame, frequencies) => memoryEvents.push({ moduleId, frame, frequencies }));
  const file = new Blob([generateFloat32WavHeader({ channels: 1, sampleRate, frameCount: count }), input[0]]);
  const metadata = await parseWavMetadata(file);
  assert.deepEqual(await analyzeFileInitialHum(file, metadata, [hum]), seeds);
  const fileEvents = [];
  const processor = createStreamingEditChain([hum], sampleRate, count, 0, seeds,
    (moduleId, frame, frequencies) => fileEvents.push({ moduleId, frame, frequencies }));
  const streamed = new Float32Array(count);
  for (let frame = 0; frame < count; frame += 4093) {
    const chunk = await file.slice(metadata.dataOffset + frame * 4,
      metadata.dataOffset + Math.min(count, frame + 4093) * 4).arrayBuffer();
    streamed.set(processor.process([new Float32Array(chunk)], frame)[0], frame);
  }
  assert.deepEqual(streamed, memory[0]);
  assert.deepEqual(fileEvents, memoryEvents);
  assert.ok(fileEvents.some((event) => event.frame > changeFrame &&
    event.frequencies.some((frequency) => Math.abs(frequency - 83) < 2)));
  assert.ok(processor.trackedHumFrequencies().hum.some((frequency) => Math.abs(frequency - 83) < 2));
  processor.reset();
  assert.deepEqual(processor.trackedHumFrequencies().hum, seeds[0]);
});

test('adaptive mode attenuates non-mains hum, harmonics, and unrelated sustained tones', () => {
  const count = sampleRate * 2;
  const input = [0, 1].map((channel) => Float32Array.from({ length: count }, (_, i) =>
    .1 * Math.sin(2 * Math.PI * 73 * i / sampleRate + channel * 1.7) +
    .05 * Math.sin(2 * Math.PI * 146 * i / sampleRate + channel * 1.7) +
    .12 * Math.sin(2 * Math.PI * 510 * i / sampleRate + channel * .6),
  ));
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', frequency: 60, reduction: 18 } };
  const output = createStreamingEditChain([hum], sampleRate, count).process(input, 0);
  const measuredFrom = count - sampleRate / 2;
  for (let channel = 0; channel < 2; channel++) {
    assert.ok(toneLevel(output[channel], 73, measuredFrom) < toneLevel(input[channel], 73, measuredFrom) * .55, 'fundamental should fall');
    assert.ok(toneLevel(output[channel], 146, measuredFrom) < toneLevel(input[channel], 146, measuredFrom) * .7, 'harmonic should fall');
    assert.ok(toneLevel(output[channel], 510, measuredFrom) < toneLevel(input[channel], 510, measuredFrom) * .7, 'unrelated sustained tone should fall');
  }
  assert.deepEqual(createStreamingEditChain([{ ...hum, enabled: false }], sampleRate, count).process(input, 0), input);
});

test('adaptive mode covers standard 50 Hz hum without a manual frequency', () => {
  const count = sampleRate * 2;
  const input = [Float32Array.from({ length: count }, (_, i) =>
    .12 * Math.sin(2 * Math.PI * 50 * i / sampleRate) +
    .08 * Math.sin(2 * Math.PI * 500 * i / sampleRate),
  )];
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', frequency: 60, reduction: 18 } };
  const output = createStreamingEditChain([hum], sampleRate, count).process(input, 0);
  const from = count - sampleRate / 2;
  assert.ok(toneLevel(output[0], 50, from) < toneLevel(input[0], 50, from) * .55);
  assert.ok(toneLevel(output[0], 500, from) < toneLevel(input[0], 500, from) * .7);
});

test('adaptive detection and filter history agree across chunks, render routes, and restored loops', () => {
  const count = sampleRate * 2;
  const input = [0, 1].map((channel) => Float32Array.from({ length: count }, (_, i) =>
    .11 * Math.sin(2 * Math.PI * 137 * i / sampleRate + channel * .8) +
    .05 * Math.sin(2 * Math.PI * 274 * i / sampleRate + channel * .8) +
    .08 * Math.sin(2 * Math.PI * 530 * i / sampleRate),
  ));
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', frequency: 60, reduction: 16 } };
  const seeds = analyzeInitialHum(input, [hum], sampleRate, count);
  const whole = createStreamingEditChain([hum], sampleRate, count, 0, seeds).process(input, 0);
  const memory = renderChain(input, [hum], sampleRate);
  assert.deepEqual(memory, whole);
  const chunked = input.map(() => new Float32Array(count));
  const processor = createStreamingEditChain([hum], sampleRate, count, 0, seeds);
  for (let start = 0; start < count; start += 4093) {
    const end = Math.min(count, start + 4093);
    processor.process(input.map((channel) => channel.slice(start, end)), start)
      .forEach((channel, index) => chunked[index].set(channel, start));
  }
  assert.deepEqual(chunked, whole);
  const warmed = processor.snapshot();
  const loop = input.map((channel) => channel.slice(0, 1000));
  const first = processor.process(loop, count);
  processor.restore(warmed);
  assert.deepEqual(processor.process(loop, count), first);
  assert.ok(toneLevel(whole[0], 137, count - sampleRate / 2) < toneLevel(input[0], 137, count - sampleRate / 2) * .7);
});

test('adaptive detection does not follow a short wanted tone in the scan band', () => {
  const count = sampleRate * 2;
  const transientStart = sampleRate * 1.4;
  const transientEnd = transientStart + sampleRate * .04;
  const input = [Float32Array.from({ length: count }, (_, i) =>
    .1 * Math.sin(2 * Math.PI * 83 * i / sampleRate) +
    .05 * Math.sin(2 * Math.PI * 166 * i / sampleRate) +
    (i >= transientStart && i < transientEnd ? .17 * Math.sin(2 * Math.PI * 250 * i / sampleRate) : 0),
  )];
  const module = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', reduction: 18, frequency: 60 } };
  const output = createStreamingEditChain([module], sampleRate, count).process(input, 0);
  const before = toneLevel(input[0].slice(transientStart, transientEnd), 250);
  const after = toneLevel(output[0].slice(transientStart, transientEnd), 250);
  assert.ok(after > before * .95, 'brief wanted tone should survive');
  assert.ok(toneLevel(output[0], 83, count - sampleRate / 2) < toneLevel(input[0], 83, count - sampleRate / 2) * .7);
});

test('adaptive removes a lone sustained tone without a harmonic or mains match', () => {
  const count = sampleRate * 2;
  const input = [Float32Array.from({ length: count }, (_, i) => .13 * Math.sin(2 * Math.PI * 230 * i / sampleRate))];
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', frequency: 60, reduction: 18 } };
  const output = createStreamingEditChain([hum], sampleRate, count).process(input, 0)[0];
  assert.ok(toneLevel(output, 230, count - sampleRate / 2) < toneLevel(input[0], 230, count - sampleRate / 2) * .55);
});

test('adaptive filters a stronger unrelated steady tone as well as a harmonic family', () => {
  const count = sampleRate * 2;
  const input = [Float32Array.from({ length: count }, (_, i) =>
    .16 * Math.sin(2 * Math.PI * 230 * i / sampleRate) +
    .09 * Math.sin(2 * Math.PI * 73 * i / sampleRate) +
    .05 * Math.sin(2 * Math.PI * 146 * i / sampleRate),
  )];
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', frequency: 60, reduction: 18 } };
  const output = createStreamingEditChain([hum], sampleRate, count).process(input, 0);
  const from = count - sampleRate / 2;
  assert.ok(toneLevel(output[0], 73, from) < toneLevel(input[0], 73, from) * .65);
  assert.ok(toneLevel(output[0], 230, from) < toneLevel(input[0], 230, from) * .65);
});

test('demo Adaptive removes all four independent sustained tones in memory and file-backed chunks', async () => {
  const demo = createDemoAudio(sampleRate, 3);
  const count = demo.channels[0].length;
  const original = demo.channels.map((channel) => new Float32Array(channel));
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', reduction: 22 } };
  const seeds = analyzeInitialHum(demo.channels, [hum], sampleRate, count);
  assert.equal(seeds[0].length, 4, `expected all demo tones, got ${seeds[0]}`);
  const memory = renderChain(demo.channels, [hum], sampleRate);
  const frame = count - sampleRate / 2;
  for (const frequency of [82, 124, 220, 327]) {
    assert.ok(seeds[0].some((detected) => Math.abs(detected - frequency) < 2), `missing ${frequency} Hz`);
    for (let channel = 0; channel < 2; channel++) {
      const before = toneLevel(demo.channels[channel], frequency, frame);
      const after = toneLevel(memory[channel], frequency, frame);
      assert.ok(20 * Math.log10(after / before) < -18, `${frequency} Hz channel ${channel}: insufficient attenuation`);
    }
  }
  const readout = humOpeningReadout(hum, 'complete', seeds[0]);
  assert.match(readout.summary, /\+3/);
  for (const frequency of [82, 124, 220, 327]) assert.match(readout.detail, new RegExp(`${frequency}\\.`));
  const file = encodeWav(demo);
  const metadata = await parseWavMetadata(file);
  assert.deepEqual(await analyzeFileInitialHum(file, metadata, [hum]), seeds);
  const streamed = demo.channels.map(() => new Float32Array(count));
  const processor = createStreamingEditChain([hum], sampleRate, count, 0, seeds);
  for (let start = 0; start < count; start += 4093) {
    const end = Math.min(count, start + 4093);
    const chunk = await readFrames(file, metadata, start, end - start);
    processor.process(chunk, start).forEach((channel, index) => streamed[index].set(channel, start));
  }
  assert.deepEqual(streamed, memory);
  assert.deepEqual(demo.channels, original, 'the original is not changed');
  assert.deepEqual(createStreamingEditChain([{ ...hum, enabled: false }], sampleRate, count).process(demo.channels, 0), original);
});

test('adaptive filters a sustained higher tone but not a changing chirp', () => {
  const count = sampleRate * 3;
  const input = [Float32Array.from({ length: count }, (_, i) => {
    const time = i / sampleRate;
    return .1 * Math.sin(2 * Math.PI * 1500 * time) +
      .09 * Math.sin(2 * Math.PI * (2200 * time + 200 * time * time));
  })];
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', reduction: 22 } };
  const seeds = analyzeInitialHum(input, [hum], sampleRate, count);
  assert.equal(seeds[0].length, 1, `chirp should not be classified as sustained: ${seeds[0]}`);
  assert.ok(Math.abs(seeds[0][0] - 1500) < 2);
  const output = renderChain(input, [hum], sampleRate)[0];
  assert.ok(toneLevel(output, 1500, count - sampleRate / 2) < toneLevel(input[0], 1500, count - sampleRate / 2) * .2);
});

test('adaptive includes 20 Hz and 20 kHz boundaries at common sample rates', () => {
  for (const [rate, frequency] of [[44100, 20], [44100, 20000], [48000, 20000], [96000, 20000]]) {
    const count = 2 * humAnalysisWindowSize(rate);
    const input = [Float32Array.from({ length: count }, (_, frame) =>
      .15 * Math.sin(2 * Math.PI * frequency * frame / rate))];
    const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', reduction: 22 } };
    const seeds = analyzeInitialHum(input, [hum], rate, count);
    assert.ok(seeds[0].some((detected) => Math.abs(detected - frequency) < 2),
      `${rate} Hz source: missing sustained ${frequency} Hz at the analysis boundary`);
    const output = renderChain(input, [hum], rate)[0];
    const start = Math.floor(rate / 8);
    const frames = Math.floor(rate / 2);
    assert.ok(measuredTone(output, rate, frequency, start, frames) <
      measuredTone(input[0], rate, frequency, start, frames) * .3,
    `${rate} Hz source: insufficient attenuation at ${frequency} Hz`);
  }
});

test('adaptive does not confirm a tone that changes slightly between analysis windows', () => {
  const window = humAnalysisWindowSize(sampleRate);
  const input = [Float32Array.from({ length: window * 2 }, (_, frame) => {
    const frequency = frame < window ? 500 : 502;
    const cycles = frame < window ? 500 * frame / sampleRate :
      500 * window / sampleRate + 502 * (frame - window) / sampleRate;
    return .12 * Math.sin(2 * Math.PI * cycles);
  })];
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', reduction: 22 } };
  assert.deepEqual(analyzeInitialHum(input, [hum], sampleRate, input[0].length), [[]]);
  assert.deepEqual(renderChain(input, [hum], sampleRate), input);
});

test('aligned mid-file preview agrees with processing from the beginning', () => {
  const count = sampleRate * 6;
  const input = [Float32Array.from({ length: count }, (_, i) =>
    .1 * Math.sin(2 * Math.PI * 73 * i / sampleRate) +
    .05 * Math.sin(2 * Math.PI * 146 * i / sampleRate) +
    .12 * Math.sin(2 * Math.PI * 530 * i / sampleRate),
  )];
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', frequency: 60, reduction: 18 } };
  const seeds = analyzeInitialHum(input, [hum], sampleRate, count);
  const exportAudio = createStreamingEditChain([hum], sampleRate, count, 0, seeds).process(input, 0)[0];
  const seek = sampleRate * 5;
  const window = humAnalysisWindowSize(sampleRate);
  const warmStart = Math.floor(Math.max(0, seek - sampleRate * 2) / window) * window;
  const preview = createStreamingEditChain([hum], sampleRate, count, warmStart, seeds);
  preview.process([input[0].slice(warmStart, seek)], warmStart);
  const resumed = preview.process([input[0].slice(seek)], seek)[0];
  let difference = 0;
  for (let i = Math.floor(sampleRate * .05); i < resumed.length; i++) difference = Math.max(difference, Math.abs(resumed[i] - exportAudio[seek + i]));
  assert.ok(difference < 1e-4, `mid-file preview differs by ${difference}`);
});

test('static mode removes the selected fundamental, and dynamic tracks nearby drift', () => {
  const count = sampleRate * 2;
  const input = [Float32Array.from({ length: count }, (_, i) =>
    .12 * Math.sin(2 * Math.PI * 63 * i / sampleRate) + .1 * Math.sin(2 * Math.PI * 600 * i / sampleRate),
  )];
  const params = { frequency: 60, reduction: 18 };
  const staticOutput = createStreamingEditChain([{ id: 'static', type: 'hum', name: 'Hum', enabled: true, params: { ...params, mode: 'Static' } }], sampleRate, count).process(input, 0);
  const dynamicOutput = createStreamingEditChain([{ id: 'dynamic', type: 'hum', name: 'Hum', enabled: true, params: { ...params, mode: 'Dynamic' } }], sampleRate, count).process(input, 0);
  const from = count - sampleRate / 2;
  assert.ok(toneLevel(dynamicOutput[0], 63, from) < toneLevel(staticOutput[0], 63, from) * .8);
  assert.ok(toneLevel(dynamicOutput[0], 600, from) > toneLevel(input[0], 600, from) * .95);
});
