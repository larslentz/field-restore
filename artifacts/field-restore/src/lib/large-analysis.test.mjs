import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLargeLoudness } from './large-analysis.ts';
import { generateFloat32WavHeader, parseWavMetadata } from './large-wav.ts';
import { analyzeLoudness } from './loudness.ts';

test('chunked loudness and percentile LRA stay close to the in-memory analyzer', async () => {
  const sampleRate = 8000;
  const frames = sampleRate * 12;
  const channel = Float32Array.from({ length: frames }, (_, index) => {
    const second = Math.floor(index / sampleRate);
    const amplitude = second < 3 ? 0.02 : second < 6 ? 0.08 : second < 9 ? 0.2 : 0.05;
    return Math.sin(2 * Math.PI * 440 * index / sampleRate) * amplitude;
  });
  const header = generateFloat32WavHeader({ channels: 1, sampleRate, frameCount: frames });
  const payload = new ArrayBuffer(frames * 4);
  const view = new DataView(payload);
  channel.forEach((sample, index) => view.setFloat32(index * 4, sample, true));
  const file = new Blob([header, payload]);
  const metadata = await parseWavMetadata(file);

  const memory = analyzeLoudness([channel], sampleRate);
  const chunked = await analyzeLargeLoudness(file, metadata, { chunkFrames: 733 });
  assert.ok(Math.abs(chunked.integratedLufs - memory.integratedLufs) < 0.5);
  assert.ok(Math.abs(chunked.loudnessRangeLu - memory.loudnessRangeLu) < 0.75);
  assert.ok(Math.abs(chunked.maxShortTermLufs - memory.maxShortTermLufs) < 0.5);
});