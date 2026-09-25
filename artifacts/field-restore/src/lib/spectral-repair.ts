/**
 * Bounded, non-destructive spectral repair. Selection times are absolute
 * recording times; frameOffset identifies the absolute start of each input
 * channel when rendering a contextual slice.
 */
type ComplexFrame = { real: Float64Array; imaginary: Float64Array };

const FFT_SIZE = 2048;
const HOP_SIZE = FFT_SIZE / 4;

function fft(real: Float64Array, imaginary: Float64Array, inverse = false) {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let size = 2; size <= length; size <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < length; start += size) {
      let phaseReal = 1;
      let phaseImaginary = 0;
      for (let offset = 0; offset < size / 2; offset += 1) {
        const even = start + offset;
        const odd = even + size / 2;
        const oddReal = real[odd] * phaseReal - imaginary[odd] * phaseImaginary;
        const oddImaginary = real[odd] * phaseImaginary + imaginary[odd] * phaseReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = phaseReal * stepReal - phaseImaginary * stepImaginary;
        phaseImaginary = phaseReal * stepImaginary + phaseImaginary * stepReal;
        phaseReal = nextReal;
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < length; index += 1) {
      real[index] /= length;
      imaginary[index] /= length;
    }
  }
}

const hann = Float64Array.from({ length: FFT_SIZE }, (_, index) =>
  0.5 - 0.5 * Math.cos(2 * Math.PI * index / (FFT_SIZE - 1)));

function readFrame(channel: Float32Array, frameOffset: number, center: number): ComplexFrame {
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  const first = center - FFT_SIZE / 2;
  for (let index = 0; index < FFT_SIZE; index += 1) {
    const localFrame = first + index - frameOffset;
    if (localFrame >= 0 && localFrame < channel.length) real[index] = channel[localFrame] * hann[index];
  }
  fft(real, imaginary);
  return { real, imaginary };
}

