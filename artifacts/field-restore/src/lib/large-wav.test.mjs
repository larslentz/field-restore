import assert from 'node:assert/strict';
import test from 'node:test';
import { generateFloat32WavHeader, parseWavMetadata, readFrames } from './large-wav.ts';

const text = (bytes, start, length) => String.fromCharCode(...bytes.slice(start, start + length));

test('generates a compact RIFF float header', () => {
  const header = generateFloat32WavHeader({ channels: 2, sampleRate: 48000, frameCount: 10 });
  assert.equal(header.byteLength, 44);
  assert.equal(text(header, 0, 4), 'RIFF');
  assert.equal(text(header, 8, 4), 'WAVE');
  assert.equal(new DataView(header.buffer).getUint32(40, true), 80);
});

test('generates RF64 headers without allocating the data payload', () => {
  const header = generateFloat32WavHeader({ channels: 2, sampleRate: 48000, frameCount: 0x40000000n });
  assert.equal(header.byteLength, 80);
  assert.equal(text(header, 0, 4), 'RF64');
  assert.equal(text(header, 12, 4), 'ds64');
  assert.equal(new DataView(header.buffer).getBigUint64(28, true), 0x200000000n);
});

test('parses and range-decodes float WAV without reading the whole source', async () => {
  const header = generateFloat32WavHeader({ channels: 2, sampleRate: 48000, frameCount: 3 });
  const samples = new ArrayBuffer(24);
  const view = new DataView(samples);
  [0.25, -0.5, 0.75, -1, 0.125, -0.25].forEach((value, index) => view.setFloat32(index * 4, value, true));
  const blob = new Blob([header, samples]);
  const metadata = await parseWavMetadata(blob, { name: 'range.wav' });
  assert.equal(metadata.frameCount, 3);
  assert.equal(metadata.channels, 2);
  const channels = await readFrames(blob, metadata, 1, 1);
  assert.deepEqual(Array.from(channels[0]), [0.75]);
  assert.deepEqual(Array.from(channels[1]), [-1]);
});

test('parses RF64 64-bit frame counts from a compact header fixture', async () => {
  const header = generateFloat32WavHeader({ channels: 2, sampleRate: 96000, frameCount: 0x20000000n });
  const metadata = await parseWavMetadata(new Blob([header]), { name: 'hours.rf64.wav' });
  assert.equal(metadata.format, 'RF64');
  assert.equal(metadata.frameCount, 0x20000000);
  assert.equal(metadata.dataLengthBigInt, 0x100000000n);
});