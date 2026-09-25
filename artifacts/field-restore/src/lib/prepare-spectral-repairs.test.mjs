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