function smoothstep(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function validate(
  input: Float32Array[],
  sampleRate: number,
  params: Record<string, number | string>,
  frameOffset: number,
) {
  if (!Array.isArray(input) || input.length === 0 || input.some((channel) => !(channel instanceof Float32Array))) {
    throw new TypeError('Spectral repair requires one or more Float32Array channels.');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('Sample rate must be a positive finite number.');
  if (!Number.isSafeInteger(frameOffset) || frameOffset < 0) throw new RangeError('Frame offset must be a non-negative integer.');
  const start = Number(params.start);
  const end = Number(params.end);
  const low = Number(params.low);
  const high = Number(params.high);
  const strength = Number(params.strength);
  const context = Number(params.context);
  const weighting = Number(params.weighting);
  const mode = String(params.mode);
  if (![start, end, low, high, strength, context, weighting].every(Number.isFinite)) {
    throw new RangeError('Spectral repair parameters must be finite numbers.');
  }
  if (start < 0 || end <= start || end - start > 10) {
    throw new RangeError('Selection must be positive and no longer than 10 seconds.');
  }
  if (low < 0 || high <= low || high > sampleRate / 2) {
    throw new RangeError('Frequency band must be ordered and within the sample-rate Nyquist limit.');
  }
  if (strength < 0 || strength > 100) throw new RangeError('Strength must be between 0 and 100.');
  if (context < 0.02 || context > 1) throw new RangeError('Context must be between 0.02 and 1 second.');
  if (weighting < 0 || weighting > 100) throw new RangeError('Weighting must be between 0 and 100.');
  if (mode !== 'Attenuate' && mode !== 'Replace') throw new RangeError('Mode must be Attenuate or Replace.');
  return { start, end, low, high, strength, context, weighting, mode };
}

/**
 * Repairs a selected time-frequency region using neighboring clean STFT
 * frames. Weighting sets the before/after blend in both modes: 0 favors after,
 * 50 follows balanced temporal interpolation, and 100 favors before. Work is
 * limited to selection, requested context and one FFT overlap margin.
 */
export function renderSpectralRepair(
  input: Float32Array[],
  sampleRate: number,
  params: Record<string, number | string>,
  frameOffset = 0,
): Float32Array[] {
  const { start, end, low, high, strength, context, weighting, mode } =
    validate(input, sampleRate, params, frameOffset);
  const output = input.map((channel) => new Float32Array(channel));
  if (strength === 0) return output;

  const selectionStart = Math.floor(start * sampleRate);
  const selectionEnd = Math.ceil(end * sampleRate);
  const firstLocalStart = Math.max(selectionStart, frameOffset);
  const firstLocalEnd = Math.min(selectionEnd, frameOffset + (input[0]?.length ?? 0));
  if (firstLocalEnd <= firstLocalStart) return output;

  const contextFrames = Math.ceil(context * sampleRate);
  const workStart = Math.max(0, selectionStart - contextFrames - FFT_SIZE);
  const workEnd = selectionEnd + contextFrames + FFT_SIZE;
  const firstCenter = Math.floor(workStart / HOP_SIZE) * HOP_SIZE;
  const lastCenter = Math.ceil(workEnd / HOP_SIZE) * HOP_SIZE;
  const firstReadFrame = firstCenter - FFT_SIZE / 2;
  const lastReadFrame = lastCenter + FFT_SIZE / 2;
  input.forEach((channel) => {
    const firstLocalFrame = Math.max(0, firstReadFrame - frameOffset);
    const lastLocalFrame = Math.min(channel.length, lastReadFrame - frameOffset);
    for (let frame = firstLocalFrame; frame < lastLocalFrame; frame += 1) {
      if (!Number.isFinite(channel[frame])) throw new RangeError('Input audio in the repair work interval must contain only finite samples.');
    }
  });

  const localStart = firstLocalStart;
  const localEnd = firstLocalEnd;
  if (localEnd <= localStart) return output;

  const centers: number[] = [];
  for (let center = firstCenter; center <= lastCenter; center += HOP_SIZE) centers.push(center);

  const safeContextDistance = Math.max(contextFrames, FFT_SIZE / 2);
  const beforeTarget = selectionStart - safeContextDistance;
  const afterTarget = selectionEnd + safeContextDistance;
  let beforeIndex = -1;
  let afterIndex = -1;
  for (let index = 0; index < centers.length; index += 1) {
    const hasFullSourceWindow = centers[index] - FFT_SIZE / 2 >= frameOffset &&
      centers[index] + FFT_SIZE / 2 <= frameOffset + input[0].length;
    if (!hasFullSourceWindow) continue;
    if (centers[index] <= beforeTarget) beforeIndex = index;
    if (afterIndex < 0 && centers[index] >= afterTarget) afterIndex = index;
  }
  // At an actual recording edge one side may not exist; re-use the available clean side.
  if (beforeIndex < 0) beforeIndex = afterIndex;
  if (afterIndex < 0) afterIndex = beforeIndex;
  if (beforeIndex < 0 || afterIndex < 0) return output;

  const binWidth = sampleRate / FFT_SIZE;
  const lowBin = low / binWidth;
  const highBin = high / binWidth;
  const edgeBins = 2;
  const frequencyMask = new Float64Array(FFT_SIZE / 2 + 1);
  for (let bin = 0; bin < frequencyMask.length; bin += 1) {
    const lowFade = smoothstep((bin - (lowBin - edgeBins)) / (2 * edgeBins));
    const highFade = smoothstep(((highBin + edgeBins) - bin) / (2 * edgeBins));
    frequencyMask[bin] = Math.min(lowFade, highFade);
  }

  const selectionFrames = selectionEnd - selectionStart;
  const fadeFrames = Math.min(Math.round(sampleRate * 0.035), Math.floor(selectionFrames / 3));
  const wet = strength / 100;
  input.forEach((channel, channelIndex) => {
    const spectra = centers.map((center) => readFrame(channel, frameOffset, center));
    const before = {
      real: spectra[beforeIndex].real.slice(),
      imaginary: spectra[beforeIndex].imaginary.slice(),
    };
    const after = {
      real: spectra[afterIndex].real.slice(),
      imaginary: spectra[afterIndex].imaginary.slice(),
    };
    const channelStart = Math.max(selectionStart, frameOffset);
    const channelEnd = Math.min(selectionEnd, frameOffset + channel.length);
    if (channelEnd <= channelStart) return;
    const localChannelStart = channelStart - frameOffset;
    const accum = new Float64Array(channelEnd - channelStart);
    const normalization = new Float64Array(channelEnd - channelStart);

    for (let frameIndex = 0; frameIndex < centers.length; frameIndex += 1) {
      const center = centers[frameIndex];
      const spectrum = spectra[frameIndex];
      const intersectionStart = Math.max(center - FFT_SIZE / 2, selectionStart);
      const intersectionEnd = Math.min(center + FFT_SIZE / 2, selectionEnd);
      if (intersectionEnd > intersectionStart) {
        const position = Math.max(0, Math.min(1,
          (center - centers[beforeIndex]) / Math.max(1, centers[afterIndex] - centers[beforeIndex])));
        const weightingPosition = weighting / 100;
        const beforeWeight = weightingPosition <= 0.5
          ? 2 * weightingPosition * (1 - position)
          : 1 - 2 * (1 - weightingPosition) * position;
        const intersectionMask = Math.min(1,
          (intersectionEnd - intersectionStart) / Math.min(selectionFrames, FFT_SIZE));
        const blend = wet * intersectionMask;

        for (let bin = 0; bin < frequencyMask.length; bin += 1) {
          const mask = frequencyMask[bin];
          const amount = blend * mask;
          if (amount <= 0) continue;
          const real = spectrum.real[bin];
          const imaginary = spectrum.imaginary[bin];
          let targetReal: number;
          let targetImaginary: number;
          if (mode === 'Replace') {
            const beforeReal = before.real[bin];
            const beforeImaginary = before.imaginary[bin];
            const afterReal = after.real[bin];
            const afterImaginary = after.imaginary[bin];
            targetReal = beforeReal * beforeWeight + afterReal * (1 - beforeWeight);
            targetImaginary = beforeImaginary * beforeWeight + afterImaginary * (1 - beforeWeight);
          } else {
            const beforeMagnitude = Math.hypot(before.real[bin], before.imaginary[bin]);
            const afterMagnitude = Math.hypot(after.real[bin], after.imaginary[bin]);
            const contextual = beforeMagnitude * beforeWeight + afterMagnitude * (1 - beforeWeight);
            const sourceMagnitude = Math.hypot(real, imaginary);
            const targetMagnitude = Math.min(sourceMagnitude, contextual);
            const gain = sourceMagnitude > 1e-15 ? targetMagnitude / sourceMagnitude : 1;
            targetReal = real * gain;
            targetImaginary = imaginary * gain;
          }
          spectrum.real[bin] = real + (targetReal - real) * amount;
          spectrum.imaginary[bin] = imaginary + (targetImaginary - imaginary) * amount;
          if (bin > 0 && bin < FFT_SIZE / 2) {
            const mirror = FFT_SIZE - bin;
            spectrum.real[mirror] = spectrum.real[bin];
            spectrum.imaginary[mirror] = -spectrum.imaginary[bin];
          }
        }
      }
      fft(spectrum.real, spectrum.imaginary, true);
      const frameStart = center - FFT_SIZE / 2 - frameOffset;
      for (let index = 0; index < FFT_SIZE; index += 1) {
        const outputIndex = frameStart + index;
        if (outputIndex < 0 || outputIndex >= channel.length ||
          outputIndex < localChannelStart || outputIndex >= channelEnd - frameOffset) continue;
        const window = hann[index];
        const localOutputIndex = outputIndex - localChannelStart;
        accum[localOutputIndex] += spectrum.real[index] * window;
        normalization[localOutputIndex] += window * window;
      }
    }
    for (let frame = 0; frame < accum.length; frame += 1) {
      if (normalization[frame] > 1e-12) {
        const absoluteFrame = frameOffset + localChannelStart + frame;
        let timeTaper = 1;
        if (fadeFrames > 0) {
          const fadeIn = smoothstep((absoluteFrame - selectionStart) / fadeFrames);
          const fadeOut = smoothstep((selectionEnd - 1 - absoluteFrame) / fadeFrames);
          timeTaper = Math.min(fadeIn, fadeOut);
        }
        const repaired = accum[frame] / normalization[frame];
        const dry = channel[localChannelStart + frame];
        output[channelIndex][localChannelStart + frame] = dry + (repaired - dry) * timeTaper;
      }
    }
  });
  return output;
}