import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSpectralRepair } from './spectral-repair.ts';
import { makeModule, renderChain, withoutLegacyDcModules } from './edit-chain.ts';

const rate = 16000;
const params = {
  start: 0.8,
  end: 1.2,
  low: 900,
  high: 1150,
  mode: 'Attenuate',
  strength: 100,
  context: 0.2,
  weighting: 50,
};

test('new and saved default repair names use Short Sound Repair without changing custom names', () => {
  assert.equal(makeModule('spectral-repair').name, 'Short Sound Repair');
  const original = makeModule('spectral-repair', { name: 'Spectral Repair' });
  const custom = makeModule('spectral-repair', { name: 'My repair' });
  const [renamed, unchanged] = withoutLegacyDcModules([original, custom]);
  assert.equal(renamed.name, 'Short Sound Repair');
  assert.equal(unchanged.name, 'My repair');
  assert.equal(original.name, 'Spectral Repair');
  assert.equal(renamed.type, original.type);
});

function signal({ stereo = false, continuousTarget = false } = {}) {
  const duration = 2;
  const channels = stereo ? 2 : 1;
  return Array.from({ length: channels }, (_, channel) => Float32Array.from(
    { length: rate * duration },
    (_, frame) => {
      const time = frame / rate;
      const base = 0.17 * Math.sin(2 * Math.PI * 400 * time + channel * 0.3) +
        0.09 * Math.sin(2 * Math.PI * 3000 * time + channel * 0.2);
      const targetActive = continuousTarget || (time >= params.start && time < params.end);
      const target = targetActive ? 0.3 * Math.sin(2 * Math.PI * 1000 * time + (continuousTarget && time > 1 ? 1.2 : 0)) : 0;
      return base + target;
    },
  ));
}

function rmsProjection(channel, frequency, fromSeconds, toSeconds, sampleRate = rate) {
  const start = Math.floor(fromSeconds * sampleRate);
  const end = Math.floor(toSeconds * sampleRate);
  let real = 0;
  let imaginary = 0;
  for (let frame = start; frame < end; frame += 1) {
    const phase = 2 * Math.PI * frequency * frame / sampleRate;
    real += channel[frame] * Math.cos(phase);
    imaginary -= channel[frame] * Math.sin(phase);
  }
  return 2 * Math.hypot(real, imaginary) / (end - start);
}

test('repairs the selected band while preserving other frequencies and exact samples outside selection', () => {
  const input = signal();
  const source = input.map((channel) => channel.slice());
  const output = renderSpectralRepair(input, rate, params);
  assert.ok(rmsProjection(output[0], 1000, 0.95, 1.05) < rmsProjection(input[0], 1000, 0.95, 1.05) * 0.3);
  assert.ok(Math.abs(rmsProjection(output[0], 400, 0.95, 1.05) - rmsProjection(input[0], 400, 0.95, 1.05)) < 0.015);
  assert.ok(Math.abs(rmsProjection(output[0], 3000, 0.95, 1.05) - rmsProjection(input[0], 3000, 0.95, 1.05)) < 0.015);
  for (let frame = 0; frame < input[0].length; frame += 1) {
    if (frame < params.start * rate || frame >= params.end * rate) {
      assert.equal(output[0][frame], source[0][frame]);
    }
  }
  assert.deepEqual(input[0], source[0], 'source audio remains immutable');
});

test('a newly added enabled repair audibly differs from the same edit bypassed', () => {
  const input = signal();
  const module = {
    ...makeModule('spectral-repair'),
    params: { ...makeModule('spectral-repair').params, ...params, strength: 75 },
  };
  const edited = renderChain(input, [module], rate)[0];
  const bypassed = renderChain(input, [{ ...module, enabled: false }], rate)[0];
  assert.deepEqual(bypassed, input[0]);
  const originalTone = rmsProjection(bypassed, 1000, .95, 1.05);
  const editedTone = rmsProjection(edited, 1000, .95, 1.05);
  assert.ok(originalTone > .2, 'controlled defect is present in bypassed audio');
  assert.ok(editedTone < originalTone * .7, `edited target ${editedTone} must be lower than bypassed ${originalTone}`);
});

