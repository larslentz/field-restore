import { expect, test } from '@playwright/test';

test('the shared level scale follows pointer drags in both channel halves', async ({ page }) => {
  await page.goto('/');
  const canvas = page.getByTestId('canvas-spectrogram');
  await expect(canvas).toBeVisible();
  const bounds = (await canvas.boundingBox())!;
  const x = bounds.x + bounds.width - 40;
  const topY = bounds.y + 80;
  const bottomY = bounds.y + bounds.height - 100;

  const range = async () => {
    const label = await canvas.getAttribute('aria-label');
    const match = label?.match(/with (-?\d+(?:\.\d+)?) to (-?\d+(?:\.\d+)?) decibel scale/);
    if (!match) throw new Error(`Level range missing from canvas label: ${label}`);
    return { floor: Number(match[1]), ceiling: Number(match[2]) };
  };

  const start = await range();
  await page.mouse.move(x, topY);
  await page.mouse.down();
  await page.mouse.move(x, topY + 70, { steps: 7 });
  await expect.poll(async () => (await range()).ceiling).toBeGreaterThan(start.ceiling + 5);
  const moved = await range();
  expect(moved.ceiling - moved.floor).toBeCloseTo(start.ceiling - start.floor, 5);
  await page.mouse.up();

  await page.mouse.move(x, bottomY);
  await page.mouse.down();
  await page.mouse.move(x, bottomY - 60, { steps: 6 });
  await expect.poll(async () => (await range()).ceiling).toBeLessThan(moved.ceiling - 5);
  await page.mouse.up();
  const released = await range();
  await page.mouse.move(x, bottomY + 50, { steps: 3 });
  expect(await range()).toEqual(released);

  await page.mouse.move(x, bottomY);
  const ratio = (bottomY - bounds.y) / (bounds.height - 28);
  const grabbed = released.ceiling - ratio * (released.ceiling - released.floor);
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await range()).ceiling - (await range()).floor).toBeLessThan(released.ceiling - released.floor);
  const zoomed = await range();
  expect(Math.abs(zoomed.ceiling - ratio * (zoomed.ceiling - zoomed.floor) - grabbed)).toBeLessThan(0.1);
});