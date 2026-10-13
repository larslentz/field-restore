// Controlled digital clipping of the permission-cleared wind-night-stereo.wav.
// NOT a recording of microphone overload. See README.md for derivation/limits.
export function controlledClippedWind(recorded, sampleRate, gain) {
  const frames = sampleRate * 6;
  return recorded.map((channel) => {
    const output = new Float32Array(frames);
    for (let i = 0; i < channel.length; i++) {
      const taper = Math.min(1, i / (sampleRate * .01),
        (channel.length - 1 - i) / (sampleRate * .01));
      output[sampleRate + i] = Math.max(-1, Math.min(1, channel[i] * taper * gain));
    }
    return output;
  });
}
