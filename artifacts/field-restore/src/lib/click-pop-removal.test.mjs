import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, parseWav } from './audio.ts';
import { makeModule, makeProcessingChain, renderChain } from './edit-chain.ts';
import { createStreamingEditChain } from './streaming-edit-chain.ts';
import { parseWavMetadata, readFrames, writeFloat32WavChunks } from './large-wav.ts';
import { parseChainPresets, preparePresetModules } from './chain-presets.ts';

const rate = 48000;
const frames = rate;
const clickAt = 4093;
const popAt = 4093 * 3;
const wantedAt = 22000;

function recording() {
  const clean = [0, 1].map((channel) => Float32Array.from({ length: frames }, (_, i) => {
    const tone = .13 * Math.sin(2 * Math.PI * 330 * i / rate + channel * .4);
    const attack = i < wantedAt || i > wantedAt + 1500 ? 0 :
      .34 * Math.min(1, (i - wantedAt) / (rate * .002)) *
      Math.sin(2 * Math.PI * 1800 * (i - wantedAt) / rate);
    return tone + attack;
  }));
  const dirty = clean.map((channel) => new Float32Array(channel));
  dirty[0][clickAt] += .75;
  for (let i = 0; i < 270; i++) {
    const decay = Math.exp(-i / 55);
    dirty[0][popAt + i] += .45 * decay;
    dirty[1][popAt + i] += .32 * decay;
  }
  return { clean, dirty };
}

test('automatic repair reduces isolated clicks and pops without softening smooth wanted attacks or sustained tones', () => {
  const { clean, dirty } = recording();
  const original = dirty.map((channel) => new Float32Array(channel));
  const module = makeModule('click-pop');
  const processed = renderChain(dirty, [module], rate);
  assert.ok(Math.abs(processed[0][clickAt] - clean[0][clickAt]) < .27, 'single-frame click should fall');
  assert.equal(processed[1][clickAt], dirty[1][clickAt], 'clean opposite channel should not be changed');
  for (let channel = 0; channel < 2; channel++) {
    const before = Math.abs(dirty[channel][popAt] - clean[channel][popAt]);
    const after = Math.abs(processed[channel][popAt] - clean[channel][popAt]);
    assert.ok(after < before * .4, `channel ${channel} pop should fall`);
  }
  assert.deepEqual(renderChain(clean, [module], rate), clean,
    'loud but smooth attacks and ongoing tonal content are not defects');
  assert.deepEqual(renderChain(dirty, [{ ...module, enabled: false }], rate), dirty);
  assert.deepEqual(renderChain(dirty, [{ ...module, params: { strength: 0 } }], rate), dirty);
  assert.deepEqual(dirty, original, 'source stays immutable');
});

test('memory, bounded file chunks, snapshot loops, and WAV export use the same repair history', async () => {
  const { dirty } = recording();
  const module = makeModule('click-pop');
  const chain = makeProcessingChain([module]);
  const memory = renderChain(dirty, chain, rate);
  const file = encodeWav({ channels: dirty, sampleRate: rate, duration: 1, name: 'noisy.wav' });
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const metadata = await parseWavMetadata(file);
  const streamed = dirty.map(() => new Float32Array(frames));
  const processor = createStreamingEditChain(chain, rate, frames);
  let snapshot;
  for (let start = 0; start < frames; start += 4093) {
    if (start === popAt) snapshot = processor.snapshot();
    const chunk = await readFrames(file, metadata, start, Math.min(4093, frames - start));
    processor.process(chunk, start).forEach((channel, c) => streamed[c].set(channel, start));
  }
  assert.deepEqual(streamed, memory);
  processor.restore(snapshot);
  const repeated = processor.process(await readFrames(file, metadata, popAt, 4093), popAt);
  repeated.forEach((channel, c) => assert.deepEqual(channel, memory[c].slice(popAt, popAt + 4093)));
  const pieces = [];
  const createExportProcessor = createStreamingEditChain(chain, rate, frames);
  await writeFloat32WavChunks({
    write: async (piece) => { pieces.push(piece); },
    close: async () => {},
    abort: async () => {},
  }, {
    channels: 2, sampleRate: rate, frameCount: frames, chunkFrames: 4093,
    readFrames: (start, length) => readFrames(file, metadata, start, length),
    processFrames: (channels, start) => createExportProcessor.process(channels, start),
  });
  const exported = parseWav(await new Blob(pieces).arrayBuffer()).channels;
  exported.forEach((channel, c) => assert.deepEqual(channel, memory[c]));
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), originalBytes);
});

test('a saved click and pop module preserves strength and enabled state', () => {
  const module = { ...makeModule('click-pop'), enabled: false, params: { strength: 35 } };
  const preset = parseChainPresets(JSON.stringify([{ name: 'Old field tape', modules: [module] }]))[0];
  assert.deepEqual(preparePresetModules(preset, null).modules, [module]);
});

test('quiet clicks and an isolated opening click are reduced without a fixed loudness gate', () => {
  const clean = Float32Array.from({ length: rate }, (_, i) => .02 * Math.sin(2 * Math.PI * 330 * i / rate));
  const dirty = new Float32Array(clean);
  dirty[0] += .05;
  dirty[12003] += .045;
  const output = renderChain([dirty], [{ ...makeModule('click-pop'), params: { strength: 100 } }], rate)[0];
  assert.ok(Math.abs(output[0] - clean[0]) < .02, 'opening click should fall');
  assert.ok(Math.abs(output[12003] - clean[12003]) < .02, 'quiet mid-file click should fall');
});

test('repair of a decaying pop has no new edge at its tail; an abrupt wanted onset returns smoothly', () => {
  const { clean, dirty } = recording();
  const repaired = renderChain(dirty, [makeModule('click-pop')], rate)[0];
  for (let i = popAt + 70; i < popAt + 340; i++) {
    assert.ok(Math.abs(repaired[i] - repaired[i - 1]) < .018,
      `new audible edge at pop tail frame ${i}`);
  }
  assert.ok(Math.abs(repaired[popAt + 269] - clean[0][popAt + 269]) <
    Math.abs(dirty[0][popAt + 269] - clean[0][popAt + 269]), 'pop tail should also fall');
  assert.ok(Math.abs(repaired[popAt + 270] - clean[0][popAt + 270]) < .003,
    'repair should settle without leaving a large residual after the pop ends');

  const stepAt = 10000;
  const step = [Float32Array.from({ length: rate }, (_, i) => i >= stepAt ? .45 : 0)];
  const output = renderChain(step, [makeModule('click-pop')], rate)[0];
  assert.ok(output[stepAt + 600] > .44, 'sustained wanted level should return');
  for (let i = stepAt + 1; i < stepAt + 1000; i++) {
    assert.ok(Math.abs(output[i] - output[i - 1]) < .01,
      `repair must not introduce a second hard edge at frame ${i}`);
  }
});