import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeInitialHum, humOpeningReadout, makeProcessingChain, renderChain } from './edit-chain.ts';
import { analyzeFileInitialHum, createStreamingEditChain } from './streaming-edit-chain.ts';
import { humAnalysisWindowSize } from './hum-removal.ts';
import { generateFloat32WavHeader, parseWavMetadata } from './large-wav.ts';

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

  const constant = [Float32Array.from({ length: 4096 }, () => 0.2)];
  const output = createStreamingEditChain(processingModules, sampleRate, 4096).process(constant, 0);
  const tailMean = output[0].slice(-512).reduce((sum, value) => sum + value, 0) / 512;
  assert.ok(Math.abs(tailMean) < 0.001, `expected DC-corrected tail, received ${tailMean}`);
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

test('confirmed opening hum is filtered from frame zero across memory, chunks, and restored loops', () => {
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
    assert.ok(toneLevel(whole[channel].slice(0, openingEnd), 510) > toneLevel(input[channel].slice(0, openingEnd), 510) * .95, 'wanted opening tone should remain');
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

test('opening scan does not invent hum from silence, a lone wanted tone, or a short take', () => {
  const count = sampleRate;
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', frequency: 60, reduction: 18 } };
  const silence = [new Float32Array(count)];
  const wanted = [Float32Array.from({ length: count }, (_, i) => .13 * Math.sin(2 * Math.PI * 230 * i / sampleRate))];
  const short = [Float32Array.from({ length: humAnalysisWindowSize(sampleRate) }, (_, i) => .13 * Math.sin(2 * Math.PI * 60 * i / sampleRate))];
  for (const input of [silence, wanted, short]) {
    assert.deepEqual(analyzeInitialHum(input, [hum], sampleRate, input[0].length), [[]]);
    assert.deepEqual(renderChain(input, [hum], sampleRate), input);
  }
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

test('adaptive mode detects non-mains hum and harmonics without attenuating an unrelated tone', () => {
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
    assert.ok(toneLevel(output[channel], 510, measuredFrom) > toneLevel(input[channel], 510, measuredFrom) * .95, 'wanted tone should remain');
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
  assert.ok(toneLevel(output[0], 500, from) > toneLevel(input[0], 500, from) * .95);
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

test('adaptive leaves a lone sustained in-band wanted tone unchanged', () => {
  const count = sampleRate * 2;
  const input = [Float32Array.from({ length: count }, (_, i) => .13 * Math.sin(2 * Math.PI * 230 * i / sampleRate))];
  const hum = { id: 'adaptive', type: 'hum', name: 'Hum', enabled: true, params: { mode: 'Adaptive', frequency: 60, reduction: 18 } };
  assert.deepEqual(createStreamingEditChain([hum], sampleRate, count).process(input, 0), input);
});

test('adaptive favors confirmed hum over a stronger unrelated steady tone', () => {
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
  assert.ok(toneLevel(output[0], 230, from) > toneLevel(input[0], 230, from) * .95);
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
