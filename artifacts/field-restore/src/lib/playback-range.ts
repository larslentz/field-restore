export interface PlaybackRangeInput {
  duration: number;
  loop: boolean;
  sampleRate: number;
  selection: [number, number];
  startPosition: number;
  totalFrames: number;
  trim?: [number, number];
}

export interface PlaybackRangePlan {
  bufferEndFrame: number;
  bufferLoopEnd: number;
  bufferLoopStart: number;
  bufferStartFrame: number;
  bufferStartOffset: number;
  hasSelection: boolean;
  emptySelection: boolean;
  timelineEnd: number;
  timelineStart: number;
  timelineStartFrame: number;
}

export function createPlaybackRangePlan({
  duration,
  loop,
  sampleRate,
  selection,
  startPosition,
  totalFrames,
  trim,
}: PlaybackRangeInput): PlaybackRangePlan {
  const trimStart = trim ? Math.max(0, Math.min(totalFrames - 1, Math.floor(trim[0] * sampleRate))) : 0;
  const trimEnd = trim ? Math.max(trimStart + 1, Math.min(totalFrames, Math.ceil(trim[1] * sampleRate))) : totalFrames;
  const selectedStart = Math.max(0, Math.min(selection[0], selection[1]));
  const selectedEnd = Math.min(duration, Math.max(selection[0], selection[1]));
  const selectedStartFrame = Math.max(trimStart, Math.floor(selectedStart * sampleRate));
  const selectedEndFrame = Math.min(trimEnd, Math.ceil(selectedEnd * sampleRate));
  const emptySelection = selectedEnd - selectedStart >= 0.01 && selectedEndFrame <= selectedStartFrame;
  const hasSelection = selectedEnd - selectedStart >= 0.01 && selectedEndFrame - selectedStartFrame >= Math.max(1, sampleRate * 0.01);
  const bufferStartFrame = hasSelection ? selectedStartFrame : trimStart;
  const bufferEndFrame = hasSelection ? selectedEndFrame : trimEnd;
  const timelineStart = hasSelection
    ? bufferStartFrame / sampleRate
    : Math.max(trimStart / sampleRate, Math.min(startPosition, Math.max(trimStart, trimEnd - 1) / sampleRate));
  const timelineEnd = bufferEndFrame / sampleRate;
  const selectedBufferDuration = Math.max(1, bufferEndFrame - bufferStartFrame) / sampleRate;

  return {
    bufferEndFrame,
    bufferLoopEnd: hasSelection ? selectedBufferDuration : (bufferEndFrame - bufferStartFrame) / sampleRate,
    bufferLoopStart: hasSelection ? 0 : timelineStart - bufferStartFrame / sampleRate,
    bufferStartFrame,
    bufferStartOffset: hasSelection ? 0 : timelineStart - bufferStartFrame / sampleRate,
    hasSelection,
    emptySelection,
    timelineEnd,
    timelineStart,
    timelineStartFrame: hasSelection ? bufferStartFrame : Math.max(trimStart, Math.min(trimEnd - 1, Math.floor(timelineStart * sampleRate))),
  };
}