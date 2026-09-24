import type { EditModule } from './edit-chain';
import type { AudioMetadata } from './source-audio';
import type { FileSpectrogramOptions } from './large-spectrogram';

export type WorkerJobRequest =
  | {
      kind: 'loudness';
      file: File;
      metadata: AudioMetadata;
      modules?: EditModule[];
      frameOffset?: number;
      sourceFrameCount?: number;
      warmup?: { metadata: AudioMetadata; startFrame: number; frameCount: number };
    }
  | {
      kind: 'spectrogram';
      file: File;
      metadata: AudioMetadata;
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