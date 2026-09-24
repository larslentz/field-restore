import assert from 'node:assert/strict';
import test from 'node:test';
import { FLAC_SINE_BASE64 } from '../../tests/fixtures/flac-sine.ts';
import { decodeFlac, parseFlacMetadata } from './flac.ts';
import { audioRange, fingerprintAudio, parseAudioMetadata, readAudioFrames } from './source-audio.ts';
import { encodeWav, parseWav } from './audio.ts';
import { openVerifiedFileHandle } from './file-access.ts';
import { analyzeLargeLoudness } from './large-analysis.ts';
import { calculateFileSpectrogram } from './large-spectrogram.ts';

const source = () => new File([Buffer.from(FLAC_SINE_BASE64, 'base64')], 'tone.flac', { type: 'audio/flac' });

test('FLAC metadata and bounded random frame reads match the complete decoded recording', async () => {
  const file = source();
  const metadata = await parseAudioMetadata(file, { name: file.name });
  assert.equal(metadata.format, 'FLAC');
  assert.equal(metadata.sampleRate, 48000);
  assert.equal(metadata.channels, 2);
  assert.equal(metadata.frameCount, 4800);
  assert.equal(metadata.frames.length, 2);
  const memory = await decodeFlac(file, metadata);
  assert.equal(memory.channels[0].length, 4800);
  assert.ok(Math.abs(memory.channels[0][100]) > .01);
  for (const [start, count] of [[0, 32], [4595, 30], [4700, 100], [4798, 4]]) {
    const frames = await readAudioFrames(file, metadata, start, count);
    frames.forEach((channel, index) =>
      assert.deepEqual(channel, memory.channels[index].slice(start, start + count)));
  }
  const range = audioRange(metadata, 4550, 250);
  assert.deepEqual((await readAudioFrames(file, range, 50, 64))[0], memory.channels[0].slice(4600, 4664));
  assert.equal(metadata.frameCount, 4800, 'analysis ranges must not mutate the source');
  const wav = parseWav(await encodeWav(memory).arrayBuffer(), 'export.wav');
  assert.equal(wav.channels[0].length, 4800);
  assert.deepEqual(wav.channels[0], memory.channels[0]);
});

test('FLAC identity is stable for relinks; malformed and disguised audio is rejected', async () => {
  const file = source();
  const metadata = await parseFlacMetadata(file);
  const fingerprint = await fingerprintAudio(file, metadata);
  assert.equal(fingerprint, await fingerprintAudio(source(), metadata));
  const handle = { queryPermission: async () => 'granted', getFile: async () => source() };
  assert.equal((await openVerifiedFileHandle(handle, fingerprint))?.metadata.format, 'FLAC');
  assert.equal(await openVerifiedFileHandle(handle, 'another recording'), null);
  await assert.rejects(() => parseAudioMetadata(new File([file], 'disguised.wav')), /FLAC audio, not a WAV/);
  await assert.rejects(() => parseAudioMetadata(new File(['ID3not a flac'], 'bad.flac')), /does not contain FLAC/);
  await assert.rejects(() => parseFlacMetadata(file.slice(0, -40)), /incomplete|frame count|invalid/i);
});

test('file-backed FLAC analysis and spectrogram can read decoded ranges', async () => {
  const file = source();
  const metadata = await parseFlacMetadata(file);
  const analysis = await analyzeLargeLoudness(file, metadata);
  assert.ok(analysis);
  const spectrogram = await calculateFileSpectrogram(file, audioRange(metadata, 256, 4096), {
    width: 12, height: 32, durationSeconds: 4096 / metadata.sampleRate,
  });
  assert.equal(spectrogram.values.length, 12 * 32);
  assert.ok(spectrogram.values.some((value) => Number.isFinite(value)));
});