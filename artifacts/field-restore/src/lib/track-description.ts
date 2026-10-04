export interface TrackDescription {
  sentence1: string;
  sentence2: string;
  sentence3: string;
  continuation: string;
}

export const TRACK_DESCRIPTION_FIELDS = [
  {
    key: 'sentence1',
    label: 'Sentence 1 — What happens',
    guidance: 'Stay close to what the microphones captured. Name a few sounds, rather than everything you can identify, to give the listener something real to listen for.',
    placeholder: 'The grass moves, insects continue, and a vehicle enters and leaves.',
  },
  {
    key: 'sentence2',
    label: 'Sentence 2 — How the space unfolds',
    guidance: 'Describe how the listener’s sense of the place changes as sounds arrive or fade, even though the microphones have not moved.',
    placeholder: 'As the car fades at the edge of the field, the quieter sounds nearby become apparent again.',
  },
  {
    key: 'sentence3',
    label: 'Sentence 3 — Why I kept the recording',
    guidance: 'Explain your choice: a distinct sound, an unexpected moment, or the time around an event. Say why you kept it without telling the listener what to feel.',
    placeholder: 'I kept this recording for the stretch of quiet after the vehicle disappears.',
  },
  {
    key: 'continuation',
    label: 'Continuation of the description',
    guidance: 'Continue beyond the three sentences when the recording needs more description.',
    placeholder: 'Add further observations or context…',
  },
] as const;

export function normalizeTrackDescription(value?: Partial<TrackDescription> | null): TrackDescription {
  return {
    sentence1: typeof value?.sentence1 === 'string' ? value.sentence1 : '',
    sentence2: typeof value?.sentence2 === 'string' ? value.sentence2 : '',
    sentence3: typeof value?.sentence3 === 'string' ? value.sentence3 : '',
    continuation: typeof value?.continuation === 'string' ? value.continuation : '',
  };
}