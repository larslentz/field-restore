import { expect, test } from '@playwright/test';

function smallWav() {
  const sampleRate = 8_000;
  const frames = sampleRate * 4;
  const wav = Buffer.alloc(44 + frames * 4);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.round(5000 * Math.sin(2 * Math.PI * 300 * frame / sampleRate));
    wav.writeInt16LE(sample, 44 + frame * 4);
    wav.writeInt16LE(sample, 46 + frame * 4);
  }
  return wav;
}

test('project location and descriptive words survive save and name the exported WAV', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('input-import-wav').setInputFiles({ name: 'coastal-dawn-demo.wav', mimeType: 'audio/wav', buffer: smallWav() });
  await expect(page.getByTestId('text-source-name')).toHaveText('coastal-dawn-demo.wav');
  await page.getByTestId('nav-project').click();
  await page.getByTestId('input-project-title').fill('Coastal dawn / north bluff');

  const address = page.getByTestId('input-project-what3words');
  const mapLink = page.getByTestId('link-what3words-map');
  await expect(page.getByTestId('link-what3words-choose')).toHaveAttribute('href', 'https://what3words.com/');
  await address.fill('missing.words');
  await expect(mapLink).toHaveCount(0);
  await address.fill('///Filled.Count.Soap');
  await expect(mapLink).toHaveAttribute('href', 'https://what3words.com/filled.count.soap');

  const wordInput = page.getByTestId('input-project-descriptive-word');
  await wordInput.fill('dawn, marsh, terns');
  await wordInput.press('Enter');
  await expect(page.getByTestId('list-project-descriptive-words').locator('li')).toHaveCount(3);
  await expect(page.getByTestId('text-export-filename')).toHaveText('coastal-dawn-north-bluff_dawn_marsh_terns_FR.wav');
  await page.getByTestId('button-project-save').click();

  await page.reload();
  await page.getByTestId('nav-project').click();
  await expect(address).toHaveValue('///Filled.Count.Soap');
  await expect(mapLink).toHaveAttribute('href', 'https://what3words.com/filled.count.soap');
  await expect(page.getByTestId('list-project-descriptive-words').locator('li')).toHaveCount(3);
  await expect(page.getByTestId('text-export-filename')).toHaveText('coastal-dawn-north-bluff_dawn_marsh_terns_FR.wav');

  await page.getByTestId('nav-export').click();
  const wav = page.waitForEvent('download', { predicate: (download) => download.suggestedFilename().endsWith('.wav') });
  await page.getByTestId('button-confirm-export').click();
  expect((await wav).suggestedFilename()).toBe('coastal-dawn-north-bluff_dawn_marsh_terns_FR.wav');
});