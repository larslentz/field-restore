import { expect, test } from '@playwright/test';
import { open, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('downloads a complete file-backed WAV and report without a file-save picker', async ({ page }) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(path.join(tmpdir(), 'field-restore-brave-'));
  const fixture = path.join(directory, 'brave-large.wav');
  const frames = 64 * 1024 * 1024 / 2 + 8_000;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(frames * 2 + 36, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8_000, 24); header.writeUInt32LE(16_000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(frames * 2, 40);
  const file = await open(fixture, 'w');
  try { await file.write(header, 0, header.length, 0); await file.truncate(header.length + frames * 2); }
  finally { await file.close(); }

  try {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    });
    await page.goto('/');
    await page.getByTestId('input-import-wav').setInputFiles(fixture);
    await expect(page.getByTestId('text-source-name')).toHaveText('brave-large.wav');

    // Keep this regression fixture file-backed but make the produced download small.
    const canvas = (await page.getByTestId('canvas-spectrogram').boundingBox())!;
    const end = (await page.getByTestId('trim-handle-end').boundingBox())!;
    const y = canvas.y + canvas.height / 2;
    await page.mouse.move(end.x + end.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 48 + (canvas.width - 120) * 0.02, y, { steps: 5 });
    await page.mouse.up();

    const wavPromise = page.waitForEvent('download', { predicate: (download) => download.suggestedFilename().endsWith('.wav') });
    const reportPromise = page.waitForEvent('download', { predicate: (download) => download.suggestedFilename().endsWith('.json') });
    await page.getByTestId('nav-export').click();
    await page.getByTestId('button-confirm-export').click();
    const [wavDownload, reportDownload] = await Promise.all([wavPromise, reportPromise]);
    const wav = await readFile(await wavDownload.path());
    const report = JSON.parse((await readFile(await reportDownload.path())).toString());
    expect(wavDownload.suggestedFilename()).toContain('brave-large');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(8_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(32);
    expect(wav.length).toBe(44 + wav.readUInt32LE(40));
    expect(wav.length).toBeGreaterThan(100_000);
    expect(wav.length).toBeLessThan(15_000_000);
    expect(report.container).toBe('RIFF');
    expect(report.trim[1]).toBeLessThan(frames / 8_000 / 10);
    await expect(page.getByText('WAV + report downloads started')).toBeVisible();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});