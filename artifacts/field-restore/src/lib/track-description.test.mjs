import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTrackDescription } from './track-description.ts';
import { projectFromSource } from './persistence.ts';
import { migrateStoredProject } from './project-store.ts';

const description = {
  sentence1: 'Grass rustles while insects continue.',
  sentence2: 'A distant car draws attention away before the nearby sounds return.',
  sentence3: 'I kept the quiet that follows the car.',
  continuation: 'The microphones remained still.\n\nA faint call continues at the field’s edge.',
};

test('missing and partial descriptions default to blank without changing supplied text', () => {
  assert.deepEqual(normalizeTrackDescription(), { sentence1: '', sentence2: '', sentence3: '', continuation: '' });
  assert.deepEqual(normalizeTrackDescription(null), normalizeTrackDescription());
  assert.deepEqual(normalizeTrackDescription({ sentence1: '  Preserve spacing.  ', continuation: 42 }), {
    sentence1: '  Preserve spacing.  ', sentence2: '', sentence3: '', continuation: '',
  });
});

test('embedded project saves preserve description separately from field notes', () => {
  const source = { name: 'field.wav', sampleRate: 8000, duration: 0.001, channels: [new Float32Array(8)] };
  const saved = projectFromSource(source, [], [], [], 'Field', 'Private handling notes.', undefined, null, '', [], description);
  assert.deepEqual(saved.trackDescription, description);
  assert.equal(saved.notes, 'Private handling notes.');
  assert.deepEqual(projectFromSource(source, [], [], [], 'Field', '').trackDescription, normalizeTrackDescription());
});

test('file-backed migration preserves all description fields and defaults legacy projects to blank', () => {
  const legacy = { title: 'Field', notes: 'Handling notes.', sourceName: 'field.wav', sampleRate: 8000, modules: [], markers: [], regions: [] };
  assert.deepEqual(migrateStoredProject(legacy).trackDescription, normalizeTrackDescription());
  const migrated = migrateStoredProject({ ...legacy, trackDescription: description });
  assert.deepEqual(migrated.trackDescription, description);
  assert.equal(migrated.notes, legacy.notes);
  assert.deepEqual(migrateStoredProject({ ...migrated, source: { name: 'field.rf64.wav', sampleRate: 8000 } }).trackDescription, description);
});