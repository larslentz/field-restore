import { expect, test } from '@playwright/test';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

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

test('dragged trim handles affect only Edited, survive save and shorten exported WAV', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('input-import-wav').setInputFiles({ name: 'trim-test.wav', mimeType: 'audio/wav', buffer: smallWav() });
  await expect(page.getByTestId('text-source-name')).toHaveText('trim-test.wav');
  await page.getByTestId('button-clear-selection').click();

  const canvas = page.getByTestId('canvas-spectrogram');
  const box = (await canvas.boundingBox())!;
  const plotWidth = box.width - 48 - 72;
  const y = box.y + box.height / 2;
  const drag = async (handle: 'start' | 'end', x: number) => {
    const marker = (await page.getByTestId(`trim-handle-${handle}`).boundingBox())!;
    await page.mouse.move(marker.x + marker.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.up();
  };
  await drag('start', box.x + 48 + plotWidth * 0.2);
  await drag('end', box.x + 48 + plotWidth * 0.8);
  const summary = page.getByTestId('trim-summary');
  await expect(summary).toContainText('00:00.800');
  await expect(summary).toContainText('00:03.200');
  await expect(page.getByTestId('button-reset-trim')).toBeVisible();

  await page.getByTestId('button-spectrogram-original').click();
  await expect(page.getByTestId('trim-handle-start')).toHaveCount(0);
  await expect(page.getByTestId('trim-handle-end')).toHaveCount(0);
  await expect(page.getByTestId('label-statistics-source')).toHaveText('Original');
  await page.getByTestId('button-spectrogram-edited').click();
  await expect(page.getByTestId('trim-handle-start')).toBeVisible();
  await page.mouse.move(box.x + 48 + plotWidth * 0.04, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 48 + plotWidth * 0.12, y, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('panel-signal-statistics')).toContainText('Selection is outside the edited range');
  await page.getByTestId('button-play').click();
  await expect(page.getByTestId('status-error')).toContainText('Selection is outside the edited range');
  await expect(page.getByTestId('button-play')).toHaveAttribute('aria-label', 'Play playback');
  await page.getByTestId('button-clear-selection').click();

  await page.getByTestId('nav-save').click();
  await expect(page.locator('.topbar .chip').first()).toContainText('Saved locally');
  await page.reload();
  await expect(page.getByTestId('text-source-name')).toHaveText('trim-test.wav');
  await expect(page.getByTestId('trim-summary')).toContainText('00:00.800');
  await expect(page.getByTestId('panel-signal-statistics')).toContainText('Edited / kept range');

  const downloads: Array<import('@playwright/test').Download> = [];
  page.on('download', (download) => downloads.push(download));
  await page.getByTestId('nav-export').click();
  await page.getByTestId('button-confirm-export').click();
  await expect.poll(() => downloads.length).toBe(2);
  const wavDownload = downloads.find((download) => download.suggestedFilename().endsWith('.wav'))!;
  const reportDownload = downloads.find((download) => download.suggestedFilename().endsWith('.json'))!;
  const exported = await readFile(await wavDownload.path());
  const report = JSON.parse((await readFile(await reportDownload.path())).toString());
  const frames = exported.readUInt32LE(40) / 8;
  expect(frames).toBeGreaterThan(18_000);
  expect(frames).toBeLessThan(20_000);
  expect(report.trim[0]).toBeCloseTo(0.8, 1);
  expect(report.trim[1]).toBeCloseTo(3.2, 1);
  expect(report.sourceDuration).toBe(4);

  await page.getByTestId('button-reset-trim').click();
  await expect(summary).toContainText('00:00.000 – 00:04.000');
});

test('file-backed export writes only the retained source frames', async ({ page }) => {
  const fixtureDir = path.join(import.meta.dirname, '.fixtures');
  const fixture = path.join(fixtureDir, 'trim-file-backed.wav');
  const frames = 64 * 1024 * 1024 / 2 + 8_000;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(frames * 2 + 36, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(8_000, 24); header.writeUInt32LE(16_000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(8, 34);
  header.write('data', 36); header.writeUInt32LE(frames * 2, 40);
  await mkdir(fixtureDir, { recursive: true });
  const file = await open(fixture, 'w');
  try { await file.write(header, 0, header.length, 0); await file.truncate(header.length + frames * 2); }
  finally { await file.close(); }
  await page.addInitScript(() => {
    (window as typeof window & { showSaveFilePicker: () => Promise<unknown>; __trimExport?: { header: number[]; length: number } }).showSaveFilePicker = async () => ({
      createWritable: async () => {
        let first: number[] = [];
        let length = 0;
        return {
          write: async (chunk: ArrayBuffer) => {
            const bytes = new Uint8Array(chunk);
            if (!first.length) first = Array.from(bytes);
            length += bytes.byteLength;
          },
          close: async () => { (window as typeof window & { __trimExport?: { header: number[]; length: number } }).__trimExport = { header: first, length }; },
          abort: async () => {},
        };
      },
    });
  });
  await page.goto('/');
  await page.getByTestId('input-import-wav').setInputFiles(fixture);
  await expect(page.getByTestId('text-source-name')).toHaveText('trim-file-backed.wav');
  const box = (await page.getByTestId('canvas-spectrogram').boundingBox())!;
  const y = box.y + box.height / 2;
  for (const [edge, fraction] of [['start', 0.01], ['end', 0.02]] as const) {
    const marker = (await page.getByTestId(`trim-handle-${edge}`).boundingBox())!;
    await page.mouse.move(marker.x + marker.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 48 + (box.width - 120) * fraction, y, { steps: 5 });
    await page.mouse.up();
  }
  const reportPromise = page.waitForEvent('download');
  await page.getByTestId('nav-export').click();
  await page.getByTestId('button-confirm-export').click();
  const reportDownload = await reportPromise;
  const report = JSON.parse((await readFile(await reportDownload.path())).toString());
  const result = await page.evaluate(() => (window as typeof window & { __trimExport?: { header: number[]; length: number } }).__trimExport);
  expect(result).toBeDefined();
  const wavHeader = Buffer.from(result!.header);
  const outputFrames = wavHeader.readUInt32LE(40) / 8;
  expect(outputFrames).toBeLessThan(frames / 10);
  expect(outputFrames).toBeGreaterThan(10_000);
  expect(result!.length).toBe(44 + outputFrames * 8);
  expect(report.trim[0]).toBeGreaterThan(0);
  expect(report.trim[1]).toBeLessThan(frames / 8_000 / 10);
});