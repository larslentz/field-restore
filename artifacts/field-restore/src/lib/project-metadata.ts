/** What3Words addresses are links only; this does not verify that an address exists. */
export function what3wordsMapUrl(input: string): string | null {
  const address = input.trim().replace(/^\/{3}/, '').trim().replace(/\s*\.\s*/g, '.');
  const words = address.split('.');
  if (words.length !== 3 || !words.every((word) => /^[\p{L}\p{N}'-]+$/u.test(word))) return null;
  return `https://what3words.com/${words.map((word) => encodeURIComponent(word.toLowerCase())).join('.')}`;
}

export function filenameWord(word: string): string {
  return word.normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

export function exportFilenames(title: string, sourceName: string, descriptiveWords: string[]): { wav: string; report: string } {
  // Preserve the existing project-title naming convention; only the suffix changes.
  const base = (title || sourceName).replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').toLowerCase() || 'field-restore';
  const words = descriptiveWords.map(filenameWord).filter(Boolean);
  const stem = base + (words.length ? `_${words.join('_')}` : '');
  return { wav: `${stem}_FR.wav`, report: `${stem}-restoration-report.txt` };
}