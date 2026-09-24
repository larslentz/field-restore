import { expect, test } from '@playwright/test';

test('statistics below the spectrogram follow the Original and Edited view, including the selection', async ({ page }) => {
  await page.goto('/');
  const bar = page.getByTestId('panel-signal-statistics');
  const fullFile = bar.locator('.signal-stats-group').first();
  const selection = bar.locator('.signal-stats-group').last();
  await expect(bar.getByTestId('label-statistics-source')).toHaveText('Edited');
  const editedFull = await fullFile.locator('.stat-grid').innerText();
  const editedSelection = await selection.locator('.stat-grid').innerText();

  await page.getByTestId('button-spectrogram-original').click();
  await expect(page.getByTestId('label-spectrogram-source')).toContainText('Original recording');
  await expect(bar.getByTestId('label-statistics-source')).toHaveText('Original');
  await expect(fullFile.locator('.signal-stats-label')).toContainText('Original / full file');
  await expect(selection.locator('.signal-stats-label')).toContainText('Original / selection');
  const originalFull = await fullFile.locator('.stat-grid').innerText();
  const originalSelection = await selection.locator('.stat-grid').innerText();
  expect(originalFull).not.toBe(editedFull);
  expect(originalSelection).not.toBe(editedSelection);

  await page.getByTestId('button-spectrogram-edited').click();
  await expect(bar.getByTestId('label-statistics-source')).toHaveText('Edited');
  await expect.poll(() => fullFile.locator('.stat-grid').innerText()).toBe(editedFull);
  await expect.poll(() => selection.locator('.stat-grid').innerText()).toBe(editedSelection);
});