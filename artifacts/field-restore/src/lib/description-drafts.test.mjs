import assert from 'node:assert/strict';
import test from 'node:test';
import { descriptionsEqual, discardDescriptionDraft, projectDescriptionKey, readDescriptionDraft, sourceDescriptionKey, writeDescriptionDraft } from './description-drafts.ts';
import { normalizeTrackDescription } from './track-description.ts';

const blank = normalizeTrackDescription();
const text = { sentence1: '  A call.\n', sentence2: '', sentence3: 'I kept it.', continuation: 'More.\n\nContext.' };

function storage() {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  return values;
}

test('drafts preserve all text on reopen and do not write a saved project', () => {
  const values = storage();
  localStorage.setItem('field-restore-project-v1', 'saved project');
  const key = sourceDescriptionKey('field.wav', 'hash-a');
  writeDescriptionDraft(key, text, blank);
  assert.deepEqual(readDescriptionDraft(key).description, text);
  assert.ok(!Number.isNaN(Date.parse(readDescriptionDraft(key).updatedAt)));
  assert.equal(values.get('field-restore-project-v1'), 'saved project');
  assert.equal(readDescriptionDraft(sourceDescriptionKey('field.wav', 'hash-b')), null);
  assert.equal(readDescriptionDraft(sourceDescriptionKey('other.wav', 'hash-a')), null);
  assert.equal(readDescriptionDraft(projectDescriptionKey('unrelated')), null);
});

test('project identity works without source access and separates projects sharing one recording', () => {
  storage();
  writeDescriptionDraft(projectDescriptionKey('project-a'), text, blank);
  assert.deepEqual(readDescriptionDraft(projectDescriptionKey('project-a')).description, text);
  assert.equal(readDescriptionDraft(projectDescriptionKey('project-b')), null);
});

test('discard, reverting to baseline and explicit save cleanup retire a draft, including intentional empty text', () => {
  storage();
  const key = projectDescriptionKey('project-a');
  writeDescriptionDraft(key, blank, text);
  assert.deepEqual(readDescriptionDraft(key).description, blank);
  writeDescriptionDraft(key, text, text);
  assert.equal(readDescriptionDraft(key), null);
  writeDescriptionDraft(key, text, blank);
  discardDescriptionDraft(key);
  assert.equal(readDescriptionDraft(key), null);
  assert.equal(descriptionsEqual(text, { ...text, sentence1: text.sentence1.trim() }), false);
});

test('invalid records are not offered and unavailable storage fails explicitly', () => {
  const values = storage();
  const key = projectDescriptionKey('project-a');
  for (const raw of ['invalid json', 'null', '{"description":{},"updatedAt":"now"}']) {
    values.set(`field-restore-description-draft-v1:${key}`, raw);
    assert.equal(readDescriptionDraft(key), null);
  }
  localStorage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => writeDescriptionDraft(key, text, blank), /quota/);
  localStorage.getItem = () => { throw new Error('denied'); };
  assert.throws(() => readDescriptionDraft(key), /denied/);
});