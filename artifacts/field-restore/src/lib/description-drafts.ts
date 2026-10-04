import { normalizeTrackDescription, TRACK_DESCRIPTION_FIELDS, type TrackDescription } from './track-description';

const PREFIX = 'field-restore-description-draft-v1:';

export interface DescriptionDraft {
  description: TrackDescription;
  updatedAt: string;
}

export function descriptionsEqual(a: TrackDescription, b: TrackDescription) {
  return TRACK_DESCRIPTION_FIELDS.every(({ key }) => a[key] === b[key]);
}

/** Names distinguish separate imports even when their audio bytes are identical. */
export function sourceDescriptionKey(name: string, fingerprint: string) {
  return `source:${JSON.stringify([name, fingerprint])}`;
}

export function projectDescriptionKey(id: string) {
  return `project:${id}`;
}

export function readDescriptionDraft(key: string): DescriptionDraft | null {
  const raw = localStorage.getItem(PREFIX + key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value.updatedAt !== 'string' || !value.description ||
      !TRACK_DESCRIPTION_FIELDS.every(({ key: field }) => typeof value.description[field] === 'string')) return null;
    return { description: normalizeTrackDescription(value.description), updatedAt: value.updatedAt };
  } catch {
    return null;
  }
}

export function writeDescriptionDraft(key: string, description: TrackDescription, baseline: TrackDescription) {
  if (descriptionsEqual(description, baseline)) {
    discardDescriptionDraft(key);
  } else {
    localStorage.setItem(PREFIX + key, JSON.stringify({ description, updatedAt: new Date().toISOString() }));
  }
}

export function discardDescriptionDraft(key: string) {
  localStorage.removeItem(PREFIX + key);
}