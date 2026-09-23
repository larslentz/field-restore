export interface PlaybackRangeInput {
  duration: number;
  loop: boolean;
  sampleRate: number;
  selection: [number, number];
  startPosition: number;
  totalFrames: number;
}

export interface PlaybackRangePlan {
  bufferEndFrame: number;
  bufferLoopEnd: number;
  bufferLoopStart: number;
  bufferStartFrame: number;
  bufferStartOffset: number;
  hasSelection: boolean;
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
}: PlaybackRangeInput): PlaybackRangePlan {
  const selectedStart = Math.max(0, Math.min(selection[0], selection[1]));
  const selectedEnd = Math.min(duration, Math.max(selection[0], selection[1]));
  const hasSelection = selectedEnd - selectedStart >= 0.01;
  const bufferStartFrame = hasSelection ? Math.max(0, Math.floor(selectedStart * sampleRate)) : 0;
  const bufferEndFrame = hasSelection ? Math.min(totalFrames, Math.ceil(selectedEnd * sampleRate)) : totalFrames;
  const timelineStart = hasSelection
    ? bufferStartFrame / sampleRate
    : Math.min(Math.max(0, startPosition), Math.max(0, duration - 0.01));
  const timelineEnd = hasSelection ? bufferEndFrame / sampleRate : duration;
  const selectedBufferDuration = Math.max(1, bufferEndFrame - bufferStartFrame) / sampleRate;

  return {
    bufferEndFrame,
    bufferLoopEnd: hasSelection ? selectedBufferDuration : timelineEnd,
    bufferLoopStart: hasSelection ? 0 : timelineStart,
    bufferStartFrame,
    bufferStartOffset: hasSelection ? 0 : timelineStart,
    hasSelection,
    timelineEnd,
    timelineStart,
    timelineStartFrame: hasSelection ? bufferStartFrame : Math.max(0, Math.min(totalFrames, Math.floor(timelineStart * sampleRate))),
  };
}