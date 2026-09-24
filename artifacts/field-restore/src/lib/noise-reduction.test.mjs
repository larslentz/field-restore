import assert from 'node:assert/strict';
import test from 'node:test';
import { makeDefaultChain, makeModule, renderChain } from './edit-chain.ts';
import { createStreamingEditChain } from './streaming-edit-chain.ts';
import { parseChainPresets } from './chain-presets.ts';
import { generateFloat32WavHeader, parseWavMetadata } from './large-wav.ts';
import { calculateFileSpectrogram } from './large-spectrogram.ts';
import { calculateSpectrogram } from './spectrogram.ts';

const rate = 12000;
const length = rate * 5;
const module = () => makeModule('noise');

function rms(data, from = rate * 3, to = length) {
  let power = 0;
  for (let i = from; i < to; i++) power += data[i] * data[i];
  return Math.sqrt(power / (to - from));
}

function signal(tone = 0, noise = .08) {
  let seed = 123456;
  return Float32Array.from({ length }, (_, frame) => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return tone * Math.sin(2 * Math.PI * 930 * frame / rate) + noise * (seed / 0xffffffff * 2 - 1);
  });
}

function toneAmplitude(samples) {
  let sine = 0;
  let cosine = 0;
  for (let frame = rate * 3; frame < length; frame++) {
    const phase = 2 * Math.PI * 930 * frame / rate;
    sine += samples[frame] * Math.sin(phase);
    cosine += samples[frame] * Math.cos(phase);
  }
  return Math.hypot(sine, cosine) * 2 / (length - rate * 3);
}

test('opt-in denoising reduces steady hiss while leaving wanted tones and source intact', () => {
  const hiss = signal();
  const original = new Float32Array(hiss);
  const quieter = renderChain([hiss], [module()], rate)[0];
  assert.ok(rms(quieter) < rms(hiss) * .87, 'steady broadband noise should audibly decrease');
  assert.deepEqual(hiss, original, 'the original recording must remain unchanged');
  const tone = signal(.18, 0);
  const processedTone = renderChain([tone], [module()], rate)[0];
  assert.ok(toneAmplitude(processedTone) > toneAmplitude(tone) * .94, 'a wanted sustained tone should be protected');
  const [, rightTone] = renderChain([signal(0, .06), tone], [module()], rate);
  assert.ok(toneAmplitude(rightTone) > toneAmplitude(tone) * .94, 'a tone only in the right channel should be protected');
  assert.ok(!makeDefaultChain().some((item) => item.type === 'noise'), 'existing default chains remain unchanged');
});

test('bypass and zero strength leave audio unchanged, and presets retain the item', () => {
  const input = signal(.1, .03);
  const disabled = { ...module(), enabled: false };
  assert.deepEqual(renderChain([input], [disabled], rate)[0], input);
  const zero = { ...module(), params: { strength: 0 } };
  assert.deepEqual(renderChain([input], [zero], rate)[0], input);
  const restored = parseChainPresets(JSON.stringify([{ name: 'Gentle cleanup', modules: [module()] }]));
  assert.equal(restored[0].modules[0].type, 'noise');
  assert.equal(restored[0].modules[0].params.strength, 50);
});

test('stereo-linked gains, uneven chunks, and restored state match full rendering', () => {
  const left = signal(.06, .05);
  const right = Float32Array.from(left, (sample) => -sample);
  const edit = module();
  const [fullLeft, fullRight] = renderChain([left, right], [edit], rate);
  const streamed = createStreamingEditChain([edit], rate, length);
  const joinedLeft = new Float32Array(length);
  const joinedRight = new Float32Array(length);
  let cursor = 0;
  for (const chunkLength of [311, rate + 37, rate * 2 + 1, length]) {
    const end = Math.min(length, cursor + chunkLength);
    if (end <= cursor) break;
    const [a, b] = streamed.process([left.slice(cursor, end), right.slice(cursor, end)], cursor);
    joinedLeft.set(a, cursor);
    joinedRight.set(b, cursor);
    cursor = end;
    if (cursor === rate * 3 + 349) {
      const restored = createStreamingEditChain([edit], rate, length);
      restored.restore(streamed.snapshot());
      const [tailA, tailB] = restored.process([left.slice(cursor), right.slice(cursor)], cursor);
      joinedLeft.set(tailA, cursor);
      joinedRight.set(tailB, cursor);
      cursor = length;
      break;
    }
  }
  assert.equal(cursor, length);
  for (let index = 0; index < length; index++) {
    assert.ok(Math.abs(joinedLeft[index] - fullLeft[index]) < 1e-6, `chunk parity at frame ${index}`);
    assert.ok(Math.abs(joinedRight[index] - fullRight[index]) < 1e-6, `right channel parity at frame ${index}`);
    assert.ok(Math.abs(joinedLeft[index] + joinedRight[index]) < 1e-6, `stereo phase at frame ${index}`);
  }
});