test('Attenuate retains local phase while Replace reconstructs from contextual complex spectra', () => {
  const input = signal({ continuousTarget: true });
  const attenuated = renderSpectralRepair(input, rate, params)[0];
  const replaced = renderSpectralRepair(input, rate, { ...params, mode: 'Replace' })[0];
  let squaredDifference = 0;
  let energy = 0;
  for (let frame = Math.floor(0.92 * rate); frame < Math.floor(1.08 * rate); frame += 1) {
    squaredDifference += (attenuated[frame] - replaced[frame]) ** 2;
    energy += input[0][frame] ** 2;
  }
  assert.ok(squaredDifference > energy * 0.005, 'the two spectral repair modes produce distinct audio');
});

test('supports stereo and keeps selection boundary transitions gradual', () => {
  const input = signal({ stereo: true, continuousTarget: true });
  const output = renderSpectralRepair(input, rate, params);
  assert.equal(output.length, 2);
  assert.equal(output[0].length, input[0].length);
  for (const channel of output) {
    const source = input[output.indexOf(channel)];
    const boundary = Math.floor(params.start * rate);
    const before = Math.abs(channel[Math.floor(params.start * rate) - 1] - channel[Math.floor(params.start * rate) - 2]);
    const atStart = Math.abs(channel[Math.floor(params.start * rate)] - channel[Math.floor(params.start * rate) - 1]);
    const after = Math.abs(channel[Math.floor(params.start * rate) + 1] - channel[Math.floor(params.start * rate)]);
    const originalBoundary = Math.abs(source[boundary] - source[boundary - 1]);
    assert.ok(Math.abs(atStart - originalBoundary) < 0.05);
    assert.ok(after < 0.3);
    assert.ok(before < 0.3);
  }
});

test('absolute frame offsets give parity for full and context-bounded source slices', () => {
  const input = signal();
  const fullResult = renderSpectralRepair(input, rate, params)[0];
  const sliceStart = Math.floor((params.start - params.context) * rate) - 2048;
  const sliceEnd = Math.ceil((params.end + params.context) * rate) + 2048;
  const boundedInput = [input[0].slice(sliceStart, sliceEnd)];
  const boundedResult = renderSpectralRepair(boundedInput, rate, params, sliceStart)[0];
  const selectedStart = Math.floor(params.start * rate);
  const selectedEnd = Math.ceil(params.end * rate);
  for (let frame = selectedStart; frame < selectedEnd; frame += 1) {
    assert.ok(Math.abs(fullResult[frame] - boundedResult[frame - sliceStart]) < 1e-6);
  }
});

test('repairs a 9 ms selection exactly on a hop boundary with smooth, bounded output', () => {
  const sampleRate = 16384;
  const start = 0.5;
  const end = 0.509;
  const input = [Float32Array.from({ length: sampleRate * 2 }, (_, frame) => {
    const time = frame / sampleRate;
    return time >= start && time < end ? 0.35 * Math.sin(2 * Math.PI * 1000 * time) : 0;
  })];
  const repairParams = {
    ...params,
    start,
    end,
    low: 850,
    high: 1150,
    context: 0.2,
  };
  const full = renderSpectralRepair(input, sampleRate, repairParams)[0];
  const selectionStart = Math.floor(start * sampleRate);
  const selectionEnd = Math.ceil(end * sampleRate);
  assert.ok(rmsProjection(full, 1000, start, selectionEnd / sampleRate, sampleRate) < 0.7 *
    rmsProjection(input[0], 1000, start, selectionEnd / sampleRate, sampleRate));
  assert.equal(full[selectionStart], input[0][selectionStart]);
  assert.equal(full[selectionEnd - 1], input[0][selectionEnd - 1]);
  for (let frame = 0; frame < input[0].length; frame += 1) {
    if (frame < selectionStart || frame >= selectionEnd) assert.equal(full[frame], input[0][frame]);
  }

  const sliceStart = Math.floor((start - repairParams.context) * sampleRate) - 2048;
  const sliceEnd = Math.ceil((end + repairParams.context) * sampleRate) + 2048;
  const bounded = renderSpectralRepair(
    [input[0].slice(sliceStart, sliceEnd)],
    sampleRate,
    repairParams,
    sliceStart,
  )[0];
  for (let frame = selectionStart; frame < selectionEnd; frame += 1) {
    assert.ok(Math.abs(full[frame] - bounded[frame - sliceStart]) < 1e-6);
  }
});

