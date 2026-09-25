/// <reference lib="webworker" />
import { renderMemoryAudio } from './memory-render';
import type { EditModule } from './edit-chain';

const scope = self as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<{ channels: Float32Array[]; modules: EditModule[]; sampleRate: number }>) => {
  try {
    const { channels, modules, sampleRate } = event.data;
    const result = renderMemoryAudio(channels, modules, sampleRate);
    scope.postMessage({ type: 'result', result }, result.channels.map((channel) => channel.buffer));
  } catch (caught) {
    scope.postMessage({ type: 'error', message: caught instanceof Error ? caught.message : 'Audio render failed.' });
  }
};