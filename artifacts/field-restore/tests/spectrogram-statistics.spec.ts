import { expect, test } from '@playwright/test';

test('one set of statistics follows the selection and the Original/Edited view', async ({ page }) => {
  await page.goto('/');
  const bar = page.getByTestId('panel-signal-statistics');
  const group = bar.locator('.signal-stats-group');
  await expect(group).toHaveCount(1);
  await expect(bar.getByTestId('label-statistics-source')).toHaveText('Edited');
  await expect(group.locator('.signal-stats-label')).toContainText('Edited / selection within kept range');
  await expect(group.locator('.stat-grid')).toBeVisible();
  const editedSelection = await group.locator('.stat-grid').innerText();

  await page.getByTestId('button-spectrogram-original').click();
  await expect(page.getByTestId('label-spectrogram-source')).toContainText('Original recording');
  await expect(bar.getByTestId('label-statistics-source')).toHaveText('Original');
  await expect(group.locator('.signal-stats-label')).toContainText('Original / selection');
  await expect(group.locator('.stat-grid')).toBeVisible();
  const originalSelection = await group.locator('.stat-grid').innerText();
  expect(originalSelection).not.toBe(editedSelection);

  await page.getByTestId('button-clear-selection').click();
  await expect(group.locator('.signal-stats-label')).toContainText('Original / full file');
  await expect(group.locator('.stat-grid')).toBeVisible();
  const originalFull = await group.locator('.stat-grid').innerText();
  expect(originalFull).not.toBe(originalSelection);

  await page.getByTestId('button-spectrogram-edited').click();
  await expect(bar.getByTestId('label-statistics-source')).toHaveText('Edited');
  await expect(group.locator('.signal-stats-label')).toContainText('Edited / kept range');
  await expect(group.locator('.stat-grid')).toBeVisible();
  const editedFull = await group.locator('.stat-grid').innerText();
  expect(editedFull).not.toBe(editedSelection);
  expect(editedFull).not.toBe(originalFull);
});