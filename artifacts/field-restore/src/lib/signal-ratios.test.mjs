import assert from 'node:assert/strict';
import test from 'node:test';
import { createLbprAccumulator, peakToLoudnessRatio } from './signal-ratios.ts';
import { analyzeLoudness } from './loudness.ts';

function addBlock(accumulator, frames, amplitudes) {
  for (let i = 0; i < frames; i += 1) {
    amplitudes.forEach((amplitude, channel) => accumulator.addSample(channel, amplitude));
    accumulator.finishFrame();
  }
}

function db(amplitude) {
  return 20 * Math.log10(amplitude);
}

test('PLR subtracts integrated loudness from true peak, not sample peak', () => {
  assert.equal(peakToLoudnessRatio(-0.5, -18), 17.5);
  assert.ok(Number.isNaN(peakToLoudnessRatio(-Infinity, -18)));
  assert.ok(Number.isNaN(peakToLoudnessRatio(-0.5, -Infinity)));
});

test('an inter-sample peak changes PLR but not the LBPR sample peak', () => {
  const samples = new Float32Array(8000);
  samples.set([-0.8, -0.8, 0.8, 0.8], 100);
  const stats = analyzeLoudness([samples], 8000);
  const samplePeak = stats.lbpr.channels[0].samplePeakDbfs;
  assert.ok(Math.abs(samplePeak - db(Math.abs(samples[100]))) < 1e-6);
  assert.ok(stats.truePeakDbtp > samplePeak + 1);
  assert.ok(Math.abs(stats.plrLu - (stats.truePeakDbtp - stats.integratedLufs)) < 1e-10);
  assert.ok(Math.abs(stats.lbpr.valueDb - (samplePeak - stats.lbpr.channels[0].loudBlockRmsDbfs)) < 1e-10);
});

test('LBPR takes the ceiling of the top 20% of non-silent blocks and averages their dBFS levels', () => {
  const lbpr = createLbprAccumulator(1, 4);
  for (const amplitude of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
    addBlock(lbpr, 12, [amplitude]);
  }
  const result = lbpr.result();
  const expectedRms = (db(0.6) + db(0.5)) / 2; // ceil(0.2 * 6) = 2
  assert.ok(Math.abs(result.channels[0].samplePeakDbfs - db(0.6)) < 1e-10);
  assert.ok(Math.abs(result.channels[0].loudBlockRmsDbfs - expectedRms) < 1e-10);
  assert.ok(Math.abs(result.valueDb - (db(0.6) - expectedRms)) < 1e-10);
});

test('LBPR includes the final partial block and excludes silent blocks independently per channel', () => {
  const lbpr = createLbprAccumulator(2, 4);
  addBlock(lbpr, 12, [0.1, 0.2]);
  addBlock(lbpr, 12, [0, 0.4]);
  addBlock(lbpr, 3, [0.8, 0]); // partial; both zero-RMS blocks are excluded separately
  const result = lbpr.result();
  assert.equal(result.channels.length, 2);
  assert.ok(Math.abs(result.channels[0].samplePeakDbfs - db(0.8)) < 1e-10);
  assert.ok(Math.abs(result.channels[0].loudBlockRmsDbfs - db(0.8)) < 1e-10);
  assert.ok(Math.abs(result.channels[1].loudBlockRmsDbfs - db(0.4)) < 1e-10);
  assert.ok(Math.abs(result.valueDb -
    (result.channels[0].differenceDb + result.channels[1].differenceDb) / 2) < 1e-10);
});

test('LBPR leaves fully silent channels and empty ranges unavailable', () => {
  const stereo = createLbprAccumulator(2, 4);
  addBlock(stereo, 12, [0.5, 0]);
  const result = stereo.result();
  assert.ok(Number.isNaN(result.channels[1].differenceDb));
  assert.ok(Number.isNaN(result.valueDb));
  assert.ok(Number.isNaN(createLbprAccumulator(1, 4).result().valueDb));
});