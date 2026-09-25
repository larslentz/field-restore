import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLargeLoudness } from './large-analysis.ts';
import { generateFloat32WavHeader, parseWavMetadata } from './large-wav.ts';
import { analyzeLoudness } from './loudness.ts';

function toneSequence(segments, sampleRate = 8000) {
  const samples = new Float32Array(segments.reduce((frames, [seconds]) => frames + seconds * sampleRate, 0));
  let offset = 0;
  for (const [seconds, peakDbfs] of segments) {
    const amplitude = 10 ** (peakDbfs / 20);
    for (let i = 0; i < seconds * sampleRate; i += 1) {
      samples[offset + i] = amplitude * Math.sin(2 * Math.PI * 1000 * (offset + i) / sampleRate);
    }
    offset += seconds * sampleRate;
  }
  return samples;
}

async function analyzeFile(samples, sampleRate = 8000, channelCount = 1, chunkFrames = 733) {
  const header = generateFloat32WavHeader({ channels: channelCount, sampleRate, frameCount: samples.length });
  const payload = new ArrayBuffer(samples.length * channelCount * 4);
  const view = new DataView(payload);
  for (let i = 0; i < samples.length; i += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      view.setFloat32((i * channelCount + channel) * 4, samples[i], true);
    }
  }
  const file = new Blob([header, payload]);
  return analyzeLargeLoudness(file, await parseWavMetadata(file), { chunkFrames });
}

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

test('EBU Tech 3342 two-level stereo sequences measure 10 and 5 LU LRA', async () => {
  const rate = 8000;
  for (const [secondLevel, expected] of [[-30, 10], [-15, 5]]) {
    const samples = toneSequence([[20, -20], [20, secondLevel]], rate);
    const memory = analyzeLoudness([samples, samples], rate);
    const chunked = await analyzeFile(samples, rate, 2, 9017);
    assert.ok(Math.abs(memory.loudnessRangeLu - expected) <= 1, `memory ${secondLevel} dBFS: ${memory.loudnessRangeLu} LU`);
    assert.ok(Math.abs(chunked.loudnessRangeLu - expected) <= 1, `file-backed ${secondLevel} dBFS: ${chunked.loudnessRangeLu} LU`);
    assert.ok(Math.abs(chunked.loudnessRangeLu - memory.loudnessRangeLu) < 0.75);

    // A selected steady segment has little range, unlike the full two-level file.
    const selected = analyzeLoudness([samples, samples], rate, 20 * rate, samples.length);
    assert.ok(selected.loudnessRangeLu < 1);
    const selectedFile = await analyzeFile(samples.subarray(20 * rate), rate, 2, 9017);
    assert.ok(Math.abs(selectedFile.loudnessRangeLu - selected.loudnessRangeLu) < 0.75);
    if (expected === 10) {
      const edited = Float32Array.from(samples, (sample) => sample * 0.5);
      const editedMemory = analyzeLoudness([edited, edited], rate);
      const editedFile = await analyzeFile(edited, rate, 2, 9017);
      assert.ok(Math.abs(editedMemory.loudnessRangeLu - memory.loudnessRangeLu) < 0.1);
      assert.ok(Math.abs(editedFile.loudnessRangeLu - editedMemory.loudnessRangeLu) < 0.75);
      assert.ok(Math.abs(editedMemory.integratedLufs - memory.integratedLufs + 6.02) < 0.1);
    }
  }
});

test('LRA retains a long quiet section that the programme loudness gate would discard', async () => {
  const rate = 8000;
  const samples = toneSequence([[100, -54], [10, -28]], rate);
  const memory = analyzeLoudness([samples], rate);
  const quiet = analyzeLoudness([samples], rate, 5 * rate, 10 * rate);
  const chunked = await analyzeFile(samples, rate, 1, 10013);

  assert.ok(quiet.integratedLufs < memory.integratedLufs - 20, 'old programme gate would exclude the quiet passage');
  assert.ok(memory.loudnessRangeLu > 22 && memory.loudnessRangeLu < 28, `memory: ${memory.loudnessRangeLu} LU`);
  assert.ok(Math.abs(chunked.loudnessRangeLu - memory.loudnessRangeLu) < 0.75);
  assert.ok(Math.abs(chunked.integratedLufs - memory.integratedLufs) < 0.5);
});

test('silence and ranges without two valid 3-second readings have unavailable LRA', async () => {
  const rate = 8000;
  const silent = new Float32Array(rate * 5);
  const short = toneSequence([[2, -20]], rate);
  for (const samples of [silent, short]) {
    assert.ok(Number.isNaN(analyzeLoudness([samples], rate).loudnessRangeLu));
    assert.ok(Number.isNaN((await analyzeFile(samples, rate)).loudnessRangeLu));
  }
  const recording = toneSequence([[5, -20]], rate);
  assert.ok(Number.isNaN(analyzeLoudness([recording], rate, 0, 3 * rate).loudnessRangeLu));
});