import { useCallback, useRef, useState } from 'react';
import { descriptionsEqual, discardDescriptionDraft, readDescriptionDraft, writeDescriptionDraft, type DescriptionDraft } from '@/lib/description-drafts';
import { normalizeTrackDescription, type TrackDescription } from '@/lib/track-description';

type Context = { key: string; baseline: TrackDescription; value: TrackDescription };
const STORAGE_ERROR = 'Description draft could not be stored in this browser. Keep a text download or save your project before reloading.';

/** Writes in the input handler, not a debounce/unload callback that a reload can miss. */
export function useDescriptionDraft() {
  const context = useRef<Context>({ key: 'demo', baseline: normalizeTrackDescription(), value: normalizeTrackDescription() });
  const [description, setDescription] = useState<TrackDescription>(normalizeTrackDescription);
  const [pending, setPending] = useState<DescriptionDraft | null>(null);
  const [storageError, setStorageError] = useState('');

  const open = useCallback((key: string, baseline = normalizeTrackDescription()) => {
    context.current = { key, baseline, value: baseline };
    setDescription(baseline);
    setPending(null);
    setStorageError('');
    try {
      const draft = readDescriptionDraft(key);
      if (draft && !descriptionsEqual(draft.description, baseline)) setPending(draft);
    } catch {
      setStorageError(STORAGE_ERROR);
    }
  }, []);

  const change = useCallback((value: TrackDescription) => {
    context.current.value = value;
    setDescription(value);
    try {
      writeDescriptionDraft(context.current.key, value, context.current.baseline);
      setStorageError('');
    } catch {
      setStorageError(STORAGE_ERROR);
    }
  }, []);

  const restore = useCallback(() => {
    if (!pending) return;
    change(pending.description);
    setPending(null);
  }, [change, pending]);

  const discard = useCallback(() => {
    try {
      discardDescriptionDraft(context.current.key);
      setPending(null);
      setStorageError('');
    } catch {
      setStorageError('The draft could not be discarded from browser storage. Try again before reloading.');
    }
  }, []);

  // An IndexedDB save can finish after another import or another keystroke.
  const capture = () => context.current;
  const saved = (key: string, value: TrackDescription, owner: Context) => {
    if (context.current !== owner) return;
    const previousKey = owner.key;
    owner.key = key;
    owner.baseline = value;
    try {
      // Write the newer in-flight edits first, then retire the pre-save source key.
      writeDescriptionDraft(key, owner.value, value);
      if (previousKey !== key) discardDescriptionDraft(previousKey);
      setStorageError('');
    } catch {
      setStorageError(STORAGE_ERROR);
    }
  };

  return { description, change, open, pending, restore, discard, storageError, capture, saved };
}