import { z } from 'zod';
import type { ProjectInput, ProjectRecord } from './project-store';
import type { StoredProject } from './persistence';
import { normalizeTrackDescription } from './track-description';

export const BACKUP_EXTENSION = '.fieldrestore';
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
const text = z.string().max(200_000);
const id = z.string().min(1).max(200);
const time = z.number().finite().nonnegative();
const sourceSchema = z.object({
  name: z.string().min(1).max(4096),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sampleRate: z.number().int().min(1).max(768000),
  duration: z.number().finite().positive(),
  channels: z.number().int().min(1).max(64),
  size: z.number().int().nonnegative().optional(),
  lastModified: time.optional(),
  format: z.enum(['WAV', 'RIFF', 'RF64', 'FLAC']).optional(),
  bitsPerSample: z.number().int().min(1).max(64).optional(),
  frameCount: z.number().int().positive().optional(),
}).strict();
const projectSchema = z.object({
  id,
  title: text,
  notes: text,
  savedAt: z.string().datetime(),
  what3wordsAddress: text,
  descriptiveWords: z.array(text).max(1000),
  trackDescription: z.object({ sentence1: text, sentence2: text, sentence3: text, continuation: text }).strict(),
  modules: z.array(z.object({
    id,
    type: z.enum(['gain', 'fade', 'eq', 'dc', 'hum', 'wind', 'noise', 'click-pop', 'spectral-repair', 'region', 'ambient']),
    name: text,
    enabled: z.boolean(),
    params: z.record(z.string().max(200), z.union([z.number().finite(), text])),
  }).strict()).max(1000),
  markers: z.array(z.object({ id, time, label: text, color: z.string().max(100) }).strict()).max(10000),
  regions: z.array(z.object({ id, start: time, end: time, label: text }).strict()).max(10000),
  trim: z.tuple([time, time]).optional(),
  source: sourceSchema,
}).strict().superRefine((project, context) => {
  const duration = project.source.duration;
  const badRange = (start: number, end: number) => start >= end || end > duration + 1e-6;
  if (project.trim && badRange(...project.trim)) context.addIssue({ code: 'custom', message: 'Invalid trim range' });
  if (project.regions.some((region) => badRange(region.start, region.end)) ||
      project.markers.some((marker) => marker.time > duration + 1e-6)) {
    context.addIssue({ code: 'custom', message: 'Markers or regions lie outside the source' });
  }
  for (const items of [project.modules, project.markers, project.regions]) {
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      context.addIssue({ code: 'custom', message: 'Duplicate identifiers' });
    }
  }
});
const backupSchema = z.object({
  format: z.literal('field-restore-project'),
  version: z.literal(1),
  exportedAt: z.string().datetime(),
  audio: z.literal('external'),
  project: projectSchema,
}).strict();

export type ProjectBackup = z.infer<typeof backupSchema>;

/** Explicit allowlist: audio, cached analysis and browser permissions never travel. */
export function createProjectBackup(input: ProjectInput): ProjectBackup {
  const source = input.source;
  return validateBackup({
    format: 'field-restore-project', version: 1, exportedAt: new Date().toISOString(), audio: 'external',
    project: {
      id: input.id,
      title: input.title, notes: input.notes, savedAt: input.savedAt ?? new Date().toISOString(),
      what3wordsAddress: input.what3wordsAddress ?? '',
      descriptiveWords: input.descriptiveWords ?? [],
      trackDescription: normalizeTrackDescription(input.trackDescription),
      modules: input.modules.map(({ id, type, name, enabled, params }) => ({ id, type, name, enabled, params })),
      markers: input.markers, regions: input.regions, trim: input.trim,
      source: {
        name: source.name, fingerprint: source.fingerprint, sampleRate: source.sampleRate,
        duration: source.duration, channels: source.channels,
        size: source.size, lastModified: source.lastModified, format: source.format,
        bitsPerSample: source.bitsPerSample, frameCount: source.frameCount,
      },
    },
  });
}

function validateBackup(value: unknown): ProjectBackup {
  const parsed = backupSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Invalid or unsupported project backup. Use a version 1 Field Restore backup with a source fingerprint, valid edits and time ranges. No saved projects were changed.');
  }
  return parsed.data;
}

export function serializeProjectBackup(input: ProjectInput): string {
  const serialized = JSON.stringify(createProjectBackup(input), null, 2);
  if (new TextEncoder().encode(serialized).byteLength > MAX_BACKUP_BYTES) throw new Error('Project backup exceeds the 8 MB metadata limit.');
  return serialized;
}

export async function readProjectBackup(file: Blob): Promise<ProjectBackup> {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('Project backup exceeds the 8 MB metadata limit. Audio must remain in a separate WAV or FLAC file.');
  return parseProjectBackup(await file.text());
}

export function parseProjectBackup(raw: string): ProjectBackup {
  if (new TextEncoder().encode(raw).byteLength > MAX_BACKUP_BYTES) throw new Error('Project backup exceeds the 8 MB metadata limit.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('This file is not a valid JSON project backup. No saved projects were changed.'); }
  return validateBackup(value);
}

export function backupConflict(backup: ProjectBackup, stored: ProjectRecord | null, legacy: StoredProject | null) {
  if (stored?.id === backup.project.id) return stored;
  if (legacy?.id === backup.project.id) return legacy;
  return null;
}