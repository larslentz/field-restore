import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, parseWav } from './audio.ts';
import { makeModule, makeProcessingChain, renderChain } from './edit-chain.ts';
import { parseAudioMetadata, readAudioFrames } from './source-audio.ts';
import { createStreamingEditChain } from './streaming-edit-chain.ts';
import { prepareSpectralRepairs } from './prepare-spectral-repairs.ts';
import { writeFloat32WavChunks } from './large-wav.ts';
import { projectFromSource } from './persistence.ts';
import { parseChainPresets, saveChainPreset } from './chain-presets.ts';

test('late repairs warm the prefix once and match in-memory edits after stateful upstream filters', async (t) => {
  const rate = 8000;
  const frames = rate * 60;
  const input = [Float32Array.from({ length: frames }, (_, i) =>
    .07 + .15 * Math.sin(i * .041) + (i > rate * 49 ? .08 * Math.sin(i * .87) : 0))];
  const repairs = [50, 54].map((start) => makeModule('spectral-repair', { params: {
    start, end: start + .18, low: 800, high: 1500, mode: 'Replace', strength: 72, context: .18, weighting: 50,
  } }));
  const modules = makeProcessingChain([
    makeModule('eq', { params: { mode: 'low-shelf', frequency: 75, q: .5, gain: 3 } }),
    repairs[0], makeModule('gain', { params: { db: -1 } }), repairs[1],
  ]);
  const expected = renderChain(input, modules, rate);
  const source = encodeWav({ channels: input, sampleRate: rate, duration: 60, name: 'late.wav' });
  const metadata = await parseAudioMetadata(source);
  let bytesRead = 0;
  // All WAV data reads pass through slice; count them without changing the source.
  const measured = new Proxy(source, {
    get(target, key) {
      if (key === 'slice') return (start, end, type) => {
        bytesRead += Math.max(0, Math.min(target.size, end ?? target.size) - (start ?? 0));
        return target.slice(start, end, type);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const began = performance.now();
  const patches = await prepareSpectralRepairs(measured, metadata, modules);
  const elapsed = performance.now() - began;
  t.diagnostic(`60-second source, repairs at 50s and 54s: ${(bytesRead / source.size).toFixed(2)} source lengths read in ${elapsed.toFixed(0)} ms`);
  assert.ok(bytesRead < source.size * 1.3,
    `late preparation read ${(bytesRead / source.size).toFixed(2)} source lengths in ${elapsed.toFixed(0)} ms`);
  const stream = createStreamingEditChain(modules, rate, frames, 0, [], undefined, undefined, undefined, patches);
  for (let frame = 0; frame < frames; frame += 4093) {
    const actual = stream.process(await readAudioFrames(source, metadata, frame, Math.min(4093, frames - frame)), frame)[0];
    for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i] - expected[0][frame + i]) < 2e-5,
      `late parity at frame ${frame + i}: ${actual[i]} vs ${expected[0][frame + i]}`);
  }
  const seek = rate * 53;
  const seekStream = createStreamingEditChain(modules, rate, frames, 0, [], undefined, undefined, undefined, patches);
  for (let frame = 0; frame < seek; frame += 4093) {
    seekStream.process(await readAudioFrames(source, metadata, frame, Math.min(4093, seek - frame)), frame);
  }
  const loop = seekStream.snapshot();
  const selection = await readAudioFrames(source, metadata, seek, 2000);
  const first = seekStream.process(selection, seek);
  seekStream.restore(loop);
  assert.deepEqual(seekStream.process(selection, seek), first, 'seek/loop replay preserves the prepared patch');
  assert.ok(Number.isFinite(elapsed));
});

test('history-free edits start at the late selection without reading the prefix', async () => {
  const rate = 8000;
  const frames = rate * 90;
  const input = [Float32Array.from({ length: frames }, (_, i) => .12 * Math.sin(i * .13))];
  const repair = makeModule('spectral-repair', { params: {
    start: 85, end: 85.15, low: 900, high: 1700, mode: 'Attenuate', strength: 65, context: .15,
  } });
  const modules = [makeModule('gain', { params: { db: -2 } }), repair];
  const source = encodeWav({ channels: input, sampleRate: rate, duration: 90, name: 'late.wav' });
  const metadata = await parseAudioMetadata(source);
  let earliest = source.size;
  const measured = new Proxy(source, {
    get(target, key) {
      if (key === 'slice') return (start, end, type) => {
        earliest = Math.min(earliest, start);
        return target.slice(start, end, type);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const patches = await prepareSpectralRepairs(measured, metadata, modules);
  assert.ok(earliest > source.size * .9, 'a history-free late repair should not decode the prefix');
  const expected = renderChain(input, modules, rate);
  const frame = rate * 85;
  const actual = createStreamingEditChain(modules, rate, frames, frame, [], undefined, undefined, undefined, patches)
    .process(await readAudioFrames(source, metadata, frame, 2000), frame)[0];
  actual.forEach((sample, i) => assert.ok(Math.abs(sample - expected[0][frame + i]) < 2e-5));
});

test('repairs in reverse timeline order still honor module order', async () => {
  const rate = 8000;
  const frames = rate * 5;
  const input = [Float32Array.from({ length: frames }, (_, i) => .09 + .16 * Math.sin(i * .08))];
  const repair = (start) => makeModule('spectral-repair', { params: {
    start, end: start + .2, low: 1000, high: 1800, mode: 'Replace', strength: 70, context: .1,
  } });
  const modules = makeProcessingChain([repair(3), makeModule('gain', { params: { db: -2 } }), repair(1)]);
  const source = encodeWav({ channels: input, sampleRate: rate, duration: 5, name: 'reverse.wav' });
  const metadata = await parseAudioMetadata(source);
  const patches = await prepareSpectralRepairs(source, metadata, modules);
  const actual = createStreamingEditChain(modules, rate, frames, 0, [], undefined, undefined, undefined, patches)
    .process(await readAudioFrames(source, metadata, 0, frames), 0)[0];
  const expected = renderChain(input, modules, rate)[0];
  actual.forEach((sample, i) => assert.ok(Math.abs(sample - expected[i]) < 2e-5, `reverse parity at ${i}`));
});

test('bounded spectral preparation matches in-memory render through chunks, seeks and WAV export', async () => {
  const sampleRate = 8000;
  const frames = sampleRate * 4;
  const input = [0, 1].map((channel) => Float32Array.from({ length: frames }, (_, i) =>
    .18 * Math.sin(2 * Math.PI * (channel ? 350 : 270) * i / sampleRate) +
    (i >= sampleRate * 2 && i < sampleRate * 2.4 ? .25 * Math.sin(2 * Math.PI * 1500 * i / sampleRate) : 0)));
  const spectral = makeModule('spectral-repair', { params: {
    start: 2, end: 2.4, low: 1200, high: 1800, mode: 'Attenuate', strength: 80, context: .16, weighting: 50,
  } });
  const chain = makeProcessingChain([spectral]);
  const expected = renderChain(input, chain, sampleRate);
  const file = encodeWav({ channels: input, sampleRate, duration: 4, name: 'field.wav' });
  const original = new Uint8Array(await file.arrayBuffer());
  const metadata = await parseAudioMetadata(file);
  const patches = await prepareSpectralRepairs(file, metadata, chain);
  assert.equal(patches[spectral.id].channels.length, 2);
  assert.ok(patches[spectral.id].channels[0].length < frames / 2, 'patch should stay bounded to the selection');
  const stream = createStreamingEditChain(chain, sampleRate, frames, 0, [], undefined, undefined, undefined, patches);
  const streamed = input.map(() => new Float32Array(frames));
  let snapshot;
  for (let start = 0; start < frames; start += 257) {
    if (start === 0) snapshot = stream.snapshot();
    const chunk = await readAudioFrames(file, metadata, start, Math.min(257, frames - start));
    stream.process(chunk, start).forEach((channel, index) => streamed[index].set(channel, start));
  }
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < frames; i++) assert.ok(Math.abs(streamed[c][i] - expected[c][i]) < 2e-5,
      `route mismatch at channel ${c}, frame ${i}: ${streamed[c][i]} vs ${expected[c][i]}`);
  }
  stream.restore(snapshot);
  const replay = stream.process(await readAudioFrames(file, metadata, 0, 257), 0);
  replay.forEach((channel, c) => assert.deepEqual(channel, streamed[c].slice(0, 257)));
  const chunks = [];
  const writer = { write: async (bytes) => { chunks.push(bytes); }, close: async () => {}, abort: async () => {} };
  const exportChain = createStreamingEditChain(chain, sampleRate, frames, 0, [], undefined, undefined, undefined, patches);
  await writeFloat32WavChunks(writer, {
    channels: 2, sampleRate, frameCount: frames, chunkFrames: 997,
    readFrames: (start, count) => readAudioFrames(file, metadata, start, count),
    processFrames: (channels, start) => exportChain.process(channels, start),
  });
  parseWav(await new Blob(chunks).arrayBuffer()).channels.forEach((channel, c) => assert.deepEqual(channel, streamed[c]));
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), original, 'source file should remain unchanged');
});

test('spectral repair settings survive project and preset serialization', () => {
  const module = makeModule('spectral-repair', { params: {
    start: .1, end: .6, low: 900, high: 1900, mode: 'Replace', strength: 63, context: .42, weighting: 22,
  } });
  const source = { name: 'source.wav', sampleRate: 8000, duration: 1, channels: [new Float32Array(8)] };
  const project = JSON.parse(JSON.stringify(projectFromSource(source, [module], [], [], 'Field', '')));
  assert.deepEqual(project.modules, [module]);
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  saveChainPreset(storage, 'Spectral cleanup', [module]);
  const preset = parseChainPresets(saved.get('field-restore-chain-presets-v1'))[0];
  assert.deepEqual(preset.modules, [module]);
});

test('a repair later in the source does not invalidate a shorter analysis range', async () => {
  const rate = 8000;
  const input = [Float32Array.from({ length: rate * 4 }, (_, i) => .1 * Math.sin(i * .3))];
  const module = makeModule('spectral-repair', { params: {
    start: 2, end: 2.2, low: 900, high: 1900, mode: 'Replace', strength: 70, context: .2, weighting: 50,
  } });
  const modules = makeProcessingChain([module]);
  const file = encodeWav({ channels: input, sampleRate: rate, duration: 4, name: 'shortened.wav' });
  const fullMetadata = await parseAudioMetadata(file);
  const patches = await prepareSpectralRepairs(file, fullMetadata, modules);
  const processor = createStreamingEditChain(modules, rate, fullMetadata.frameCount, 0, [],
    undefined, undefined, undefined, patches);
  const firstSecond = processor.process(await readAudioFrames(file, fullMetadata, 0, rate), 0);
  assert.equal(firstSecond[0].length, rate);
  assert.ok(firstSecond[0].every(Number.isFinite));
});