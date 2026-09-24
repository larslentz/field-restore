import { expect, test, type Locator } from '@playwright/test';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

const fixtureDir = path.join(import.meta.dirname, '.fixtures');
const wavPath = path.join(fixtureDir, 'large-worker-lifecycle.wav');

async function createLargeWav() {
  const sampleRate = 8_000;
  const channels = 2;
  const bytesPerSample = 1;
  const dataSize = 64 * 1024 * 1024 + sampleRate * channels;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(dataSize + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  await mkdir(fixtureDir, { recursive: true });
  const file = await open(wavPath, 'w');
  try {
    await file.write(header, 0, header.length, 0);
    await file.truncate(header.length + dataSize);
  } finally {
    await file.close();
  }
}

async function ids(locator: Locator) {
  return locator.evaluate((element) => ({
    request: Number(element.getAttribute('data-request-id')),
    result: Number(element.getAttribute('data-result-id')),
  }));
}

test.beforeAll(createLargeWav);

test('large stereo spectrogram stays interactive and cancels superseded viewports', async ({ page }) => {
  await page.goto('/');
  const startedAt = performance.now();
  await page.getByTestId('input-import-wav').setInputFiles(wavPath);
  await expect(page.getByTestId('text-source-name')).toHaveText('large-worker-lifecycle.wav');

  const spectrogram = page.getByTestId('canvas-spectrogram');
  await expect.poll(async () => {
    const value = await ids(spectrogram);
    return value.request > 0 && value.result === value.request;
  }, { timeout: 15_000 }).toBe(true);
  expect(performance.now() - startedAt).toBeLessThan(15_000);

  // Display-only dB changes must redraw from cached spectral data, not start workers.
  const beforeDbChange = await ids(spectrogram);
  const beforeDbLabel = await spectrogram.getAttribute('aria-label');
  const box = await spectrogram.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width - 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => spectrogram.getAttribute('aria-label')).not.toBe(beforeDbLabel);
  await expect(spectrogram).toHaveAttribute('aria-label', /decibel scale/);
  expect(await ids(spectrogram)).toEqual(beforeDbChange);

  // Record every committed result while one viewport request supersedes another.
  await spectrogram.evaluate((element) => {
    const committed = [Number(element.getAttribute('data-result-id'))];
    new MutationObserver(() => {
      committed.push(Number(element.getAttribute('data-result-id')));
    }).observe(element, { attributes: true, attributeFilter: ['data-result-id'] });
    (window as typeof window & { __spectrogramCommittedResults?: number[] }).__spectrogramCommittedResults = committed;
  });
  await page.getByTestId('button-zoom-in').click();
  await expect.poll(async () => (await ids(spectrogram)).request).toBeGreaterThan(beforeDbChange.request);
  const supersededRequest = (await ids(spectrogram)).request;
  await page.getByTestId('button-zoom-in').click();
  await expect.poll(async () => (await ids(spectrogram)).request).toBeGreaterThan(supersededRequest);
  const newestRequest = (await ids(spectrogram)).request;
  await expect.poll(async () => (await ids(spectrogram)).result, { timeout: 15_000 }).toBe(newestRequest);
  const committedResults = await page.evaluate(
    () => (window as typeof window & { __spectrogramCommittedResults?: number[] }).__spectrogramCommittedResults ?? [],
  );
  expect(committedResults).not.toContain(supersededRequest);
});

test('cancelled and superseded worker results never reach the UI', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('input-import-wav').setInputFiles(wavPath);
  await expect(page.getByTestId('text-source-name')).toHaveText('large-worker-lifecycle.wav');

  const status = page.getByTestId('status-background-work');
  await expect(status).toBeVisible();

  // The main thread must remain interactive while both real workers are busy.
  await page.getByTestId('button-help').click();
  await expect(page.getByRole('dialog', { name: 'A quiet tool for noisy places' })).toBeVisible();
  await page.getByTestId('button-done-help').click();

  await page.getByTestId('button-analysis-pause').click();
  await expect(status).toContainText('paused');
  await page.waitForTimeout(300);
  const pausedProgress = await status.getAttribute('data-progress');
  await page.waitForTimeout(700);
  expect(await status.getAttribute('data-progress')).toBe(pausedProgress);

  await page.getByTestId('button-analysis-pause').click();
  await expect.poll(async () => Number(await status.getAttribute('data-progress'))).toBeGreaterThan(Number(pausedProgress));

  const statistics = page.getByTestId('panel-signal-statistics');
  const spectrogram = page.getByTestId('canvas-spectrogram');
  const beforeCancel = { analysis: await ids(statistics), spectrogram: await ids(spectrogram) };
  await page.getByTestId('button-analysis-cancel').click();
  await expect(status).toBeHidden();
  await page.waitForTimeout(1_000);
  expect((await ids(statistics)).result).toBe(beforeCancel.analysis.result);
  expect((await ids(spectrogram)).result).toBe(beforeCancel.spectrogram.result);

  // Start overlapping generations by changing zoom, selection, and the edit chain.
  await page.getByTestId('button-zoom-in').click();
  const box = await spectrogram.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.75, box!.y + box!.height * 0.45);
  await page.mouse.up();
  await page.locator('[data-testid^="sidebar-module-"]').first().getByRole('button', { name: 'Bypass Gain' }).click();
  await page.getByTestId('button-zoom-in').click();

  await expect.poll(async () => {
    const value = await ids(spectrogram);
    return value.result === value.request && value.request > beforeCancel.spectrogram.request;
  }, { timeout: 120_000 }).toBe(true);
  await expect.poll(async () => {
    const value = await ids(statistics);
    return value.result === value.request && value.request > beforeCancel.analysis.request;
  }, { timeout: 120_000 }).toBe(true);

  await expect(status).toBeHidden();
  await expect(page.getByTestId('text-selection-time')).not.toContainText('5.000 s selected');
});