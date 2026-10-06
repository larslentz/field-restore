import { fingerprintAudio, parseAudioMetadata, type AudioMetadata } from './source-audio';
import { queryFileHandlePermission } from './project-store';

export interface VerifiedFileHandle {
  file: File;
  metadata: AudioMetadata;
  fingerprint: string;
}

export async function openVerifiedFileHandle(
  handle: FileSystemFileHandle,
  expectedFingerprint: unknown,
): Promise<VerifiedFileHandle | null> {
  if (await queryFileHandlePermission(handle) !== 'granted') return null;
  if (typeof expectedFingerprint !== 'string' || !expectedFingerprint) return null;
  const file = await handle.getFile();
  const metadata = await parseAudioMetadata(file, { name: file.name });
  const fingerprint = await fingerprintAudio(file, metadata);
  return fingerprint === expectedFingerprint ? { file, metadata, fingerprint } : null;
}

export function isVerifiedRelink(expectedFingerprint: unknown, actualFingerprint: string): boolean {
  return typeof expectedFingerprint === 'string'
    && expectedFingerprint.length > 0
    && expectedFingerprint === actualFingerprint;
}

/** Reads only parsed metadata and bounded fingerprint slices, never full audio. */
export async function verifyBackupSource(
  file: File,
  expected: { fingerprint: string; sampleRate: number; channels: number; duration: number },
): Promise<VerifiedFileHandle> {
  const metadata = await parseAudioMetadata(file, { name: file.name });
  const fingerprint = await fingerprintAudio(file, metadata);
  if (!isVerifiedRelink(expected.fingerprint, fingerprint) ||
      metadata.sampleRate !== expected.sampleRate || metadata.channels !== expected.channels ||
      Math.abs(metadata.frameCount / metadata.sampleRate - expected.duration) > 1e-6) {
    throw new Error('This recording does not match the backup. Choose the original WAV, FLAC, or MP4. No saved projects were changed.');
  }
  return { file, metadata, fingerprint };
}