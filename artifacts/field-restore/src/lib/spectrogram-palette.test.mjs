import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SPECTROGRAM_PALETTE, SPECTROGRAM_PALETTES, spectrogramColor, spectrogramLegendStops } from './spectrogram-palette.ts';

test('reference scale retains dark quiet detail and reserves pale yellow for the highest levels', () => {
  assert.equal(DEFAULT_SPECTROGRAM_PALETTE, 'night-copper');
  const palette = SPECTROGRAM_PALETTES[DEFAULT_SPECTROGRAM_PALETTE];
  assert.deepEqual(spectrogramColor(0, DEFAULT_SPECTROGRAM_PALETTE), [0, 1, 3]);
  assert.deepEqual(spectrogramColor(.2, DEFAULT_SPECTROGRAM_PALETTE), [10, 26, 51]);
  assert.deepEqual(spectrogramColor(.5, DEFAULT_SPECTROGRAM_PALETTE), [53, 59, 70]);
  assert.deepEqual(spectrogramColor(.7, DEFAULT_SPECTROGRAM_PALETTE), [178, 91, 41]);
  assert.deepEqual(spectrogramColor(1, DEFAULT_SPECTROGRAM_PALETTE), [254, 254, 246]);
  assert.deepEqual(spectrogramColor(-1, DEFAULT_SPECTROGRAM_PALETTE), spectrogramColor(0, DEFAULT_SPECTROGRAM_PALETTE));
  assert.deepEqual(spectrogramColor(2, DEFAULT_SPECTROGRAM_PALETTE), spectrogramColor(1, DEFAULT_SPECTROGRAM_PALETTE));
  assert.ok(palette.stops.every(([position], index) => index === 0 || position > palette.stops[index - 1][0]));
});

test('level legend has every palette stop in bright-to-dark order', () => {
  for (const id of Object.keys(SPECTROGRAM_PALETTES)) {
    const stops = SPECTROGRAM_PALETTES[id].stops;
    const legend = spectrogramLegendStops(id);
    assert.equal(legend.length, stops.length);
    assert.deepEqual(legend[0], [0, stops.at(-1)[1]]);
    assert.deepEqual(legend.at(-1), [1, stops[0][1]]);
    assert.ok(legend.every(([position], index) => index === 0 || position > legend[index - 1][0]));
    for (const [position, color] of legend) {
      assert.deepEqual(spectrogramColor(1 - position, id), [
        parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16),
      ]);
    }
  }
});