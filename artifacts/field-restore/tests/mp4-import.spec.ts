import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const stereo = fixture('mp4-aac-stereo.mp4');
const audioOnly = fixture('mp4-audio-only.mp4');

test('AAC video imports, saves, verifies relink, and exports only float WAV without changing the MP4', async ({ page }) => {
  const originalHash = createHash('sha256').update(await readFile(stereo)).digest('hex');
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined });
  });
  await page.goto('/');
  await page.getByTestId('input-import-wav').setInputFiles(stereo);
  await expect(page.getByTestId('text-source-name')).toHaveText('mp4-aac-stereo.mp4');
  await expect(page.getByTestId('status-error')).toHaveCount(0);
  await page.getByTestId('nav-project').click();
  await page.getByTestId('input-project-title').fill('MP4 audio review');
  await page.getByTestId('nav-save').click();
  await expect(page.locator('.topbar .chip').first()).toContainText('Project saved');
  await page.reload();
  await expect(page.locator('.topbar .chip').first()).toContainText('relink source audio');
  await page.getByTestId('input-import-wav').setInputFiles(audioOnly);
  await expect(page.getByTestId('status-error')).toContainText('does not match');
  await expect(page.getByTestId('text-source-name')).toHaveText('mp4-aac-stereo.mp4');
  await page.getByTestId('nav-import-new-source').click();
  await page.getByTestId('input-import-wav').setInputFiles(audioOnly);
  await expect(page.getByTestId('text-source-name')).toHaveText('mp4-audio-only.mp4');
  // Opening another recording does not delete the saved project waiting for relink.
  await page.reload();
  await expect(page.locator('.topbar .chip').first()).toContainText('relink source audio');
  await page.getByTestId('input-import-wav').setInputFiles(stereo);
  await expect(page.locator('.topbar .chip').first()).toContainText('Source relinked');
  await page.getByTestId('nav-project').click();
  await expect(page.getByTestId('input-project-title')).toHaveValue('MP4 audio review');
  const downloads: import('@playwright/test').Download[] = [];
  page.on('download', item => downloads.push(item));
  await page.getByTestId('nav-export').click();
  await page.getByTestId('button-confirm-export').click();
  await expect.poll(() => downloads.length).toBe(2);
  expect(downloads.some(item => item.suggestedFilename().endsWith('.mp4'))).toBe(false);
  const wav = await readFile((await downloads.find(item => item.suggestedFilename().endsWith('.wav'))!.path())!);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.readUInt16LE(20)).toBe(3);
  expect(wav.readUInt16LE(22)).toBe(2);
  expect(wav.readUInt32LE(24)).toBe(48000);
  expect(wav.readUInt16LE(34)).toBe(32);
  // The 2-second presentation excludes AAC priming/padding.
  expect(wav.readUInt32LE(40)).toBe(96000 * 2 * 4);
  let peak = 0;
  for (let offset = 44; offset < wav.length; offset += 4) peak = Math.max(peak, Math.abs(wav.readFloatLE(offset)));
  // The enabled restoration chain can strongly attenuate these synthetic pure tones.
  expect(peak).toBeGreaterThan(0.000001);
  expect(createHash('sha256').update(await readFile(stereo)).digest('hex')).toBe(originalHash);
  await expect(page.getByTestId('status-error')).toHaveCount(0);
});

test('an audio-only MP4 without an extension can be dropped by MIME type', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(data => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'audio-track', { type: 'audio/mp4' }));
    document.querySelector('.app-shell')!.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  }, (await readFile(audioOnly)).toString('base64'));
  await expect(page.getByTestId('text-source-name')).toHaveText('audio-track');
  await expect(page.getByTestId('status-error')).toHaveCount(0);
});

