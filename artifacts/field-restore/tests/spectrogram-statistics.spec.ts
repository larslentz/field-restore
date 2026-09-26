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
  const plotBeforeDetails = (await plot.boundingBox())!;
  const railBeforeDetails = (await panel.boundingBox())!;
  await details.evaluate((element) => {
    const filler = document.createElement('div');
    filler.dataset.layoutProbe = 'details';
    filler.style.height = '600px';
    element.appendChild(filler);
  });
  rail = (await panel.boundingBox())!;
  plotBounds = (await plot.boundingBox())!;
  expect(plotBounds.y).toBeCloseTo(plotBeforeDetails.y, 0);
  expect(plotBounds.height).toBeCloseTo(plotBeforeDetails.height, 0);
  expect(rail.y).toBeCloseTo(railBeforeDetails.y, 0);
  await details.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect((await panel.boundingBox())!.y).toBeCloseTo(rail.y, 0);
  expect((await plot.boundingBox())!.y).toBeCloseTo(plotBounds.y, 0);
  await details.evaluate((element) => { element.querySelector('[data-layout-probe]')?.remove(); });
  expect((await plot.boundingBox())!.height).toBeCloseTo(plotBeforeDetails.height, 0);

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

test('vertical rail hugs the sidebar and gives the recovered width to the plot on wide and tablet screens', async ({ page }) => {
  await page.setViewportSize({ width: 2200, height: 800 });
  await page.goto('/');
  const panel = page.getByTestId('panel-signal-statistics');
  const plot = page.getByTestId('canvas-spectrogram');
  const switcher = page.getByTestId('button-statistics-orientation');
  const horizontalPlotWidth = (await plot.boundingBox())!.width;
  const horizontalPlotX = (await plot.boundingBox())!.x;
  await switcher.click();

  for (const viewport of [{ width: 2200, height: 800 }, { width: 900, height: 700 }]) {
    await page.setViewportSize(viewport);
    const sidebar = (await page.locator('.sidebar-shell').boundingBox())!;
    const rail = (await panel.boundingBox())!;
    const canvas = (await plot.boundingBox())!;
    expect(rail.x - sidebar.x - sidebar.width).toBeGreaterThanOrEqual(10);
    expect(rail.x - sidebar.x - sidebar.width).toBeLessThanOrEqual(20);
    expect(rail.width).toBeGreaterThanOrEqual(160);
    expect(rail.width).toBeLessThanOrEqual(172);
    expect(canvas.x).toBeGreaterThan(rail.x + rail.width);
    expect(canvas.width).toBeGreaterThan(200);
    await expect(switcher).toBeInViewport();
    const heading = (await panel.locator('.signal-stats-heading').boundingBox())!;
    const tools = (await panel.locator('.signal-stats-tools').boundingBox())!;
    expect(tools.x + tools.width).toBeLessThanOrEqual(rail.x + rail.width);
    expect(tools.y + tools.height).toBeLessThanOrEqual(heading.y + heading.height);
    await expect(panel.locator('.signal-stats-label')).toBeVisible();
    const grid = panel.locator('.stat-grid');
    const lbpr = panel.locator('.lbpr-cell');
    await lbpr.scrollIntoViewIfNeeded();
    await expect(lbpr.locator('.lbpr-channel')).toHaveCount(2);
    const lbprBounds = (await lbpr.boundingBox())!;
    const gridBounds = (await grid.boundingBox())!;
    expect(lbprBounds.y + lbprBounds.height).toBeLessThanOrEqual(gridBounds.y + gridBounds.height + 1);
    expect(lbprBounds.x + lbprBounds.width).toBeLessThanOrEqual(rail.x + rail.width + 1);
    await expect(page.getByTestId('transport-dock')).toBeInViewport();
    await page.getByTestId('button-spectral-selection-mode').click();
    await expect(page.getByTestId('button-add-spectral-repair')).toBeInViewport();
    await page.getByTestId('button-spectral-selection-mode').click();
  }
  await page.setViewportSize({ width: 2200, height: 800 });
  expect((await plot.boundingBox())!.width).toBeGreaterThan(horizontalPlotWidth + 60);
  await switcher.click();
  expect((await plot.boundingBox())!.width).toBeCloseTo(horizontalPlotWidth, 0);
  expect((await plot.boundingBox())!.x).toBeCloseTo(horizontalPlotX, 0);
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