import { expect, test } from '@playwright/test';

test('Edit transport stays visible while the workspace scrolls on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  for (const viewport of [{ width: 1280, height: 540 }, { width: 390, height: 640 }]) {
    await page.setViewportSize(viewport);
    const content = page.locator('main.main-content');
    const dock = page.getByTestId('transport-dock');
    await expect(dock).toBeInViewport();
    const contentBounds = (await content.boundingBox())!;
    const dockBounds = (await dock.boundingBox())!;
    expect(contentBounds.y + contentBounds.height).toBeLessThanOrEqual(dockBounds.y + 1);
    expect(dockBounds.y + dockBounds.height).toBeLessThanOrEqual(viewport.height + 1);

    await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByTestId('panel-signal-statistics')).toBeInViewport({ ratio: 0.1 });
    await expect(dock).toBeInViewport();
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