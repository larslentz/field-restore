import assert from 'node:assert/strict';
import test from 'node:test';
import { generateFloat32WavHeader, parseWavMetadata } from './large-wav.ts';
import { calculateFileSpectrogram } from './large-spectrogram.ts';
import { SPECTROGRAM_DATA_HEIGHT, SPECTROGRAM_FFT_SIZE } from './spectrogram-resolution.ts';
import { calculateSpectrogram } from './spectrogram.ts';

const sampleRate = 48000;

function toneFixture() {
  const samples = new Float32Array(SPECTROGRAM_FFT_SIZE * 2);
  const firstBin = 85;
  const secondBin = 90;
  const firstFrequency = firstBin * sampleRate / SPECTROGRAM_FFT_SIZE;
  const secondFrequency = secondBin * sampleRate / SPECTROGRAM_FFT_SIZE;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = 0.4 * Math.sin(2 * Math.PI * firstFrequency * index / sampleRate)
      + 0.4 * Math.sin(2 * Math.PI * secondFrequency * index / sampleRate);
  }
  return { samples, firstBin, secondBin };
}

test('uses enough FFT bins to separate nearby tones', () => {
  const { samples, firstBin, secondBin } = toneFixture();
  const result = calculateSpectrogram(
    [samples],
    sampleRate,
    0,
    samples.length / sampleRate,
    1,
    SPECTROGRAM_DATA_HEIGHT,
    0,
    sampleRate / 2,
    -120,
    0,
  );
  const rowForBin = (bin) => SPECTROGRAM_DATA_HEIGHT - 1 - bin;
  const firstPeak = result.values[rowForBin(firstBin)];
  const secondPeak = result.values[rowForBin(secondBin)];
  const valley = result.values[rowForBin(87)];
  assert.ok(firstPeak > 0.85);
  assert.ok(secondPeak > 0.85);
  assert.ok(valley < Math.min(firstPeak, secondPeak) - 0.15);
});

test('file-backed and in-memory spectrograms use equivalent frequency resolution', async () => {
  const { samples } = toneFixture();
  const inMemory = calculateSpectrogram(
    [samples],
    sampleRate,
    0,
    samples.length / sampleRate,
    1,
    SPECTROGRAM_DATA_HEIGHT,
    0,
    sampleRate / 2,
    -120,
    0,
  );
  const header = generateFloat32WavHeader({ channels: 1, sampleRate, frameCount: samples.length });
  const blob = new Blob([header, samples]);
  const metadata = await parseWavMetadata(blob);
  const fileBacked = await calculateFileSpectrogram(blob, metadata, {
    width: 1,
    height: SPECTROGRAM_DATA_HEIGHT,
    minimumFrequency: 0,
    maximumFrequency: sampleRate / 2,
    floorDb: -120,
    ceilingDb: 0,
    fftSize: SPECTROGRAM_FFT_SIZE,
  });
  assert.equal(fileBacked.height, inMemory.height);
  for (let row = 0; row < inMemory.height; row += 1) {
    assert.ok(Math.abs(fileBacked.values[row] - inMemory.values[row]) < 1e-6);
  }
});

test('rejects unsupported FFT sizes', async () => {
  const samples = new Float32Array(4096);
  assert.throws(
    () => calculateSpectrogram([samples], sampleRate, 0, 0.1, 1, 10, 0, 20000, -120, 0, 1000),
    /power of two/,
  );
  const metadata = {
    format: 'RIFF',
    audioFormat: 3,
    channels: 1,
    sampleRate,
    bitsPerSample: 32,
    frameSize: 4,
    frameCount: samples.length,
    dataOffset: 0,
    dataLength: samples.byteLength,
  };
  await assert.rejects(
    calculateFileSpectrogram(new Blob([samples]), metadata, { fftSize: 1000 }),
    /power of two/,
  );
});