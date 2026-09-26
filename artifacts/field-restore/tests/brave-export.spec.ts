import { expect, test } from '@playwright/test';
import { open, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('downloads a complete file-backed WAV and report without a file-save picker', async ({ page }) => {
  test.setTimeout(120_000);
  const previewIframe = process.env.BRAVE_PREVIEW_IFRAME === '1';
  const targetUrl = new URL('/', process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173').href;
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
    if (!process.env.BRAVE_PATH) {
      // The default Chromium regression simulates Brave's missing picker.
      await page.addInitScript(() => {
        Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
      });
    }
    if (previewIframe) {
      // An opaque about:blank parent denies localStorage in Brave; use the
      // Replit origin that actually embeds the preview.
      await page.goto('https://replit.com/', { waitUntil: 'domcontentloaded' });
      await page.setContent(`<iframe src="${targetUrl}" style="width: 1280px; height: 900px"></iframe>`);
    } else {
      await page.goto('/');
    }
    const app = previewIframe ? page.frameLocator('iframe') : page;
    if (process.env.BRAVE_PATH) {
      expect(await app.locator('html').evaluate(() => typeof window.showSaveFilePicker)).toBe('undefined');
    }
    await app.getByTestId('input-import-wav').setInputFiles(fixture);
    await expect(app.getByTestId('text-source-name')).toHaveText('brave-large.wav');

    // Keep this regression fixture file-backed but make the produced download small.
    const canvas = (await app.getByTestId('canvas-spectrogram').boundingBox())!;
    const end = (await app.getByTestId('trim-handle-end').boundingBox())!;
    const y = canvas.y + canvas.height / 2;
    await page.mouse.move(end.x + end.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 48 + (canvas.width - 120) * 0.02, y, { steps: 5 });
    await page.mouse.up();

    const popupPromise = previewIframe ? page.waitForEvent('popup') : null;
    const wavPromise = previewIframe ? null : page.waitForEvent('download', { predicate: (download) => download.suggestedFilename().endsWith('.wav') });
    const reportPromise = previewIframe ? null : page.waitForEvent('download', { predicate: (download) => download.suggestedFilename().endsWith('.json') });
    await app.getByTestId('nav-export').click();
    await app.getByTestId('button-confirm-export').click();
    const downloadPage = popupPromise ? await popupPromise : page;
    const [wavDownload, reportDownload] = await Promise.race([
      Promise.all([
        wavPromise ?? downloadPage.waitForEvent('download', { predicate: (download) => download.suggestedFilename().endsWith('.wav') }),
        reportPromise ?? downloadPage.waitForEvent('download', { predicate: (download) => download.suggestedFilename().endsWith('.json') }),
      ]),
      app.getByText('Streaming downloads are unavailable in this browser context', { exact: false })
        .waitFor({ state: 'visible' })
        .then(() => { throw new Error('Brave denied the streaming download service worker in this browser context.'); }),
    ]);
    expect(await wavDownload.failure()).toBeNull();
    expect(await reportDownload.failure()).toBeNull();
    const wav = await readFile(await wavDownload.path());
    const report = JSON.parse((await readFile(await reportDownload.path())).toString());
    expect(wavDownload.suggestedFilename()).toBe('brave-large_FR.wav');
    expect(reportDownload.suggestedFilename()).toBe('brave-large-restoration-report.json');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.readUInt16LE(20)).toBe(3);
    expect(wav.readUInt32LE(24)).toBe(8_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(32);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.length).toBe(44 + wav.readUInt32LE(40));
    const outputFrames = wav.readUInt32LE(40) / 4;
    expect(Number.isInteger(outputFrames)).toBe(true);
    expect(outputFrames).toBe(Math.ceil(report.trim[1] * 8_000) - Math.floor(report.trim[0] * 8_000));
    expect(wav.length).toBeGreaterThan(100_000);
    expect(wav.length).toBeLessThan(15_000_000);
    expect(report.container).toBe('RIFF');
    expect(report.trim[1]).toBeLessThan(frames / 8_000 / 10);
    await expect(app.getByText('WAV + report downloads started')).toBeVisible();
    if (previewIframe) {
      await expect(downloadPage.getByText('WAV and restoration report downloads started.', { exact: false })).toBeVisible();
    }
    if (process.env.BRAVE_PATH) {
      const downloads = await page.context().newPage();
      await downloads.goto('brave://downloads/');
      await expect.poll(async () => downloads.evaluate(() => {
        const manager = document.querySelector('downloads-manager');
        const list = manager?.shadowRoot?.querySelector('#downloadsList');
        return [...(list?.querySelectorAll('downloads-item') ?? [])].map((item) => {
          const data = (item as HTMLElement & { data?: { fileName?: string; state?: number } }).data;
          return { name: data?.fileName, state: data?.state };
        });
      })).toEqual(expect.arrayContaining([
        // Playwright saves managed downloads under UUID paths; the browser's
        // Downloads page shows those paths rather than Content-Disposition names.
        expect.objectContaining({ name: path.basename(await wavDownload.path()), state: 2 }),
        expect.objectContaining({ name: path.basename(await reportDownload.path()), state: 2 }),
      ]));
      await downloads.close();
      console.log(JSON.stringify({
        url: targetUrl, context: previewIframe ? 'cross-origin iframe' : 'standalone tab',
        browser: 'Brave', wav: wavDownload.suggestedFilename(),
        bytes: wav.length, frames: outputFrames, sampleRate: wav.readUInt32LE(24),
        channels: wav.readUInt16LE(22), format: wav.readUInt16LE(20),
        report: reportDownload.suggestedFilename(), browserDownloadState: 'complete',
      }));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});