test('missing audio, unsupported layout and damaged MP4 leave the current project intact', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('input-import-wav').setInputFiles(stereo);
  await expect(page.getByTestId('text-source-name')).toHaveText('mp4-aac-stereo.mp4');
  await page.getByTestId('input-import-wav').setInputFiles(fixture('mp4-no-audio.mp4'));
  await expect(page.getByTestId('status-error')).toContainText('does not contain an audio track');
  await page.getByTestId('input-import-wav').setInputFiles(fixture('mp4-multichannel.mp4'));
  await expect(page.getByTestId('status-error')).toContainText('unsupported channel layout');
  await page.getByTestId('input-import-wav').setInputFiles({
    name: 'broken.mp4', mimeType: 'video/mp4', buffer: (await readFile(stereo)).subarray(0, 100),
  });
  await expect(page.getByTestId('status-error')).toBeVisible();
  await expect(page.getByTestId('text-source-name')).toHaveText('mp4-aac-stereo.mp4');
});

test('unavailable native codec is reported instead of accepting an unusable source', async ({ page }) => {
  await page.addInitScript(() => {
    if ('AudioDecoder' in window) Object.defineProperty(AudioDecoder, 'isConfigSupported', {
      value: async (config: unknown) => ({ supported: false, config }),
    });
  });
  await page.goto('/');
  const previous = await page.getByTestId('text-source-name').innerText();
  await page.getByTestId('input-import-wav').setInputFiles(stereo);
  await expect(page.getByTestId('status-error')).toContainText('cannot be decoded');
  await expect(page.getByTestId('text-source-name')).toHaveText(previous);
});

test('cancelling an import keeps the open recording and reports cancellation', async ({ page }) => {
  await page.addInitScript(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function () {
      if (this.size === 12) await new Promise(resolve => setTimeout(resolve, 1000));
      return read.call(this);
    };
  });
  await page.goto('/');
  const previous = await page.getByTestId('text-source-name').innerText();
  await page.getByTestId('input-import-wav').setInputFiles(stereo);
  await page.getByTestId('button-import-cancel').click();
  await expect(page.getByTestId('status-error')).toContainText('Import cancelled');
  await expect(page.getByTestId('button-import-cancel')).toHaveCount(0);
  await expect(page.getByTestId('text-source-name')).toHaveText(previous);
});

test('large video reads stay bounded, ranged AAC stays sample-aligned, and abort propagates', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async data => {
    const path = '/src/lib/source-audio.ts';
    const audio = await import(/* @vite-ignore */ path);
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, 70 * 1024 * 1024 + 8);
    header.set(new TextEncoder().encode('free'), 4);
    const file = new File([Uint8Array.from(atob(data), c => c.charCodeAt(0)), header,
      new Blob(Array(70).fill(new Uint8Array(1024 * 1024)))], 'large-video.mp4', { type: 'video/mp4' });
    let largestRead = 0;
    const slice = file.slice.bind(file);
    file.slice = (...args) => {
      const blob = slice(...args);
      const read = blob.arrayBuffer.bind(blob);
      blob.arrayBuffer = () => { largestRead = Math.max(largestRead, blob.size); return read(); };
      return blob;
    };
    file.arrayBuffer = async () => { throw new Error('Whole-video buffering is forbidden'); };
    const metadata = await audio.parseAudioMetadata(file, { name: file.name });
    const hash = await audio.fingerprintAudio(file, metadata);
    const full = await audio.readAudioFrames(file, metadata, 0, metadata.frameCount);
    const range = await audio.readAudioFrames(file, audio.audioRange(metadata, 64000, 16000), 0, 16000);
    let difference = 0;
    for (let channel = 0; channel < 2; channel++) for (let i = 0; i < 16000; i++) {
      difference = Math.max(difference, Math.abs(full[channel][64000 + i] - range[channel][i]));
    }
    const abort = new AbortController(); abort.abort();
    let abortName = '';
    try { await audio.readAudioFrames(file, metadata, 0, 1024, { signal: abort.signal }); }
    catch (error) { abortName = (error as Error).name; }
    return { largestRead, difference, abortName, frames: metadata.frameCount, hash,
      channels: range.length, samples: range[0].length, metadataClone: structuredClone(metadata).format };
  }, (await readFile(stereo)).toString('base64'));
  expect(result.largestRead).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(result.difference).toBeLessThan(0.00001);
  expect(result.frames).toBe(96000);
  expect(result.samples).toBe(16000);
  expect(result.channels).toBe(2);
  expect(result.abortName).toBe('AbortError');
  expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.metadataClone).toBe('MP4');
});