test('longer context avoids using a defect just before the selected edge as its estimate', () => {
  const input = [Float32Array.from({ length: rate * 2 }, (_, frame) => {
    const time = frame / rate;
    const bed = 0.12 * Math.sin(2 * Math.PI * 400 * time) + 0.06 * Math.sin(2 * Math.PI * 3000 * time);
    const edgeDefect = time >= 0.78 && time < 0.94 ?
      0.32 * Math.sin(2 * Math.PI * 1000 * time) : 0;
    return bed + edgeDefect;
  })];
  const selection = { ...params, start: 0.84, end: 1.15 };
  const shortContext = renderSpectralRepair(input, rate, { ...selection, context: 0.02 })[0];
  const longerContext = renderSpectralRepair(input, rate, { ...selection, context: 0.3 })[0];
  assert.ok(
    rmsProjection(longerContext, 1000, 0.87, 0.92) < rmsProjection(shortContext, 1000, 0.87, 0.92) * 0.6,
    'the farther clean context estimates the bed without carrying the edge defect',
  );
});

test('weighting 0 favors after context and weighting 100 favors before in both modes', () => {
  const input = [Float32Array.from({ length: rate * 2 }, (_, frame) => {
    const time = frame / rate;
    const amplitude = time < 0.8 ? 0.2 : time < 1.2 ? 0.35 : 0.04;
    return amplitude * Math.sin(2 * Math.PI * 1000 * time);
  })];
  for (const mode of ['Attenuate', 'Replace']) {
    const afterWeighted = renderSpectralRepair(input, rate, { ...params, mode, weighting: 0 })[0];
    const beforeWeighted = renderSpectralRepair(input, rate, { ...params, mode, weighting: 100 })[0];
    const afterLevel = rmsProjection(afterWeighted, 1000, 0.92, 1.08);
    const beforeLevel = rmsProjection(beforeWeighted, 1000, 0.92, 1.08);
    assert.ok(beforeLevel > afterLevel * 1.5, `${mode} weighting favors the requested context side`);
  }
});

test('Pattern Suppress uses a robust nearby level when isolated repeats contaminate reference frames', () => {
  const input = [Float32Array.from({ length: rate * 2 }, (_, frame) => {
    const time = frame / rate;
    const burst = (time >= .595 && time < .625) ||
      (time >= .9 && time < 1.1) || (time >= 1.395 && time < 1.425);
    return .1 * Math.sin(2 * Math.PI * 400 * time) +
      (burst ? .28 * Math.sin(2 * Math.PI * 1000 * time) : 0);
  })];
  const selection = { ...params, start: .85, end: 1.15 };
  const ordinary = renderSpectralRepair(input, rate, selection)[0];
  const patterned = renderSpectralRepair(input, rate, { ...selection, mode: 'Pattern Suppress' })[0];
  assert.ok(rmsProjection(patterned, 1000, .96, 1.04) < rmsProjection(ordinary, 1000, .96, 1.04) * .6);
  assert.ok(Math.abs(rmsProjection(patterned, 400, .96, 1.04) - .1) < .015);
  assert.equal(patterned[Math.floor(.5 * rate)], input[0][Math.floor(.5 * rate)]);
});

