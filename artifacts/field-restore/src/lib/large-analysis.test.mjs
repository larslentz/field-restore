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

async function analyzeFile(samples, sampleRate = 8000, channelCount = 1, chunkFrames = 733, options = {}) {
  const data = Array.isArray(samples) ? samples : Array.from({ length: channelCount }, () => samples);
  const header = generateFloat32WavHeader({ channels: channelCount, sampleRate, frameCount: data[0].length });
  const payload = new ArrayBuffer(data[0].length * channelCount * 4);
  const view = new DataView(payload);
  for (let i = 0; i < data[0].length; i += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      view.setFloat32((i * channelCount + channel) * 4, data[channel][i], true);
    }
  }
  const file = new Blob([header, payload]);
  return analyzeLargeLoudness(file, await parseWavMetadata(file), { chunkFrames, ...options });
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

test('PLR and LBPR agree across stereo streams, edits, trims, and selections', async () => {
  const rate = 8000;
  const left = toneSequence([[3, -25], [3, -15], [3, -30], [1, -10]], rate);
  const right = toneSequence([[3, -18], [3, -35], [3, -12], [1, -25]], rate);
  const compare = (a, b) => {
    assert.ok(Math.abs(a.plrLu - b.plrLu) < 0.5, `PLR: ${a.plrLu} vs ${b.plrLu}`);
    assert.ok(Math.abs(a.lbpr.valueDb - b.lbpr.valueDb) < 1e-5, `LBPR: ${a.lbpr.valueDb} vs ${b.lbpr.valueDb}`);
    for (let channel = 0; channel < 2; channel += 1) {
      assert.ok(Math.abs(a.lbpr.channels[channel].samplePeakDbfs - b.lbpr.channels[channel].samplePeakDbfs) < 1e-5);
      assert.ok(Math.abs(a.lbpr.channels[channel].loudBlockRmsDbfs - b.lbpr.channels[channel].loudBlockRmsDbfs) < 1e-5);
      assert.ok(Math.abs(a.lbpr.channels[channel].differenceDb - b.lbpr.channels[channel].differenceDb) < 1e-5);
    }
  };
  const original = analyzeLoudness([left, right], rate);
  compare(original, await analyzeFile([left, right], rate, 2, 941));
  assert.ok(Math.abs(original.plrLu - (original.truePeakDbtp - original.integratedLufs)) < 1e-10);
  assert.ok(original.lbpr.channels[0].samplePeakDbfs > original.lbpr.channels[1].samplePeakDbfs);

  const edited = [Float32Array.from(left, (sample) => sample * 0.5), Float32Array.from(right, (sample) => sample * 0.5)];
  compare(analyzeLoudness(edited, rate), await analyzeFile([left, right], rate, 2, 941, {
    transform: (channels) => channels.map((channel) => Float32Array.from(channel, (sample) => sample * 0.5)),
  }));

  // The partial block and first complete block must be based on the trimmed/selected start.
  const start = rate;
  const end = 7 * rate + rate / 2;
  const trimmed = [left.subarray(start, end), right.subarray(start, end)];
  compare(analyzeLoudness([left, right], rate, start, end),
    await analyzeFile(trimmed, rate, 2, 941));
  compare(analyzeLoudness([left, right], rate, 3 * rate, 4 * rate),
    await analyzeFile([left.subarray(3 * rate, 4 * rate), right.subarray(3 * rate, 4 * rate)], rate, 2, 941));
});

test('PLR and LBPR are unavailable for silence while a short non-silent selection has LBPR', async () => {
  const rate = 8000;
  const silent = new Float32Array(rate * 4);
  const memorySilence = analyzeLoudness([silent], rate);
  const fileSilence = await analyzeFile(silent, rate);
  for (const stats of [memorySilence, fileSilence]) {
    assert.ok(Number.isNaN(stats.plrLu));
    assert.ok(Number.isNaN(stats.lbpr.valueDb));
  }
  const short = toneSequence([[1, -12]], rate);
  const memoryShort = analyzeLoudness([short], rate);
  const fileShort = await analyzeFile(short, rate);
  assert.ok(Number.isFinite(memoryShort.lbpr.valueDb));
  assert.ok(Math.abs(memoryShort.lbpr.valueDb - fileShort.lbpr.valueDb) < 1e-5);
});