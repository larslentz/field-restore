import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { FLAC_SINE_BASE64 } from './fixtures/flac-sine';

test('lossless FLAC imports, saves and exports as 32-bit float WAV', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('nav-import')).toContainText('WAV or FLAC');
  await expect(page.locator('#import-format-note')).toContainText('32-bit floating point WAV recommended');
  await page.getByTestId('input-import-wav').setInputFiles({
    name: 'field-sine.flac', mimeType: 'audio/flac', buffer: Buffer.from(FLAC_SINE_BASE64, 'base64'),
  });
  await expect(page.getByTestId('text-source-name')).toHaveText('field-sine.flac');
  await expect(page.getByTestId('status-error')).toHaveCount(0);
  await page.getByTestId('nav-save').click();
  await expect(page.locator('.topbar .chip').first()).toContainText('Project saved in this browser');
  await page.reload();
  await expect(page.getByTestId('text-source-name')).toHaveText('field-sine.flac');

  const downloads: Array<import('@playwright/test').Download> = [];
  page.on('download', (download) => downloads.push(download));
  await page.getByTestId('nav-export').click();
  await page.getByTestId('button-confirm-export').click();
  await expect.poll(() => downloads.length).toBe(2);
  const wavDownload = downloads.find((item) => item.suggestedFilename().endsWith('.wav'))!;
  const wav = await readFile(await wavDownload.path());
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.readUInt16LE(20)).toBe(3);
  expect(wav.readUInt16LE(22)).toBe(2);
  expect(wav.readUInt32LE(24)).toBe(48_000);
  expect(wav.readUInt16LE(34)).toBe(32);
  expect(wav.readUInt32LE(40)).toBe(4_800 * 2 * 4);
  // The default edit chain includes fades, so samples near the start may be very quiet.
  let peak = 0;
  for (let offset = 44; offset < wav.length; offset += 4) peak = Math.max(peak, Math.abs(wav.readFloatLE(offset)));
  expect(peak).toBeGreaterThan(0.000001);

  await page.getByTestId('input-import-wav').setInputFiles({
    name: 'broken.flac', mimeType: 'audio/flac', buffer: Buffer.from('not flac'),
  });
  await expect(page.getByTestId('status-error')).toContainText('does not contain FLAC audio');
  await expect(page.getByTestId('text-source-name')).toHaveText('field-sine.flac');
});