import type { AudioSource } from './audio';
import type { EditModule } from './edit-chain';

export interface StoredProject {
  title: string;
  notes: string;
  sourceName: string;
  sampleRate: number;
  modules: EditModule[];
  markers: { id: string; time: number; label: string; color: string }[];
  regions: { id: string; start: number; end: number; label: string }[];
  trim?: [number, number];
  savedAt: string;
  original?: number[][];
  originalBase64?: string[];
  originalLength?: number;
}

const KEY = 'field-restore-project-v1';
function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  return btoa(binary);
}
function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export function encodeChannels(channels: Float32Array[]) {
  return channels.map((channel) => {
    const buffer = new ArrayBuffer(channel.length * 4);
    new Float32Array(buffer).set(channel);
    return bytesToBase64(new Uint8Array(buffer));
  });
}
export function decodeChannels(values: string[], length: number) {
  return values.map((value) => {
    const bytes = base64ToBytes(value);
    const view = new Float32Array(new ArrayBuffer(bytes.byteLength));
    new Uint8Array(view.buffer).set(bytes);
    return view.slice(0, length);
  });
}
export function saveProject(project: StoredProject) {
  try { localStorage.setItem(KEY, JSON.stringify(project)); return true; } catch { return false; }
}
export function loadProject(): StoredProject | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) as StoredProject : null;
  } catch { return null; }
}
export function projectFromSource(source: AudioSource, modules: EditModule[], markers: StoredProject['markers'], regions: StoredProject['regions'], title: string, notes: string, trim?: [number, number]): StoredProject {
  const maxSamples = 1_000_000;
  const originalBase64 = source.channels[0]?.length <= maxSamples ? encodeChannels(source.channels) : undefined;
  return { title, notes, sourceName: source.name, sampleRate: source.sampleRate, modules, markers, regions, trim, savedAt: new Date().toISOString(), originalBase64, originalLength: source.channels[0]?.length };
}