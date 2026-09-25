import { expect, test } from '@playwright/test';

test('clearing a selection plays the full track, even when looping, and allows selecting again', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('text-selection-time')).toContainText('selected');
  await page.getByTestId('button-clear-selection').click();
  await expect(page.getByTestId('text-selection-time')).toHaveText('No selection · full track');
  await expect(page.getByTestId('button-clear-selection')).toHaveCount(0);
  await expect(page.getByTestId('text-playhead')).toContainText('00:00.0');

  await page.getByTestId('button-loop').click();
  await page.getByTestId('button-play').click();
  await expect.poll(async () => {
    const text = await page.getByTestId('text-playhead').textContent();
    return Number(text?.match(/^00:(\d+\.\d+)/)?.[1] ?? 0);
  }, { timeout: 15_000 }).toBeGreaterThan(8);
  await expect(page.getByTestId('button-play')).toHaveAttribute('aria-label', 'Pause playback');
  await page.getByTestId('button-stop').click();

  const canvas = page.getByTestId('canvas-spectrogram');
  // The expanded statistics panel can scroll the spectrogram out of view after
  // the transport buttons are used; mouse coordinates must be viewport-visible.
  await canvas.scrollIntoViewIfNeeded();
  const bounds = (await canvas.boundingBox())!;
  const y = bounds.y + bounds.height / 4;
  await page.mouse.move(bounds.x + bounds.width * .3, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .55, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('text-selection-time')).toContainText('selected');
  await canvas.dblclick({ position: { x: bounds.width * .4, y: bounds.height / 4 } });
  await expect(page.getByTestId('text-selection-time')).toHaveText('No selection · full track');
  await expect(page.getByTestId('button-clear-selection')).toHaveCount(0);
  await expect(page.getByTestId('text-playhead')).toContainText('00:00.0');
});