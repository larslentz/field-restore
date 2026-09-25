import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { makeProcessingChain } from './edit-chain.ts';
import { renderMemoryAudio } from './memory-render.ts';
import { createStreamingEditChain } from './streaming-edit-chain.ts';
import { encodeWav, parseWav } from './audio.ts';

test('dense stereo memory render retains all confirmed tones and matches chunked export and WAV playback', async () => {
  const sampleRate = 48000;
  const seconds = Number(process.env.DENSE_HUM_BENCH_SECONDS || 6);
  const frames = seconds * sampleRate;
  const frequencies = Array.from({ length: 350 }, (_, i) => 40 * (i + 1));
  // Integer-Hz periodic source; repeat a one-second period to simulate a long stable recording.
  const period = Array.from({ length: 2 }, (_, channel) => {
    const data = new Float32Array(sampleRate);
    for (let i = 0; i < sampleRate; i++) {
      let value = channel ? .012 : -.012;
      for (const frequency of frequencies) value += .0015 * Math.sin(2 * Math.PI * frequency * i / sampleRate + channel * .23);
      data[i] = value;
    }
    return data;
  });
  const original = period.map((channel) => {
    const data = new Float32Array(frames);
    for (let start = 0; start < frames; start += sampleRate) data.set(channel.subarray(0, Math.min(sampleRate, frames - start)), start);
    return data;
  });
  const modules = makeProcessingChain([
    { id: 'hum', type: 'hum', name: 'Hum Removal', enabled: true, params: { mode: 'Adaptive', frequency: 60, reduction: 12 } },
  ]);
  const start = performance.now();
  const rendered = renderMemoryAudio(original, modules, sampleRate);
  const elapsed = performance.now() - start;
  const confirmed = rendered.frequencies[1];
  assert.ok(confirmed.length >= 340, `expected 350 persistent tones without a filter cap; got ${confirmed.length}`);
  assert.equal(rendered.channels.length, 2);
  assert.equal(original[0][0], period[0][0], 'render must not modify the original');
  const processor = createStreamingEditChain(modules, sampleRate, frames, 0, rendered.frequencies);
  let maxDifference = 0;
  for (let frame = 0; frame < frames; frame += 8192) {
    const end = Math.min(frames, frame + 8192);
    const chunk = processor.process(original.map((channel) => channel.slice(frame, end)), frame);
    for (let ch = 0; ch < 2; ch++)
      for (let i = 0; i < end - frame; i++)
        maxDifference = Math.max(maxDifference, Math.abs(chunk[ch][i] - rendered.channels[ch][frame + i]));
  }
  assert.ok(maxDifference < .00001, `export and playback must match, worst sample difference ${maxDifference}`);
  const wav = parseWav(await encodeWav({ name: 'dense.wav', sampleRate, duration: seconds, channels: rendered.channels }).arrayBuffer(), 'dense.wav');
  for (let ch = 0; ch < 2; ch++)
    for (const i of [0, 100, Math.floor(frames / 2), frames - 1])
      assert.equal(wav.channels[ch][i], rendered.channels[ch][i], 'WAV export must use the rendered playback samples');
  console.log(`${seconds}s stereo / ${confirmed.length} confirmed tones at 48 kHz: memory render ${elapsed.toFixed(0)} ms; max chunked export difference ${maxDifference}`);
});