test('wanted notes mixed with hiss and short onsets survive at 48 and 96 kHz', () => {
  for (const sampleRate of [48000, 96000]) {
    const count = sampleRate * 3;
    let seed = 8734;
    const hiss = Float32Array.from({ length: count }, () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return .04 * (seed / 0xffffffff * 2 - 1);
    });
    const note = Float32Array.from(hiss, (value, index) =>
      value + .06 * Math.sin(2 * Math.PI * 930 * index / sampleRate));
    const denoisedHiss = renderChain([hiss], [module()], sampleRate)[0];
    const denoisedNote = renderChain([note], [module()], sampleRate)[0];
    const start = sampleRate * 2;
    let originalNote = 0;
    let restoredNote = 0;
    let originalNoisePower = 0;
    let reducedNoisePower = 0;
    for (let i = start; i < count; i++) {
      const basis = Math.sin(2 * Math.PI * 930 * i / sampleRate);
      originalNote += note[i] * basis;
      restoredNote += denoisedNote[i] * basis;
      originalNoisePower += hiss[i] ** 2;
      reducedNoisePower += denoisedHiss[i] ** 2;
    }
    assert.ok(restoredNote / originalNote > .94, `${sampleRate} Hz wanted note was weakened: ${restoredNote / originalNote}`);
    assert.ok(Math.sqrt(reducedNoisePower / originalNoisePower) < .87, `${sampleRate} Hz hiss should be reduced`);

    const burstStart = sampleRate * 2;
    const burstLength = Math.floor(sampleRate * .01);
    const burst = Float32Array.from(hiss, (value, index) =>
      value + (index >= burstStart && index < burstStart + burstLength
        ? .24 * Math.sin(2 * Math.PI * 1500 * index / sampleRate) : 0));
    const denoisedBurst = renderChain([burst], [module()], sampleRate)[0];
    let originalTransient = 0;
    let restoredTransient = 0;
    for (let i = burstStart; i < burstStart + burstLength; i++) {
      const basis = Math.sin(2 * Math.PI * 1500 * i / sampleRate);
      originalTransient += (burst[i] - hiss[i]) * basis;
      restoredTransient += (denoisedBurst[i] - denoisedHiss[i]) * basis;
    }
    assert.ok(restoredTransient / originalTransient > .9, `${sampleRate} Hz transient onset was weakened: ${restoredTransient / originalTransient}`);
  }
});

test('file-backed edited spectrogram at a later time matches full-history rendering', async () => {
  const input = signal(.06, .06);
  const edit = module();
  const blob = new Blob([generateFloat32WavHeader({ channels: 1, sampleRate: rate, frameCount: length }), input]);
  const metadata = await parseWavMetadata(blob);
  const processed = renderChain([input], [edit], rate)[0];
  const options = {
    startSeconds: 3,
    durationSeconds: 1,
    width: 6,
    height: 32,
    minimumFrequency: 0,
    maximumFrequency: rate / 2,
    floorDb: -110,
    ceilingDb: 0,
    fftSize: 1024,
  };
  const memory = calculateSpectrogram([processed], rate, options.startSeconds, options.durationSeconds,
    options.width, options.height, options.minimumFrequency, options.maximumFrequency,
    options.floorDb, options.ceilingDb, options.fftSize);
  const chain = createStreamingEditChain([edit], rate, length);
  const file = await calculateFileSpectrogram(blob, metadata, {
    ...options,
    continuousTransform: true,
    transform: (channels, frame) => chain.process(channels, frame),
  });
  for (let index = 0; index < memory.values.length; index++) {
    assert.ok(Math.abs(memory.values[index] - file.values[index]) < 1e-6, `spectrogram parity at ${index}`);
  }
});