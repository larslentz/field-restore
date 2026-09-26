import { expect, test } from '@playwright/test';

test('Edit spectrogram, statistics and transport stay fixed while details scroll on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  for (const viewport of [{ width: 1280, height: 540 }, { width: 390, height: 640 }]) {
    await page.setViewportSize(viewport);
    const content = page.locator('main.main-content');
    const details = page.getByTestId('edit-secondary');
    const canvas = page.getByTestId('canvas-spectrogram');
    const statistics = page.getByTestId('panel-signal-statistics');
    const dock = page.getByTestId('transport-dock');
    await expect(dock).toBeInViewport();
    await expect(statistics).toBeInViewport();
    await expect(canvas).toBeInViewport();
    const canvasBounds = (await canvas.boundingBox())!;
    const statsBounds = (await statistics.boundingBox())!;
    const dockBounds = (await dock.boundingBox())!;
    expect(canvasBounds.height).toBeGreaterThan(80);
    expect(canvasBounds.y + canvasBounds.height).toBeLessThan(statsBounds.y);
    expect(statsBounds.y + statsBounds.height).toBeLessThanOrEqual(dockBounds.y);
    expect(dockBounds.y + dockBounds.height).toBeLessThanOrEqual(viewport.height + 1);

    await details.evaluate((element) => {
      const humDetails = document.createElement('div');
      humDetails.dataset.layoutProbe = 'hum';
      humDetails.innerHTML = '<div class="hum-overlay-note"><strong>Hum Removal playback history.</strong> Filter estimates and heard positions.</div><div data-testid="live-hum-transport">Now playing · tracked hum filter estimates</div>';
      const repairDetails = document.createElement('div');
      repairDetails.dataset.layoutProbe = 'repair';
      repairDetails.className = 'repair-summary';
      repairDetails.style.height = '600px';
      repairDetails.textContent = 'Click & pop repairs and comparison controls';
      element.append(humDetails, repairDetails);
    });
    const plotWithDetails = (await canvas.boundingBox())!;
    expect(plotWithDetails.y).toBeCloseTo(canvasBounds.y, 0);
    expect(plotWithDetails.height).toBeCloseTo(canvasBounds.height, 0);
    expect((await statistics.boundingBox())!.y).toBeCloseTo(statsBounds.y, 0);
    await details.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect(await details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect((await canvas.boundingBox())!.y).toBeCloseTo(canvasBounds.y, 0);
    expect((await canvas.boundingBox())!.height).toBeCloseTo(canvasBounds.height, 0);
    expect((await statistics.boundingBox())!.y).toBeCloseTo(statsBounds.y, 0);
    await details.evaluate((element) => { element.querySelectorAll('[data-layout-probe]').forEach((probe) => probe.remove()); });
    expect((await canvas.boundingBox())!.height).toBeCloseTo(canvasBounds.height, 0);
    expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(dock).toBeInViewport();
    await page.getByTestId('button-spectral-selection-mode').click();
    await expect(page.getByTestId('button-add-spectral-repair')).toBeInViewport();
    expect((await canvas.boundingBox())!.y).toBeCloseTo(canvasBounds.y, 0);
    expect((await statistics.boundingBox())!.y).toBeCloseTo(statsBounds.y, 0);
    await page.getByTestId('button-add-spectral-repair').click();
    await expect(page.getByTestId('status-spectral-error')).toContainText('time-only selection');
    expect((await canvas.boundingBox())!.y).toBeCloseTo(canvasBounds.y, 0);
    expect((await statistics.boundingBox())!.y).toBeCloseTo(statsBounds.y, 0);
    await page.getByTestId('button-spectral-selection-mode').click();
    for (const control of ['button-play', 'button-stop', 'text-playhead', 'button-loop', 'select-local-preset', 'select-monitor', 'select-playback-rate']) {
      await expect(page.getByTestId(control)).toBeInViewport();
    }
    await page.getByTestId('button-loop').click();
    await expect(page.getByTestId('button-loop')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('button-loop').click();
    await expect(page.getByTestId('button-loop')).toHaveAttribute('aria-pressed', 'false');
  }

  await page.getByTestId('tab-analyze').click();
  await expect(page.getByTestId('transport-dock')).toHaveCount(0);
});

test('live hum status does not resize the spectrogram when playback starts or stops', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.getByTestId('button-clear-selection').click();
  await expect(page.getByTestId('memory-render-status')).toHaveCount(0);
  const canvas = page.getByTestId('canvas-spectrogram');
  const before = (await canvas.boundingBox())!;
  await page.getByTestId('button-play').click();
  await expect(page.getByTestId('live-hum-transport')).toBeAttached();
  const during = (await canvas.boundingBox())!;
  expect(during.y).toBeCloseTo(before.y, 0);
  expect(during.height).toBeCloseTo(before.height, 0);
  await page.getByTestId('button-play').click();
  await expect(page.getByTestId('live-hum-transport')).toHaveCount(0);
  const after = (await canvas.boundingBox())!;
  expect(after.y).toBeCloseTo(before.y, 0);
  expect(after.height).toBeCloseTo(before.height, 0);
});