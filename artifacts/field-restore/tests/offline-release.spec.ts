import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { FLAC_SINE_BASE64 } from './fixtures/flac-sine';

function rf64() {
  const frames = 16000, header = 80;
  const wav = Buffer.alloc(header + frames * 2);
  wav.write('RF64'); wav.writeUInt32LE(0xffffffff, 4); wav.write('WAVEds64', 8); wav.writeUInt32LE(28, 16);
  wav.writeBigUInt64LE(BigInt(wav.length - 8), 20); wav.writeBigUInt64LE(BigInt(frames * 2), 28);
  wav.writeBigUInt64LE(BigInt(frames), 36);
  wav.write('fmt ', 48); wav.writeUInt32LE(16, 52); wav.writeUInt16LE(1, 56); wav.writeUInt16LE(1, 58);
  wav.writeUInt32LE(8000, 60); wav.writeUInt32LE(16000, 64); wav.writeUInt16LE(2, 68); wav.writeUInt16LE(16, 70);
  wav.write('data', 72); wav.writeUInt32LE(0xffffffff, 76);
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(2000 * Math.sin(i * .24)), header + i * 2);
  return wav;
}
test('complete production setup survives offline reload, FLAC/MP4/RF64 editing, relink and downloads', async ({ page, context }) => {
  // Exercise the real picker-free streaming route; native pickers are checked separately.
  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }));
  await page.goto('/');
  await page.getByTestId('button-install').click();
  await expect(page.getByTestId('dialog-install')).toContainText('Ready for offline use');
  await page.getByRole('button', { name: /Close install/i }).click();
  const resources = await page.evaluate(async () => {
    const keys = (await caches.keys()).filter(key => key.startsWith('field-restore-shell-'));
    return (await (await caches.open(keys[0])).keys()).map(request => request.url);
  });
  expect(resources.some(url => url.endsWith('.woff2'))).toBe(true);
  expect(resources.some(url => url.includes('analysis.worker-'))).toBe(true);
  expect(resources.some(url => url.includes('spectral-prep.worker-'))).toBe(true);
  expect(resources.some(url => url.includes('/releases/') || url.includes('__export/'))).toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('text-source-name')).toBeVisible();
  await page.getByTestId('button-play').click();
  await page.getByTestId('button-play').click();
  await page.getByTestId('input-import-wav').setInputFiles({
    name: 'offline.flac', mimeType: 'audio/flac', buffer: Buffer.from(FLAC_SINE_BASE64, 'base64'),
  });
  await expect(page.getByTestId('text-source-name')).toHaveText('offline.flac');
  await page.getByTestId('nav-save').click();
  await expect(page.locator('.topbar .chip').first()).toContainText('Project saved');
  await page.reload();
  await expect(page.getByTestId('text-source-name')).toHaveText('offline.flac');
  const mp4 = await readFile(new URL('./fixtures/mp4-aac-stereo.mp4', import.meta.url));
  await page.getByTestId('input-import-wav').setInputFiles({ name: 'offline.mp4', mimeType: 'video/mp4', buffer: mp4 });
  await expect(page.getByTestId('text-source-name')).toHaveText('offline.mp4');
  await page.getByTestId('nav-save').click();
  await expect(page.locator('.topbar .chip').first()).toContainText('Project saved');
  await page.reload();
  await expect(page.locator('.topbar .chip').first()).toContainText('relink source audio');
  await page.getByTestId('input-import-wav').setInputFiles({ name: 'offline.mp4', mimeType: 'video/mp4', buffer: mp4 });
  await expect(page.locator('.topbar .chip').first()).toContainText('Source relinked');
  await expect(page.getByTestId('status-error')).toHaveCount(0);
  const mp4Download = page.waitForEvent('download', item => item.suggestedFilename().endsWith('.wav'));
  const mp4Report = page.waitForEvent('download', item => item.suggestedFilename().endsWith('.txt'));
  await page.getByTestId('nav-export').click();
  await page.getByTestId('button-confirm-export').click();
  const mp4Wav = await readFile((await (await mp4Download).path())!);
  expect(mp4Wav.readUInt32LE(24)).toBe(48000);
  expect(mp4Wav.readUInt16LE(22)).toBe(2);
  expect(mp4Wav.length).toBe(44 + 96000 * 2 * 4);
  await (await mp4Report).path();
  await page.getByTestId('input-import-wav').setInputFiles({ name: 'offline-rf64.wav', mimeType: 'audio/wav', buffer: rf64() });
  await expect(page.getByTestId('text-source-name')).toHaveText('offline-rf64.wav');
  await page.getByTestId('nav-save').click();
  await expect(page.locator('.topbar .chip').first()).toContainText('Project saved');
  await page.reload();
  await expect(page.locator('.topbar .chip').first()).toContainText('relink source audio');
  await page.getByTestId('input-import-wav').setInputFiles({ name: 'offline-rf64.wav', mimeType: 'audio/wav', buffer: rf64() });
  await expect(page.locator('.topbar .chip').first()).toContainText('Source relinked');
  await page.getByTestId('nav-analyze').click();
  await expect(page.getByText('Loud-Block Peak-to-RMS (LBPR)', { exact: false }).first()).toBeVisible();
  await page.getByTestId('nav-project').click();
  await page.getByTestId('textarea-project-description-sentence1').fill('A quiet offline field recording.');
  const descriptionDownload = page.waitForEvent('download');
  await page.getByTestId('button-download-track-description').click();
  const descriptionFile = await descriptionDownload;
  expect(await readFile((await descriptionFile.path())!, 'utf8')).toContain('A quiet offline field recording.');
  const downloads: import('@playwright/test').Download[] = [];
  page.on('download', download => downloads.push(download));
  await page.getByTestId('nav-export').click();
  await page.getByTestId('button-confirm-export').click();
  await expect.poll(() => downloads.length).toBe(2);
  const wav = downloads.find(download => download.suggestedFilename().endsWith('.wav'))!;
  const data = await readFile((await wav.path())!);
  expect(data.toString('ascii', 0, 4)).toBe('RIFF');
  expect(data.length).toBe(44 + 16000 * 4);
  const report = downloads.find(download => download.suggestedFilename().endsWith('.txt'))!;
  expect((await readFile((await report.path())!, 'utf8')).length).toBeGreaterThan(100);
  expect(await page.evaluate(async () => {
    const cache = await caches.open((await caches.keys()).find(key => key.startsWith('field-restore-shell-'))!);
    return (await cache.keys()).some(request => request.url.includes('__export/') || request.url.includes('/releases/'));
  })).toBe(false);
  await expect(page.getByTestId('status-error')).toHaveCount(0);
});

test('queued worker updates do not activate or reload an open unsaved project', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('button-install').click();
  await expect(page.getByTestId('status-install')).toContainText('Ready for offline use');
  await page.getByTestId('button-install-close').click();
  await page.getByTestId('nav-project').click();
  const field = page.getByTestId('textarea-project-description-sentence1');
  await field.fill('Unsaved text must survive a queued update.');
  const controller = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/export-download-sw.js?queued-release-test', { scope: '/', updateViaCache: 'none' });
  });
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true);
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(controller);
  await expect(field).toHaveValue('Unsaved text must survive a queued update.');
  await page.getByTestId('button-install').click();
  await expect(page.getByTestId('dialog-install')).toContainText('Update queued');
});