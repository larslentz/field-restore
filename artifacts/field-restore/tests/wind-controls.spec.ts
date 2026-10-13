import { expect, test } from '@playwright/test';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { makeModule } from '../src/lib/edit-chain';

const windDefaults = makeModule('wind').params;

async function createFileBackedWav() {
  const fixtureDir = path.join(import.meta.dirname, '.fixtures');
  const fixture = path.join(fixtureDir, 'wind-crossover-file-backed.wav');
  const sampleRate = 8_000;
  const frames = 64 * 1024 * 1024 / 4 + sampleRate;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(frames * 4 + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(frames * 4, 40);
  await mkdir(fixtureDir, { recursive: true });
  const file = await open(fixture, 'w');
  try {
    await file.write(header, 0, header.length, 0);
    await file.truncate(header.length + frames * 4);
  } finally {
    await file.close();
  }
  return fixture;
}

async function openWindControls(page: import('@playwright/test').Page) {
  const row = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: 'Wind Removal' });
  const id = (await row.getAttribute('data-testid'))!.replace('sidebar-module-', '');
  await page.getByTestId(`button-open-module-${id}`).click();
  return { id, card: page.getByTestId(`card-module-${id}`) };
}

test('Wind Removal exposes adjustable reduction, crossover, and smoothing controls', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: 'Wind Removal' });
  const id = (await row.getAttribute('data-testid'))!.replace('sidebar-module-', '');
  await page.getByTestId(`button-open-module-${id}`).click();

  const card = page.getByTestId(`card-module-${id}`);
  await expect(card.getByTestId(`select-wind-detection-${id}`)).toHaveValue('Medium');
  const reduction = card.getByTestId('range-wind-reduction');
  const crossover = card.getByTestId('range-wind-crossoverHz');
  const smoothing = card.getByTestId('range-wind-smoothing');

  await expect(reduction).toHaveAttribute('min', '0');
  await expect(reduction).toHaveAttribute('max', '100');
  await expect(reduction).toHaveValue(String(windDefaults.reduction));
  await expect(crossover).toHaveAttribute('min', '40');
  await expect(crossover).toHaveValue(String(windDefaults.crossoverHz));
  await expect(smoothing).toHaveAttribute('min', '0');
  await expect(smoothing).toHaveAttribute('max', '100');
  await expect(smoothing).toHaveValue(String(windDefaults.smoothing));

  await reduction.fill('88');
  await crossover.fill('795');
  await smoothing.fill('70');
  await expect(reduction).toHaveValue('88');
  await expect(crossover).toHaveValue('795');
  await expect(smoothing).toHaveValue('70');
  await expect(card).toContainText('Higher Reduction removes more low-frequency signal');
});

test('memory-backed crossover comparison can be cancelled or accepted after A/B audition', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('select-monitor').selectOption('original');
  const { id, card } = await openWindControls(page);
  await card.getByTestId(`button-wind-crossover-compare-${id}`).click();
  await expect(page.getByTestId('select-monitor')).toHaveValue('current');
  const comparison = card.getByTestId(`wind-crossover-comparison-${id}`);
  const alternative = comparison.getByTestId(`range-wind-crossover-alternative-${id}`);
  await expect(alternative).toHaveValue('240');
  await comparison.getByTestId(`button-wind-crossover-b-${id}`).click();
  await expect(page.getByTestId('nav-save')).toBeDisabled();
  await expect(comparison.getByTestId(`wind-crossover-status-${id}`)).toContainText('temporary crossover');
  await expect(page.getByTestId('memory-render-status')).toBeHidden({ timeout: 15_000 });
  await page.getByTestId('button-close-chain').click();
  await page.getByTestId('button-play').click();
  await expect(page.getByTestId('button-play')).toHaveAttribute('aria-label', 'Pause playback');
  await page.getByTestId('button-stop').click();

  await openWindControls(page);
  await page.getByTestId(`button-wind-crossover-cancel-${id}`).click();
  await expect(card.getByTestId('range-wind-crossoverHz')).toHaveValue('140');
  await expect(page.getByTestId('nav-save')).toBeEnabled();

  await page.getByTestId(`button-wind-crossover-compare-${id}`).click();
  await page.getByTestId(`button-wind-crossover-b-${id}`).click();
  await page.getByTestId(`button-wind-crossover-accept-${id}`).click();
  await expect(card.getByTestId('range-wind-crossoverHz')).toHaveValue('240');
  await expect(page.getByTestId('nav-save')).toBeEnabled();
});

test('file-backed playback auditions a temporary crossover without changing the saved value on cancel', async ({ page }) => {
  const fixture = await createFileBackedWav();
  await page.goto('/');
  await page.getByTestId('input-import-wav').setInputFiles(fixture);
  await expect(page.getByTestId('text-source-name')).toHaveText('wind-crossover-file-backed.wav');
  const { id, card } = await openWindControls(page);
  await card.getByTestId(`button-wind-crossover-compare-${id}`).click();
  await card.getByTestId(`button-wind-crossover-b-${id}`).click();
  await expect(page.getByTestId('nav-save')).toBeDisabled();
  await page.getByTestId('button-close-chain').click();
  await page.getByTestId('button-play').click();
  await expect(page.getByTestId('button-play')).toHaveAttribute('aria-label', 'Pause playback', { timeout: 30_000 });
  await page.getByTestId('button-stop').click();
  await openWindControls(page);
  await page.getByTestId(`button-wind-crossover-cancel-${id}`).click();
  await expect(card.getByTestId('range-wind-crossoverHz')).toHaveValue('140');
  await expect(page.getByTestId('nav-save')).toBeEnabled();
});
