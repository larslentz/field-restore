import { prepareSpectralRepairs } from './prepare-spectral-repairs';
import type { EditModule } from './edit-chain';
import type { AudioMetadata } from './source-audio';

self.onmessage = async (event: MessageEvent<{ file: File; metadata: AudioMetadata; modules: EditModule[] }>) => {
  try {
    const { file, metadata, modules } = event.data;
    const patches = await prepareSpectralRepairs(file, metadata, modules);
    const buffers = Object.values(patches).flatMap((patch) => patch.channels.map((channel) => channel.buffer));
    self.postMessage({ patches }, { transfer: buffers });
  } catch (caught) {
    self.postMessage({ error: caught instanceof Error ? caught.message : 'Unable to prepare Short Sound Repair.' });
  }
};