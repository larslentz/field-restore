import type { EditModule } from './edit-chain';
import type { WavMetadata } from './large-wav';
import type { FileSpectrogramOptions } from './large-spectrogram';

export type WorkerJobRequest =
  | {
      kind: 'loudness';
      file: File;
      metadata: WavMetadata;
      modules?: EditModule[];
      frameOffset?: number;
      sourceFrameCount?: number;
      warmup?: { metadata: WavMetadata; startFrame: number; frameCount: number };
    }
  | {
      kind: 'spectrogram';
      file: File;
      metadata: WavMetadata;
      modules: EditModule[];
      options: Omit<FileSpectrogramOptions, 'signal' | 'onProgress' | 'transform' | 'checkpoint'>;
    };

export type WorkerInboundMessage =
  | { type: 'start'; request: WorkerJobRequest }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'cancel' };

export type WorkerOutboundMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'result'; result: unknown }
  | { type: 'cancelled' }
  | { type: 'error'; name: string; message: string };