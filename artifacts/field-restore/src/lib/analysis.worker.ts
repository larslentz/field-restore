/// <reference lib="webworker" />

import { analyzeLargeLoudness } from './large-analysis';
import { calculateFileSpectrogram } from './large-spectrogram';
import { readAudioFrames } from './source-audio';
import { analyzeFileInitialHum, createStreamingEditChain } from './streaming-edit-chain';
import type { WorkerInboundMessage, WorkerJobRequest, WorkerOutboundMessage } from './analysis-worker-protocol';

const scope = self as DedicatedWorkerGlobalScope;
let paused = false;
let cancelled = false;
let resumeWaiters: Array<() => void> = [];

function send(message: WorkerOutboundMessage, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

function abortIfCancelled() {
  if (cancelled) throw new DOMException('The operation was cancelled.', 'AbortError');
}

async function checkpoint() {
  abortIfCancelled();
  if (!paused) return;
  await new Promise<void>((resolve) => resumeWaiters.push(resolve));
  abortIfCancelled();
}

async function run(request: WorkerJobRequest) {
  await checkpoint();
  const initialHumFrequencies = request.modules
    ? await analyzeFileInitialHum(request.file, request.kind === 'loudness' ? request.warmup?.metadata ?? request.metadata : request.metadata, request.modules)
    : [];
  await checkpoint();
  if (request.kind === 'spectrogram') {
    const channelIndex = request.options.channelIndex ?? 0;
    const continuousTransform = request.modules?.some((module) =>
      module.enabled && module.type === 'noise' && Number(module.params.strength) > 0) ?? false;
    const continuousProcessor = continuousTransform
      ? createStreamingEditChain(request.modules, request.metadata.sampleRate, request.metadata.frameCount, 0, initialHumFrequencies)
      : undefined;
    const result = await calculateFileSpectrogram(request.file, request.metadata, {
      ...request.options,
      checkpoint,
      continuousTransform,
      transform: (channels, frame) => {
        if (!channels[channelIndex]) return channels;
        if (continuousProcessor) return continuousProcessor.process(channels, frame);
        return createStreamingEditChain(
          request.modules,
          request.metadata.sampleRate,
          request.metadata.frameCount,
          frame,
          initialHumFrequencies,
        ).process(channels, frame);
      },
      onProgress: (completed, total) => send({ type: 'progress', fraction: total ? completed / total : 1 }),
    });
    send({ type: 'result', result }, [result.values.buffer]);
    return;
  }

  const offset = request.frameOffset ?? 0;
  const processor = request.modules
    ? createStreamingEditChain(request.modules, request.metadata.sampleRate, request.sourceFrameCount ?? request.metadata.frameCount, request.warmup?.startFrame ?? offset, initialHumFrequencies)
    : null;
  if (processor && request.warmup?.frameCount) {
    const { metadata, startFrame, frameCount } = request.warmup;
    const chunkFrames = Math.max(4096, metadata.sampleRate * 2);
    for (let frame = startFrame; frame < startFrame + frameCount; frame += chunkFrames) {
      await checkpoint();
      const channels = await readAudioFrames(request.file, metadata, frame, Math.min(chunkFrames, startFrame + frameCount - frame));
      await checkpoint();
      processor.process(channels, frame);
    }
  }
  const result = await analyzeLargeLoudness(request.file, request.metadata, {
    checkpoint,
    transform: processor ? (channels, frame) => processor.process(channels, offset + frame) : undefined,
    onProgress: ({ fraction }) => send({ type: 'progress', fraction }),
  });
  send({ type: 'result', result });
}

scope.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const message = event.data;
  if (message.type === 'pause') {
    paused = true;
    return;
  }
  if (message.type === 'resume') {
    paused = false;
    const waiters = resumeWaiters;
    resumeWaiters = [];
    waiters.forEach((resolve) => resolve());
    return;
  }
  if (message.type === 'cancel') {
    cancelled = true;
    paused = false;
    const waiters = resumeWaiters;
    resumeWaiters = [];
    waiters.forEach((resolve) => resolve());
    return;
  }
  cancelled = false;
  paused = false;
  void run(message.request).catch((caught: unknown) => {
    const error = caught instanceof Error ? caught : new Error('Worker analysis failed.');
    send(error.name === 'AbortError'
      ? { type: 'cancelled' }
      : { type: 'error', name: error.name, message: error.message });
  });
};