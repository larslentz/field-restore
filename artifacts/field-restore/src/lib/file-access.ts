import { fingerprintWav, parseWavMetadata, type WavMetadata } from './large-wav';
import { queryFileHandlePermission } from './project-store';

export interface VerifiedFileHandle {
  file: File;
  metadata: WavMetadata;
  fingerprint: string;
}

export async function openVerifiedFileHandle(
  handle: FileSystemFileHandle,
  expectedFingerprint: unknown,
): Promise<VerifiedFileHandle | null> {
  if (await queryFileHandlePermission(handle) !== 'granted') return null;
  if (typeof expectedFingerprint !== 'string' || !expectedFingerprint) return null;
  const file = await handle.getFile();
  const metadata = await parseWavMetadata(file, { name: file.name });
  const fingerprint = await fingerprintWav(file, metadata);
  return fingerprint === expectedFingerprint ? { file, metadata, fingerprint } : null;
}

export function isVerifiedRelink(expectedFingerprint: unknown, actualFingerprint: string): boolean {
  return typeof expectedFingerprint === 'string'
    && expectedFingerprint.length > 0
    && expectedFingerprint === actualFingerprint;
}