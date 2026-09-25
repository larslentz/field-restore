/// <reference lib="webworker" />
import { analyzeLoudness, type LoudnessStats } from './loudness';

export type MemoryLoudnessResult = {
  original: LoudnessStats;
  current: LoudnessStats;
  selectionOriginal: LoudnessStats;
  selectionCurrent: LoudnessStats;
};
type Request = {
  original: Float32Array[];
  current: Float32Array[];
  sampleRate: number;
  kept: [number, number];
  selection: [number, number] | null;
};

const scope = self as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<Request>) => {
  try {
    const { original, current, sampleRate, kept, selection } = event.data;
    const empty: LoudnessStats = { truePeakDbtp: -Infinity, integratedLufs: -Infinity, loudnessRangeLu: NaN, maxShortTermLufs: -Infinity, plrLu: NaN, lbpr: { valueDb: NaN, channels: [] } };
    const result: MemoryLoudnessResult = {
      original: analyzeLoudness(original, sampleRate),
      current: analyzeLoudness(current, sampleRate, kept[0], kept[1]),
      selectionOriginal: selection ? analyzeLoudness(original, sampleRate, selection[0], selection[1]) : empty,
      selectionCurrent: selection && Math.min(selection[1], kept[1]) > Math.max(selection[0], kept[0])
        ? analyzeLoudness(current, sampleRate, Math.max(selection[0], kept[0]), Math.min(selection[1], kept[1])) : empty,
    };
    scope.postMessage({ type: 'result', result });
  } catch (caught) {
    scope.postMessage({ type: 'error', message: caught instanceof Error ? caught.message : 'Loudness analysis failed.' });
  }
};