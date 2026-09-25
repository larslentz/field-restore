import type { EditModule } from './edit-chain';
import { renderSpectralRepair } from './spectral-repair';
import { readAudioFrames, type AudioMetadata } from './source-audio';
import { analyzeFileInitialHum, createStreamingEditChain, type SpectralRepairPatches } from './streaming-edit-chain';

const BLOCK_FRAMES = 32768;

function abort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Spectral repair preparation was cancelled.', 'AbortError');
}

/** Prepare only the selected patches, not the whole source file.
 * Prior modules are warmed sequentially from source frame zero so chain order
 * and stateful edits match playback and exported audio.
 */
export async function prepareSpectralRepairs(
  file: Blob, metadata: AudioMetadata, modules: EditModule[], signal?: AbortSignal,
): Promise<SpectralRepairPatches> {
  const patches: SpectralRepairPatches = {};
  const active = modules.some((module) => module.enabled && module.type === 'spectral-repair' &&
    Number(module.params.strength) > 0);
  if (!active) return patches;
  const rate = metadata.sampleRate;
  const seeds = await analyzeFileInitialHum(file, metadata, modules, signal);
  for (let index = 0; index < modules.length; index++) {
    abort(signal);
    const module = modules[index];
    if (module.type !== 'spectral-repair' || !module.enabled || Number(module.params.strength) <= 0) continue;
    const start = Math.floor(Number(module.params.start) * rate);
    const end = Math.ceil(Number(module.params.end) * rate);
    const context = Number(module.params.context);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start ||
      end > metadata.frameCount || (end - start) / rate > 10.001 ||
      !Number.isFinite(context) || context < 0 || context > 1) {
      throw new RangeError('Spectral Repair requires a valid selection of at most 10 seconds within the recording.');
    }
    const padding = Math.ceil(context * rate) + 8192;
    const from = Math.max(0, start - padding);
    const until = Math.min(metadata.frameCount, end + padding);
    const neighborhood = Array.from({ length: metadata.channels }, () => new Float32Array(until - from));
    const preceding = createStreamingEditChain(modules.slice(0, index), rate, metadata.frameCount, 0,
      seeds.slice(0, index), undefined, undefined, undefined, patches);
    for (let frame = 0; frame < until; frame += BLOCK_FRAMES) {
      abort(signal);
      const count = Math.min(BLOCK_FRAMES, until - frame);
      const input = await readAudioFrames(file, metadata, frame, count, { signal });
      abort(signal);
      const processed = preceding.process(input, frame);
      const copyStart = Math.max(frame, from);
      const copyEnd = Math.min(frame + count, until);
      if (copyEnd > copyStart) processed.forEach((channel, channelIndex) =>
        neighborhood[channelIndex].set(channel.subarray(copyStart - frame, copyEnd - frame), copyStart - from));
    }
    abort(signal);
    const repaired = renderSpectralRepair(neighborhood, rate, module.params, from);
    patches[module.id] = { startFrame: start, channels: repaired.map((channel) => channel.slice(start - from, end - from)) };
  }
  return patches;
}