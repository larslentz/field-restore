import { expect, test, type Download } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('Wind activity preview matches the saved report and cancellation leaves edits unchanged', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Enable Wind Removal', exact: true }).click();
  const chainBefore = await page.locator('[data-testid^="sidebar-module-"]').allTextContents();
  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  await page.getByTestId('nav-export').click();
  const preview = page.getByTestId('export-wind-preview');
  for (const label of ['Active:', 'Idle:', 'Unconfirmed:', 'Source-time coverage:']) {
    await expect(preview).toContainText(label);
  }
  await expect(preview).toContainText('exported range only');
  await expect(page.getByTestId('button-confirm-export')).toBeEnabled();
  const lines = await preview.locator('p').allTextContents();
  await page.getByTestId('button-cancel-export').click();
  await expect(page.getByRole('dialog', { name: 'Export restoration' })).toBeHidden();
  expect(downloads).toHaveLength(0);
  expect(await page.locator('[data-testid^="sidebar-module-"]').allTextContents()).toEqual(chainBefore);
  await expect(page.getByRole('button', { name: 'Bypass Wind Removal', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('nav-export').click();
  await expect(preview).toContainText('Unconfirmed:');
  await page.getByTestId('button-confirm-export').click();
  await expect.poll(() => downloads.length).toBe(2);
  const reportDownload = downloads.find((download) => download.suggestedFilename().endsWith('.txt'))!;
  const report = await readFile((await reportDownload.path())!, 'utf8');
  for (const line of lines) expect(report).toContain(line);
  expect(await page.locator('[data-testid^="sidebar-module-"]').allTextContents()).toEqual(chainBefore);
});

test('bypassed Wind Removal does not imply confirmed idle coverage', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('nav-export').click();
  const preview = page.getByTestId('export-wind-preview');
  await expect(preview).toContainText('No enabled automatic Wind Removal');
  await expect(preview).not.toContainText('Idle:');
  await expect(page.getByTestId('button-confirm-export')).toBeEnabled();
  await page.getByTestId('button-close-export').click();
  await expect(page.getByRole('dialog', { name: 'Export restoration' })).toBeHidden();
});
