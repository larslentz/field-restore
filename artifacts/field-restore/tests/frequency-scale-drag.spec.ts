import { expect, test } from '@playwright/test';

test('both channel rulers pan the frequency range and move the drawn labels', async ({ page }) => {
  await page.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.fillText;
    (window as any).__frequencyTicks = [] as { label: string; y: number }[];
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
      if (this.canvas?.dataset.testid === 'canvas-spectrogram' && x === 42 && this.textAlign === 'right') {
        (window as any).__frequencyTicks.push({ label: String(text), y });
      }
      return original.call(this, text, x, y, ...rest);
    };
  });
  await page.goto('/');
  const canvas = page.getByTestId('canvas-spectrogram');
  await expect(canvas).toBeVisible();
  const bounds = (await canvas.boundingBox())!;
  const paneHeight = (bounds.height - 42) / 2;
  const x = bounds.x + 30;
  const topY = bounds.y + paneHeight / 2;
  const bottomY = topY + paneHeight;

  const range = async () => {
    const label = await canvas.getAttribute('aria-label');
    const match = label?.match(/from (\d+(?:\.\d+)?) to (\d+(?:\.\d+)?) kilohertz/);
    if (!match) throw new Error(`Frequency range missing from canvas label: ${label}`);
    return { minimum: Number(match[1]), maximum: Number(match[2]) };
  };
  const drawnLabelPositions = () => page.evaluate(() =>
    ((window as any).__frequencyTicks as { label: string; y: number }[])
      .filter((tick) => tick.label === '10k').slice(-2).map((tick) => tick.y),
  );

  await expect.poll(async () => (await drawnLabelPositions()).length).toBe(2);
  await expect.poll(async () => {
    const [leftChannel, rightChannel] = await drawnLabelPositions();
    return rightChannel - leftChannel;
  }).toBeCloseTo(paneHeight, 0);
  const initial = await range();
  const originalTicks = await drawnLabelPositions();
  await page.mouse.move(x, topY);
  await page.mouse.down();
  await page.mouse.move(x, topY + 65, { steps: 6 });
  await expect.poll(async () => (await range()).minimum).toBeGreaterThan(initial.minimum + 1);
  await expect.poll(async () => (await drawnLabelPositions())[0]).toBeGreaterThan(originalTicks[0] + 10);
  const moved = await range();
  expect(moved.maximum - moved.minimum).toBeCloseTo(initial.maximum - initial.minimum, 5);
  await expect.poll(async () => {
    const [leftChannel, rightChannel] = await drawnLabelPositions();
    return rightChannel - leftChannel;
  }).toBeCloseTo(paneHeight, 0);
  await page.mouse.up();

  await page.mouse.move(x, bottomY);
  await page.mouse.down();
  await page.mouse.move(x, bottomY - 65, { steps: 6 });
  await expect.poll(async () => (await range()).minimum).toBeLessThan(moved.minimum - 1);
  await page.mouse.up();
  const released = await range();
  await page.mouse.move(x, bottomY + 30, { steps: 3 });
  expect(await range()).toEqual(released);

  await page.mouse.move(x, bottomY);
  const pointerRatio = 1 - (bottomY - bounds.y - paneHeight) / paneHeight;
  const grabbed = released.minimum + pointerRatio * (released.maximum - released.minimum);
  await page.mouse.wheel(0, -120);
  await expect.poll(async () => (await range()).maximum - (await range()).minimum).toBeLessThan(released.maximum - released.minimum);
  const zoomed = await range();
  expect(Math.abs(zoomed.minimum + pointerRatio * (zoomed.maximum - zoomed.minimum) - grabbed)).toBeLessThan(0.15);
});