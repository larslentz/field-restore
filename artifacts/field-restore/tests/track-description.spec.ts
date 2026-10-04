import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const description = {
  sentence1: 'Grass rustles while insects continue.',
  sentence2: 'A passing car draws the ear to the field’s edge before the nearby sounds return.',
  sentence3: 'I kept the quiet after the vehicle disappears.',
  continuation: 'The microphones remained still.\n\nA faint call continues at the edge of the field.',
};

function recording(rf64 = false) {
  const rate = 8000;
  const frames = rate * 2;
  const headerSize = rf64 ? 80 : 44;
  const wav = Buffer.alloc(headerSize + frames * 2);
  wav.write(rf64 ? 'RF64' : 'RIFF', 0);
  wav.writeUInt32LE(rf64 ? 0xffffffff : wav.length - 8, 4);
  wav.write('WAVE', 8);
  if (rf64) {
    wav.write('ds64', 12); wav.writeUInt32LE(28, 16);
    wav.writeBigUInt64LE(BigInt(wav.length - 8), 20);
    wav.writeBigUInt64LE(BigInt(frames * 2), 28);
    wav.writeBigUInt64LE(BigInt(frames), 36);
  }
  const fmt = rf64 ? 48 : 12;
  wav.write('fmt ', fmt); wav.writeUInt32LE(16, fmt + 4);
  wav.writeUInt16LE(1, fmt + 8); wav.writeUInt16LE(1, fmt + 10);
  wav.writeUInt32LE(rate, fmt + 12); wav.writeUInt32LE(rate * 2, fmt + 16);
  wav.writeUInt16LE(2, fmt + 20); wav.writeUInt16LE(16, fmt + 22);
  wav.write('data', fmt + 24);
  wav.writeUInt32LE(rf64 ? 0xffffffff : frames * 2, fmt + 28);
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(2000 * Math.sin(2 * Math.PI * 300 * i / rate)), headerSize + i * 2);
  return wav;
}

function field(page: Page, key: string) {
  return page.getByTestId(`textarea-project-description-${key}`);
}

async function expectDescription(page: Page, values = description) {
  for (const [key, value] of Object.entries(values)) await expect(field(page, key)).toHaveValue(value);
}

for (const rf64 of [false, true]) {
  test(`${rf64 ? 'file-backed' : 'embedded'} project descriptions survive saving, reopening and text export`, async ({ page }, testInfo) => {
    if (rf64) {
      // Use a controlled WAV destination instead of the native OS file-save dialog.
      await page.addInitScript(() => {
        Object.defineProperty(window, 'showSaveFilePicker', { value: async () => ({
          createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }),
        }), configurable: true });
      });
    }
    await page.goto('/');
    const wav = recording(rf64);
    const upload = { name: rf64 ? 'file-backed.wav' : 'embedded.wav', mimeType: 'audio/wav', buffer: wav };
    await page.getByTestId('input-import-wav').setInputFiles(upload);
    await expect(page.getByTestId('text-source-name')).toHaveText(upload.name);
    await page.getByTestId('nav-project').click();
    await expect(page.getByTestId('project-track-description')).toContainText('The three-sentence method');
    for (const [key, value] of Object.entries(description)) await field(page, key).fill(value);
    await page.getByTestId('project-track-description').screenshot({ path: testInfo.outputPath('track-description.png') });
    if (!rf64) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByTestId('project-track-description').screenshot({ path: testInfo.outputPath('track-description-mobile.png') });
      await expect(field(page, 'continuation')).toBeVisible();
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    await page.getByTestId('textarea-project-notes').fill('Handling notes — not for the description report.');
    await page.getByTestId('button-project-save').click();
    await expect(page.getByText(/Project saved in this browser/)).toBeVisible();
    await page.reload();
    await page.getByTestId('nav-project').click();
    await expectDescription(page);
    await expect(page.getByTestId('textarea-project-notes')).toHaveValue('Handling notes — not for the description report.');
    if (rf64) {
      // The project is visible before its audio is relinked; edits made here must not be overwritten.
      await field(page, 'sentence1').fill('Grass rustles and insects continue after reopening.');
      await page.getByTestId('input-import-wav').setInputFiles(upload);
      await expect(field(page, 'sentence1')).toHaveValue('Grass rustles and insects continue after reopening.');
      await field(page, 'sentence1').fill(description.sentence1);
      await page.getByTestId('button-project-save').click();
      await expect(page.getByText(/Project saved in this browser/)).toBeVisible();
    }
    await page.getByTestId('nav-export').click();
    const report = page.waitForEvent('download', { predicate: (download) => download.suggestedFilename().endsWith('.txt') });
    await page.getByTestId('button-confirm-export').click();
    const downloaded = await report;
    const path = await downloaded.path();
    expect(path).not.toBeNull();
    const text = await readFile(path!, 'utf8');
    expect(text).toContain('TRACK DESCRIPTION');
    for (const value of Object.values(description)) expect(text).toContain(value);
    expect(text).not.toContain('Handling notes — not for the description report.');
    // A different recording must not inherit the previous description.
    await page.getByTestId('input-import-wav').setInputFiles({ name: 'different.wav', mimeType: 'audio/wav', buffer: recording() });
    await page.getByTestId('nav-project').click();
    await expectDescription(page, { sentence1: '', sentence2: '', sentence3: '', continuation: '' });
  });
}

test('legacy embedded projects open with blank description fields', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('field-restore-project-v1', JSON.stringify({
    title: 'Older project', notes: 'Preserve existing notes.', sourceName: 'older.wav',
    sampleRate: 8000, original: [Array(8000).fill(0)], modules: [], markers: [], regions: [],
    savedAt: '2026-09-01T00:00:00.000Z',
  })));
  await page.reload();
  await page.getByTestId('nav-project').click();
  await expectDescription(page, { sentence1: '', sentence2: '', sentence3: '', continuation: '' });
  await expect(page.getByTestId('textarea-project-notes')).toHaveValue('Preserve existing notes.');
});