import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { backupConflict, createProjectBackup, MAX_BACKUP_BYTES, parseProjectBackup, readProjectBackup, serializeProjectBackup } from './project-backup.ts';
import { removeReplacedProject } from './persistence.ts';
import { verifyBackupSource } from './file-access.ts';
import { fingerprintAudio, parseAudioMetadata } from './source-audio.ts';
import { generateFloat32WavHeader } from './large-wav.ts';

function project() {
  return {
    id: 'project-identity', title: 'Dawn', notes: '  Original notes\n\n',
    savedAt: '2026-10-04T10:00:00.000Z',
    what3wordsAddress: '///filled.count.soap', descriptiveWords: ['Marsh', 'Early dawn'],
    trackDescription: { sentence1: '  exact text \n', sentence2: 'é鳥', sentence3: '', continuation: '\n\nparagraph\n\t' },
    modules: [{ id: 'noise-1', type: 'noise', name: 'Noise', enabled: false, params: { mode: 'Sample', profile0: -42, sampleStart: 1, sampleEnd: 2 } }],
    markers: [{ id: 'marker-1', time: 3, label: 'bird', color: '#aabbcc' }],
    regions: [{ id: 'region-1', start: 4, end: 6, label: 'quiet' }],
    trim: [1, 9],
    source: { name: 'dawn.wav', sampleRate: 48000, duration: 10, channels: 2, fingerprint: 'a'.repeat(64), size: 8000000000, format: 'RF64', frameCount: 480000 },
  };
}

test('round-trips all editable state and exact Unicode/whitespace description without audio or permissions', () => {
  const input = project();
  const forbidden = { getFile() { throw new Error('Must not open handles'); } };
  input.fileHandle = forbidden;
  input.analysis = { hugeCache: true };
  input.source.fileHandle = forbidden;
  input.original = [[1, 2, 3]];
  const serialized = serializeProjectBackup(input);
  const parsed = parseProjectBackup(serialized);
  assert.deepEqual(parsed.project, project());
  assert.equal(parsed.audio, 'external');
  assert.ok(!/fileHandle|original|hugeCache|analysis/.test(serialized));
  assert.ok(serialized.length < 4096, 'backup size does not depend on an 8 GB recording');
});

test('rejects malformed, future-version, permission-bearing, audio-bearing or structurally invalid backups', () => {
  assert.throws(() => parseProjectBackup('{'), /valid JSON/);
  for (const modify of [
    (v) => { v.version = 2; },
    (v) => { v.format = 'other'; },
    (v) => { v.project.source.fingerprint = ''; },
    (v) => { v.project.source.duration = -1; },
    (v) => { v.project.source.sampleRate = '48000'; },
    (v) => { v.project.modules[0].type = 'unknown'; },
    (v) => { v.project.modules[0].enabled = 'yes'; },
    (v) => { v.project.modules[0].params.profile0 = null; },
    (v) => { v.project.modules.push(v.project.modules[0]); },
    (v) => { v.project.regions[0].end = 11; },
    (v) => { v.project.markers[0].time = -1; },
    (v) => { v.project.trim = [9, 1]; },
    (v) => { v.project.originalBase64 = ['AAAA']; },
    (v) => { v.project.fileHandle = {}; },
    (v) => { v.project.source.fileHandle = {}; },
    (v) => { v.project.trackDescription.sentence1 = 1; },
  ]) {
    const value = createProjectBackup(project());
    modify(value);
    assert.throws(() => parseProjectBackup(JSON.stringify(value)), /Invalid or unsupported/);
  }
  const input = project();
  input.modules[0].params.profile0 = Infinity;
  assert.throws(() => createProjectBackup(input), /Invalid or unsupported/);
});

test('rejects oversized files before attempting to read their contents', async () => {
  let read = false;
  await assert.rejects(readProjectBackup({ size: MAX_BACKUP_BYTES + 1, text() { read = true; } }), /8 MB/);
  assert.equal(read, false);
  const input = project();
  assert.deepEqual((await readProjectBackup(new Blob([serializeProjectBackup(input)]))).project, input);
});

test('identity conflict detection includes legacy saves, not unrelated projects', () => {
  const backup = createProjectBackup(project());
  assert.equal(backupConflict(backup, project(), null).id, project().id);
  assert.equal(backupConflict(backup, null, project()).id, project().id);
  assert.equal(backupConflict(backup, { ...project(), id: 'other' }, null), null);
});

test('explicit legacy replacement removes only the matching save and keeps description drafts', () => {
  const entries = new Map([
    ['field-restore-project-v1', JSON.stringify(project())],
    ['field-restore-description-drafts-v1', 'keep writing recovery'],
  ]);
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: (key) => entries.get(key) ?? null, removeItem: (key) => entries.delete(key) };
  try {
    assert.equal(removeReplacedProject('other', project().savedAt), false);
    assert.equal(removeReplacedProject(project().id, 'old'), false);
    assert.equal(removeReplacedProject(project().id, project().savedAt), true);
    assert.equal(entries.get('field-restore-description-drafts-v1'), 'keep writing recovery');
  } finally { globalThis.localStorage = previous; }
});

function sparseRecording() {
  const frameCount = 2_000_000_000;
  const header = new Uint8Array(generateFloat32WavHeader({ channels: 1, sampleRate: 48000, frameCount }));
  let totalRead = 0;
  const file = {
    name: 'huge.wav', size: header.length + frameCount * 4,
    arrayBuffer() { throw new Error('Never buffer the whole recording'); },
    slice(start, end) {
      const size = Math.max(0, Math.min(end, file.size) - start);
      assert.ok(size <= 65536, 'only bounded slices may be read');
      totalRead += size;
      const data = new Uint8Array(size);
      if (start < header.length) data.set(header.subarray(start, Math.min(end, header.length)));
      return new Blob([data]);
    },
  };
  return { file, read: () => totalRead };
}

test('relinks multi-gigabyte RF64 using bounded reads and rejects mismatched content/format', async () => {
  const { file, read } = sparseRecording();
  const metadata = await parseAudioMetadata(file);
  const fingerprint = await fingerprintAudio(file, metadata);
  const expected = { fingerprint, sampleRate: metadata.sampleRate, channels: metadata.channels, duration: metadata.frameCount / metadata.sampleRate };
  const verified = await verifyBackupSource(file, expected);
  assert.equal(verified.file, file);
  assert.ok(read() < 500_000, 'verification reads less than 500 KB of an 8 GB source');
  await assert.rejects(verifyBackupSource(file, { ...expected, fingerprint: 'b'.repeat(64) }), /does not match/);
  await assert.rejects(verifyBackupSource(file, { ...expected, channels: 2 }), /does not match/);
  await assert.rejects(verifyBackupSource(file, { ...expected, duration: expected.duration + 1 }), /does not match/);
});

test('desktop native save permits the backup extension with an explicit file type', () => {
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /wav\|txt\|fieldrestore/);
  assert.match(main, /Editable project backup/);
});