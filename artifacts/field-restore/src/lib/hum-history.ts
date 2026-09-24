/** Only positions heard through processed playback belong in this local history. */
export type HumHistorySegment = {
  moduleId: string;
  startFrame: number;
  endFrame: number;
  frequencies: number[];
};

export const MAX_HUM_HISTORY_SEGMENTS = 160;

export type VisibleHumSegment = {
  segment: HumHistorySegment;
  left: number;
  right: number;
  seekFrame: number;
};

/** Clip only retained observations to the visible time window; never interpolate gaps. */
export function visibleHumHistory(
  history: HumHistorySegment[],
  sampleRate: number,
  startSeconds: number,
  durationSeconds: number,
): VisibleHumSegment[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 ||
      !Number.isFinite(startSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const first = startSeconds * sampleRate;
  const last = (startSeconds + durationSeconds) * sampleRate;
  const span = last - first;
  return history.slice(-MAX_HUM_HISTORY_SEGMENTS).flatMap((segment) => {
    if (!Number.isFinite(segment.startFrame) || !Number.isFinite(segment.endFrame) ||
        segment.endFrame < segment.startFrame || segment.endFrame < first || segment.startFrame > last) return [];
    const seekFrame = Math.max(first, segment.startFrame);
    return [{
      segment,
      left: (seekFrame - first) / span,
      right: (Math.min(last, segment.endFrame) - first) / span,
      seekFrame,
    }];
  });
}

export function recordHumHistory(
  history: HumHistorySegment[],
  moduleId: string,
  frame: number,
  frequencies: number[],
  sampleRate: number,
): HumHistorySegment[] {
  if (!Number.isFinite(frame) || !Number.isFinite(sampleRate) || sampleRate <= 0) return history;
  const position = Math.max(0, Math.floor(frame));
  const index = history.findLastIndex((entry) => entry.moduleId === moduleId);
  const previous = history[index];
  const contiguous = previous && position >= previous.endFrame && position - previous.endFrame <= sampleRate * .5;
  const same = previous && previous.frequencies.length === frequencies.length &&
    previous.frequencies.every((value, i) => Math.abs(value - frequencies[i]) < .05);
  if (contiguous && same) {
    if (position === previous.endFrame) return history;
    return history.map((entry, i) => i === index ? { ...entry, endFrame: position } : entry);
  }
  const next = [...history];
  if (contiguous && previous && !same) next[index] = { ...previous, endFrame: position };
  next.push({ moduleId, startFrame: position, endFrame: position, frequencies: [...frequencies] });
  return next.length > MAX_HUM_HISTORY_SEGMENTS ? next.slice(-MAX_HUM_HISTORY_SEGMENTS) : next;
}