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

test('statistics can move beside the spectrogram and return without changing measurements', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  const panel = page.getByTestId('panel-signal-statistics');
  const plot = page.getByTestId('canvas-spectrogram');
  const dock = page.getByTestId('transport-dock');
  const switcher = page.getByTestId('button-statistics-orientation');
  await expect(panel.locator('.stat-grid')).toBeVisible();
  const initialValues = await panel.locator('.stat-grid').textContent();
  const initialPlot = (await plot.boundingBox())!;
  await expect(switcher).toHaveAccessibleName('Show signal statistics vertically');
  await switcher.click();
  await expect(switcher).toHaveAccessibleName('Show signal statistics horizontally');
  await expect(panel.locator('.signal-stats-group')).toHaveCount(1);
  expect(await panel.locator('.stat-grid').textContent()).toBe(initialValues);
  let rail = (await panel.boundingBox())!;
  let plotBounds = (await plot.boundingBox())!;
  expect(rail.x + rail.width).toBeLessThan(plotBounds.x);
  expect(rail.y + rail.height).toBeLessThanOrEqual((await dock.boundingBox())!.y);
  expect(plotBounds.height).toBeGreaterThan(80);

  const details = page.getByTestId('edit-secondary');
  await details.evaluate((element) => {
    const filler = document.createElement('div');
    filler.style.height = '600px';
    element.appendChild(filler);
  });
  rail = (await panel.boundingBox())!;
  plotBounds = (await plot.boundingBox())!;
  await details.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect((await panel.boundingBox())!.y).toBeCloseTo(rail.y, 0);
  expect((await plot.boundingBox())!.y).toBeCloseTo(plotBounds.y, 0);

  await page.getByTestId('button-spectral-selection-mode').click();
  await expect(page.getByTestId('button-add-spectral-repair')).toBeInViewport();
  await page.getByTestId('button-add-spectral-repair').click();
  await expect(page.getByTestId('status-spectral-error')).toContainText('time-only selection');
  expect((await panel.boundingBox())!.x).toBeCloseTo(rail.x, 0);
  await page.getByTestId('button-spectral-selection-mode').click();

  await page.getByTestId('button-spectrogram-original').click();
  await expect(panel.locator('.signal-stats-label')).toContainText('Original / selection');
  await page.getByTestId('button-clear-selection').click();
  await expect(panel.locator('.signal-stats-label')).toContainText('Original / full file');
  await page.getByTestId('button-spectrogram-edited').click();
  await expect(panel.locator('.signal-stats-label')).toContainText('Edited / kept range');
  await page.getByTestId('tab-analyze').click();
  await page.getByTestId('nav-edit').click();
  await expect(switcher).toHaveAccessibleName('Show signal statistics horizontally');

  await page.reload();
  await expect(switcher).toHaveAccessibleName('Show signal statistics horizontally');
  rail = (await panel.boundingBox())!;
  plotBounds = (await plot.boundingBox())!;
  expect(rail.x + rail.width).toBeLessThan(plotBounds.x);
  await switcher.click();
  await expect(switcher).toHaveAccessibleName('Show signal statistics vertically');
  expect((await plot.boundingBox())!.width).toBeCloseTo(initialPlot.width, 0);
  expect((await panel.boundingBox())!.y).toBeGreaterThan((await plot.boundingBox())!.y);
});

test('narrow screens explain when the vertical layout falls back to a horizontal bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto('/');
  await page.getByTestId('button-statistics-orientation').click();
  const panel = page.getByTestId('panel-signal-statistics');
  const plot = page.getByTestId('canvas-spectrogram');
  await expect(panel.locator('.stats-narrow-hint')).toBeVisible();
  await expect(panel.locator('.stats-narrow-hint')).toContainText('wider screens');
  await expect(panel).toBeInViewport();
  await expect(plot).toBeInViewport();
  expect((await panel.boundingBox())!.y).toBeGreaterThan((await plot.boundingBox())!.y);
  await expect(page.getByTestId('transport-dock')).toBeInViewport();
});