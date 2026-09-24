export type SpectrogramPaletteId = 'night-copper' | 'cyan-orange' | 'field-restore' | 'magma' | 'grayscale';

export const DEFAULT_SPECTROGRAM_PALETTE: SpectrogramPaletteId = 'night-copper';

export const SPECTROGRAM_PALETTES: Record<SpectrogramPaletteId, {
  label: string;
  description: string;
  stops: Array<[number, string]>;
}> = {
  'night-copper': {
    label: 'Night copper',
    description: 'Black and midnight blue with copper highlights',
    stops: [
      [0, '#000103'], [0.1, '#000a19'], [0.2, '#0a1a33'], [0.3, '#132744'],
      [0.4, '#1e314d'], [0.5, '#353b46'], [0.6, '#684333'], [0.7, '#b25b29'],
      [0.8, '#e99436'], [0.9, '#f8d66e'], [1, '#fefef6'],
    ],
  },
  'cyan-orange': {
    label: 'Cyan → orange',
    description: 'Cool detail with warm peaks',
    stops: [[0, '#071018'], [0.2, '#0a2943'], [0.4, '#075e78'], [0.58, '#09a4b1'], [0.73, '#7bd1be'], [0.86, '#e5cf72'], [1, '#f1873f']],
  },
  'field-restore': {
    label: 'Field Restore',
    description: 'Original blue, green, and amber scale',
    stops: [[0, '#0e1b26'], [0.35, '#2d6570'], [0.55, '#547b7b'], [0.72, '#989a56'], [1, '#f0a12e']],
  },
  magma: {
    label: 'Magma',
    description: 'Dark violet through coral and gold',
    stops: [[0, '#09071b'], [0.24, '#32115d'], [0.48, '#7b2382'], [0.7, '#d64d68'], [0.86, '#f58b4b'], [1, '#f8df8b']],
  },
  grayscale: {
    label: 'Grayscale',
    description: 'Neutral monochrome contrast',
    stops: [[0, '#090d10'], [0.35, '#303b42'], [0.68, '#87949a'], [1, '#f2f4ed']],
  },
};

function hexToRgb(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16, (value >> 8) & 255, value & 255] as const;
}

export function spectrogramColor(intensity: number, paletteId: SpectrogramPaletteId) {
  const stops = SPECTROGRAM_PALETTES[paletteId].stops;
  const value = Math.max(0, Math.min(1, intensity));
  const upperIndex = stops.findIndex(([position]) => position >= value);
  if (upperIndex <= 0) return hexToRgb(stops[0][1]);
  const [lowerPosition, lowerHex] = stops[upperIndex - 1];
  const [upperPosition, upperHex] = stops[upperIndex];
  const amount = (value - lowerPosition) / Math.max(0.0001, upperPosition - lowerPosition);
  const lower = hexToRgb(lowerHex);
  const upper = hexToRgb(upperHex);
  return lower.map((channel, index) => Math.round(channel + (upper[index] - channel) * amount)) as unknown as readonly [number, number, number];
}

export function spectrogramColorCss(intensity: number, paletteId: SpectrogramPaletteId) {
  const [red, green, blue] = spectrogramColor(intensity, paletteId);
  return `rgb(${red}, ${green}, ${blue})`;
}

/** Canvas gradients run top to bottom; the brightest color belongs at the top. */
export function spectrogramLegendStops(paletteId: SpectrogramPaletteId) {
  return SPECTROGRAM_PALETTES[paletteId].stops
    .map(([position, color]) => [1 - position, color] as const)
    .reverse();
}