import assert from 'node:assert/strict';
import test from 'node:test';
import { makeDefaultChain, makeModule, renderChain } from './edit-chain.ts';
import { createStreamingEditChain } from './streaming-edit-chain.ts';
import { parseChainPresets, preparePresetModules, saveChainPreset, readChainPresets } from './chain-presets.ts';
import { measureNoiseProfile, NOISE_PROFILE_BANDS } from './noise-reduction.ts';
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

test('sampled hiss profile changes reduction, persists in presets, and matches streamed chunks and restored state', () => {
  const input = signal(.06, .04);
  const quiet = signal(0, .04).slice(0, rate);
  const profile = measureNoiseProfile([quiet], rate);
  assert.equal(profile.length, NOISE_PROFILE_BANDS);
  const edit = makeModule('noise', { params: {
    mode: 'Sample', sampleStart: 0, sampleEnd: 1,
    ...Object.fromEntries(profile.map((value, i) => [`profile${i}`, value])),
  } });
  const sampled = renderChain([input], [edit], rate)[0];
  const automatic = renderChain([input], [{ ...edit, params: { ...edit.params, mode: 'Automatic' } }], rate)[0];
  assert.ok(sampled.every(Number.isFinite));
  assert.ok(sampled.some((value, i) => Math.abs(value - automatic[i]) > 1e-6), 'the chosen sample must influence processing');
  const storage = new Map();
  const adapter = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  saveChainPreset(adapter, 'Sampled hiss', [edit]);
  const loaded = readChainPresets(adapter)[0].modules[0];
  assert.deepEqual(loaded.params, edit.params);
  const streamed = createStreamingEditChain([loaded], rate, length);
  const prefix = streamed.process([input.slice(0, rate * 2)], 0)[0];
  const resumed = createStreamingEditChain([loaded], rate, length);
  resumed.restore(streamed.snapshot());
  const suffix = resumed.process([input.slice(rate * 2)], rate * 2)[0];
  assert.deepEqual(Float32Array.from([...prefix, ...suffix]), sampled);
  assert.throws(() => renderChain([input], [{ ...edit, params: { ...edit.params, profile0: NaN } }], rate), /incomplete/);
});

test('preset samples only follow the verified original recording, including across reads', () => {
  const input = signal(.06, .04);
  const profile = measureNoiseProfile([signal(0, .04).slice(0, rate)], rate);
  const edit = makeModule('noise', { params: {
    mode: 'Sample', strength: 75, sampleStart: 0, sampleEnd: 1,
    ...Object.fromEntries(profile.map((value, i) => [`profile${i}`, value])),
  } });
  const storage = new Map();
  const adapter = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  saveChainPreset(adapter, 'From recording A', [edit], 'recording-a');
  const saved = readChainPresets(adapter)[0];
  const matching = preparePresetModules(saved, 'recording-a');
  assert.equal(matching.discardedSamples, false);
  assert.deepEqual(matching.modules[0].params, edit.params);
  assert.deepEqual(renderChain([input], matching.modules, rate), renderChain([input], [edit], rate));
  const stream = createStreamingEditChain(matching.modules, rate, length);
  assert.deepEqual(stream.process([input], 0)[0], renderChain([input], [edit], rate)[0]);

  for (const fingerprint of ['recording-b', null]) {
    const changed = preparePresetModules(saved, fingerprint);
    assert.equal(changed.discardedSamples, true);
    assert.equal(changed.modules[0].params.mode, 'Automatic');
    assert.equal(changed.modules[0].params.strength, 75);
    assert.equal(changed.modules[0].params.profile0, undefined);
    assert.equal(changed.modules[0].params.sampleStart, undefined);
    assert.deepEqual(renderChain([input], changed.modules, rate),
      renderChain([input], [{ ...edit, params: { mode: 'Automatic', strength: 75 } }], rate));
  }
  assert.deepEqual(saved.modules[0].params, edit.params, 'preset must not be mutated by loading elsewhere');
  const legacy = parseChainPresets(JSON.stringify([{ name: 'Old sample', modules: [edit] }]))[0];
  assert.equal(preparePresetModules(legacy, 'recording-a').modules[0].params.mode, 'Automatic');
  const dormant = { ...edit, params: { ...edit.params, mode: 'Automatic' } };
  assert.equal(preparePresetModules({ name: 'Dormant', modules: [dormant], sourceFingerprint: 'recording-a' }, 'recording-b').modules[0].params.profile0, undefined);
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