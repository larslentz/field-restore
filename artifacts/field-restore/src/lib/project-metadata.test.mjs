import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFilenames, filenameWord, what3wordsMapUrl } from './project-metadata.ts';
import { migrateStoredProject } from './project-store.ts';

test('What3Words links accept a three-word address with or without the prefix', () => {
  assert.equal(what3wordsMapUrl(' ///Filled.Count.Soap '), 'https://what3words.com/filled.count.soap');
  assert.equal(what3wordsMapUrl(' filled . count . soap '), 'https://what3words.com/filled.count.soap');
  assert.equal(what3wordsMapUrl('filled.count'), null);
  assert.equal(what3wordsMapUrl('filled.count.soap/other'), null);
  assert.equal(what3wordsMapUrl(''), null);
});

test('descriptive words join the existing project name with underscores before the FR suffix', () => {
  assert.deepEqual(exportFilenames('Coastal dawn / north bluff', 'coastal-dawn-demo.wav', ['dawn', 'marsh', 'terns']), {
    wav: 'coastal-dawn-north-bluff_dawn_marsh_terns_FR.wav',
    report: 'coastal-dawn-north-bluff_dawn_marsh_terns-restoration-report.json',
  });
  assert.equal(exportFilenames('Coastal dawn / north bluff', '', []).wav, 'coastal-dawn-north-bluff_FR.wav');
  assert.equal(filenameWord(' Low tide! '), 'low-tide');
  assert.equal(exportFilenames('', '', ['']).wav, 'field-restore_FR.wav');
});

test('migration preserves location and descriptive words but defaults older projects to empty values', () => {
  const old = { title: 'Field', notes: '', sourceName: 'field.wav', sampleRate: 48000, modules: [], markers: [], regions: [] };
  assert.equal(migrateStoredProject(old).what3wordsAddress, '');
  assert.deepEqual(migrateStoredProject(old).descriptiveWords, []);
  assert.equal(migrateStoredProject({ ...old, what3wordsAddress: 'filled.count.soap', descriptiveWords: ['marsh'] }).what3wordsAddress, 'filled.count.soap');
  assert.deepEqual(migrateStoredProject({ ...old, descriptiveWords: ['marsh'] }).descriptiveWords, ['marsh']);
});