test('Harmonic Suppress targets multiples of the supplied fundamental, not other tones', () => {
  const input = [Float32Array.from({ length: rate * 2 }, (_, frame) => {
    const time = frame / rate;
    return .12 * Math.sin(2 * Math.PI * 850 * time) +
      .24 * Math.sin(2 * Math.PI * 600 * time) +
      .2 * Math.sin(2 * Math.PI * 1200 * time);
  })];
  const repaired = renderSpectralRepair(input, rate, {
    ...params, low: 500, high: 1350, fundamental: 600, mode: 'Harmonic Suppress',
  })[0];
  for (const frequency of [600, 1200]) {
    assert.ok(rmsProjection(repaired, frequency, .95, 1.05) <
      rmsProjection(input[0], frequency, .95, 1.05) * .55, `${frequency} Hz harmonic reduced`);
  }
  assert.ok(Math.abs(rmsProjection(repaired, 850, .95, 1.05) -
    rmsProjection(input[0], 850, .95, 1.05)) < .015);
  assert.throws(() => renderSpectralRepair(input, rate, {
    ...params, mode: 'Harmonic Suppress', fundamental: 0,
  }), /fundamental/);
  const entire = renderSpectralRepair(input, rate, {
    ...params, start: 0, end: 2, low: 500, high: 1350,
    fundamental: 600, mode: 'Harmonic Suppress',
  })[0];
  assert.ok(rmsProjection(entire, 600, .95, 1.05) < rmsProjection(input[0], 600, .95, 1.05) * .55,
    'a whole-recording selection does not require clean audio outside it');
});

test('Harmonic Suppress reduces unequal 50/60 Hz harmonic series at recording sample rates', () => {
  for (const [sampleRate, fundamental] of [[48000, 60], [44100, 50]]) {
    const input = [Float32Array.from({ length: sampleRate * 2 }, (_, frame) => {
      const time = frame / sampleRate;
      return .12 * Math.sin(2 * Math.PI * fundamental * time) +
        .48 * Math.sin(2 * Math.PI * 2 * fundamental * time) +
        .14 * Math.sin(2 * Math.PI * 3 * fundamental * time) +
        .08 * Math.sin(2 * Math.PI * 740 * time);
    })];
    const output = renderSpectralRepair(input, sampleRate, {
      ...params, mode: 'Harmonic Suppress', fundamental, low: 40, high: 400,
    })[0];
    for (const frequency of [fundamental, fundamental * 2, fundamental * 3]) {
      assert.ok(rmsProjection(output, frequency, .95, 1.05, sampleRate) <
        rmsProjection(input[0], frequency, .95, 1.05, sampleRate) * .7,
      `${sampleRate} Hz, ${frequency} Hz harmonic reduced`);
    }
    assert.ok(Math.abs(rmsProjection(output, 740, .95, 1.05, sampleRate) -
      rmsProjection(input[0], 740, .95, 1.05, sampleRate)) < .01);
  }
});

test('new modes agree at full and bounded offsets; strength zero bypasses exactly', () => {
  const input = signal({ stereo: true });
  for (const mode of ['Pattern Suppress', 'Harmonic Suppress']) {
    const settings = { ...params, mode, fundamental: 1000 };
    const full = renderSpectralRepair(input, rate, settings);
    const from = Math.floor((settings.start - settings.context) * rate) - 8192;
    const until = Math.ceil((settings.end + settings.context) * rate) + 8192;
    const bounded = renderSpectralRepair(input.map((ch) => ch.slice(from, until)), rate, settings, from);
    for (let c = 0; c < 2; c++) {
      for (let i = Math.floor(settings.start * rate); i < Math.ceil(settings.end * rate); i++) {
        assert.ok(Math.abs(full[c][i] - bounded[c][i - from]) < 1e-6, `${mode} offset parity at ${i}`);
      }
      assert.deepEqual(renderSpectralRepair(input, rate, { ...settings, strength: 0 })[c], input[c]);
    }
  }
});

test('validates parameters and finite audio only in the bounded repair work interval', () => {
  const input = signal();
  assert.throws(() => renderSpectralRepair(input, rate, { ...params, end: 11 }), /10 seconds/);
  assert.throws(() => renderSpectralRepair(input, rate, { ...params, high: rate }), /Nyquist/);
  assert.throws(() => renderSpectralRepair(input, rate, { ...params, context: 0.01 }), /Context/);
  const invalid = [input[0].slice()];
  invalid[0][0] = Number.NaN;
  assert.doesNotThrow(() => renderSpectralRepair(invalid, rate, params));
  invalid[0][rate] = Number.NaN;
  assert.throws(() => renderSpectralRepair(invalid, rate, params), /finite samples/);
});