import { analyzeInitialHum, renderChain, type EditModule } from './edit-chain';
import { addRepairMark, type RepairMark } from './repair-markers';

export type MemoryRenderResult = {
  channels: Float32Array[];
  frequencies: number[][];
  events: Array<{ moduleId: string; frame: number; frequencies: number[] }>;
  windEvents: Array<{ moduleId: string; frame: number; active: boolean }>;
  repairs: RepairMark[];
};

/** The one in-memory DSP path used by the worker, playback, and WAV export. */
export function renderMemoryAudio(channels: Float32Array[], modules: EditModule[], sampleRate: number): MemoryRenderResult {
  const frequencies = analyzeInitialHum(channels, modules, sampleRate, channels[0]?.length ?? 0);
  const events: MemoryRenderResult['events'] = [];
  const windEvents: MemoryRenderResult['windEvents'] = [];
  let repairs: RepairMark[] = [];
  const rendered = renderChain(channels, modules, sampleRate, {}, frequencies,
    (moduleId, frame, values) => events.push({ moduleId, frame, frequencies: values }),
    (moduleId, frame, active) => windEvents.push({ moduleId, frame, active }),
    (moduleId, frame) => { repairs = addRepairMark(repairs, { moduleId, frame }, sampleRate); });
  events.sort((a, b) => a.frame - b.frame);
  windEvents.sort((a, b) => a.frame - b.frame);
  return { channels: rendered, frequencies, events, windEvents, repairs };
}