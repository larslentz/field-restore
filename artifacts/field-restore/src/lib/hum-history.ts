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

function sameFrequencies(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) < .05);
}

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
  const visits = history.slice(-MAX_HUM_HISTORY_SEGMENTS).flatMap((segment) => {
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
  const visible: VisibleHumSegment[] = [];
  for (const visit of visits) {
    let combined = visit;
    for (let i = visible.length - 1; i >= 0; i--) {
      const prior = visible[i];
      if (prior.segment.moduleId !== combined.segment.moduleId ||
          !sameFrequencies(prior.segment.frequencies, combined.segment.frequencies) ||
          prior.left > combined.right || combined.left > prior.right) continue;
      combined = {
        segment: prior.seekFrame <= combined.seekFrame ? prior.segment : combined.segment,
        left: Math.min(prior.left, combined.left),
        right: Math.max(prior.right, combined.right),
        seekFrame: Math.min(prior.seekFrame, combined.seekFrame),
      };
      visible.splice(i, 1);
    }
    visible.push(combined);
  }
  return visible.sort((a, b) => a.left - b.left);
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
  const same = previous && sameFrequencies(previous.frequencies, frequencies);
  if (contiguous && same) {
    if (position === previous.endFrame) return history;
    return history.map((entry, i) => i === index ? { ...entry, endFrame: position } : entry);
  }
  const next = [...history];
  if (contiguous && previous && !same) next[index] = { ...previous, endFrame: position };
  next.push({ moduleId, startFrame: position, endFrame: position, frequencies: [...frequencies] });
  return next.length > MAX_HUM_HISTORY_SEGMENTS ? next.slice(-MAX_HUM_HISTORY_SEGMENTS) : next;
}