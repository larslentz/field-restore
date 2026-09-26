import type { EditModule } from './edit-chain';
import { renderSpectralRepair } from './spectral-repair';
import { readAudioFrames, type AudioMetadata } from './source-audio';
import { analyzeFileInitialHum, createStreamingEditChain, type SpectralRepairPatches } from './streaming-edit-chain';

const BLOCK_FRAMES = 32768;

function abort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Short Sound Repair preparation was cancelled.', 'AbortError');
}

/** Only these edits are independent of preceding samples. In particular the
 * automatic DC stage, filters, detectors and ambient bed must be warmed. */
function historyFree(module: EditModule): boolean {
  if (!module.enabled) return true;
  return module.type === 'gain' || module.type === 'fade' || module.type === 'region' ||
    (module.type === 'dc' && module.params.mode !== 'Auto');
}

/** Prepare local patches in chain order, retaining a single warmed chain
 * between repairs. The context read is replayed after each patch is ready,
 * so later edits see the repaired signal rather than an unpatched prefix.
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
  const repairs: Array<{ index: number; start: number; end: number; from: number; until: number }> = [];
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
      throw new RangeError('Short Sound Repair requires a valid selection of at most 10 seconds within the recording.');
    }
    const padding = Math.ceil(context * rate) + 8192;
    const from = Math.max(0, start - padding);
    const until = Math.min(metadata.frameCount, end + padding);
    repairs.push({ index, start, end, from, until });
  }

  // A repair earlier on the timeline but later in the chain depends on an
  // already prepared later patch. It needs a fresh prefix pass in that case.
  const ordered = repairs.every((repair, i) => i === 0 || repair.from >= repairs[i - 1].from);
  const lastIndex = repairs.at(-1)!.index;
  const independent = modules.slice(0, lastIndex).every((module) =>
    module.type === 'spectral-repair' || historyFree(module));
  let cursor = ordered && independent ? repairs[0].from : 0;
  const chain = ordered
    ? createStreamingEditChain(modules.slice(0, lastIndex), rate, metadata.frameCount, cursor,
      seeds.slice(0, lastIndex), undefined, undefined, undefined, patches)
    : undefined;

  async function scan(processor: ReturnType<typeof createStreamingEditChain>, from: number, until: number,
    collect?: { offset: number; channels: Float32Array[] }) {
    for (let frame = from; frame < until; frame += BLOCK_FRAMES) {
      abort(signal);
      const count = Math.min(BLOCK_FRAMES, until - frame);
      const input = await readAudioFrames(file, metadata, frame, count, { signal });
      abort(signal);
      const processed = processor.process(input, frame);
      if (collect) processed.forEach((channel, channelIndex) =>
        collect.channels[channelIndex].set(channel, frame - collect.offset));
    }
  }

  for (const { index, start, end, from, until } of repairs) {
    abort(signal);
    const module = modules[index];
    const neighborhood = Array.from({ length: metadata.channels }, () => new Float32Array(until - from));
    let preceding;
    if (chain) {
      if (cursor < from) await scan(chain, cursor, from);
      cursor = from;
      preceding = createStreamingEditChain(modules.slice(0, index), rate, metadata.frameCount, from,
        seeds.slice(0, index), undefined, undefined, undefined, patches);
      preceding.restore(chain.snapshot());
    } else {
      preceding = createStreamingEditChain(modules.slice(0, index), rate, metadata.frameCount, 0,
        seeds.slice(0, index), undefined, undefined, undefined, patches);
      await scan(preceding, 0, from);
    }
    await scan(preceding, from, until, { offset: from, channels: neighborhood });
    abort(signal);
    const repaired = renderSpectralRepair(neighborhood, rate, module.params, from);
    patches[module.id] = { startFrame: start, channels: repaired.map((channel) => channel.slice(start - from, end - from)) };
  }
  return patches;
}