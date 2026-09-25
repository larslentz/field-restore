export type WindActivityEvent = {
  moduleId: string;
  frame: number;
  active: boolean;
};

export type WindHistorySegment = {
  moduleId: string;
  startFrame: number;
  endFrame: number;
  active: boolean;
};

export const MAX_WIND_HISTORY_SEGMENTS = 160;

/** Events are kept in processing order so repeated loops can override earlier visits. */
export function windActivityAt(events: WindActivityEvent[], moduleId: string, frame: number): boolean | null {
  if (!Number.isFinite(frame)) return null;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].moduleId === moduleId && events[index].frame <= frame) return events[index].active;
  }
  return null;
}

/** Efficient lookup for the fully rendered in-memory event list, which is frame-sorted. */
export function windActivityAtSorted(events: WindActivityEvent[], moduleId: string, frame: number): boolean | null {
  if (!Number.isFinite(frame)) return null;
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle].frame <= frame) low = middle + 1;
    else high = middle;
  }
  for (let index = low - 1; index >= 0; index--) {
    if (events[index].moduleId === moduleId) return events[index].active;
  }
  return null;
}

/** Retain only recent observations from processed playback; do not fill seek gaps. */
export function recordWindHistory(
  history: WindHistorySegment[],
  moduleId: string,
  frame: number,
  active: boolean,
  sampleRate: number,
  startNewVisit = false,
): WindHistorySegment[] {
  if (!Number.isFinite(frame) || !Number.isFinite(sampleRate) || sampleRate <= 0) return history;
  const position = Math.max(0, Math.floor(frame));
  const index = history.findLastIndex((entry) => entry.moduleId === moduleId);
  const previous = history[index];
  const contiguous = !startNewVisit && previous && position >= previous.endFrame &&
    position - previous.endFrame <= sampleRate * .5;

  if (contiguous && previous.active === active) {
    if (position === previous.endFrame) return history;
    return history.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, endFrame: position } : entry);
  }

  const next = [...history];
  if (contiguous && previous) next[index] = { ...previous, endFrame: position };
  next.push({ moduleId, startFrame: position, endFrame: position, active });
  return next.length > MAX_WIND_HISTORY_SEGMENTS
    ? next.slice(-MAX_WIND_HISTORY_SEGMENTS)
    : next;
}