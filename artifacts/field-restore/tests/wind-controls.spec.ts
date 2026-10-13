import { expect, test } from '@playwright/test';

test('Wind Removal exposes adjustable reduction, crossover, and smoothing controls', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: 'Wind Removal' });
  const id = (await row.getAttribute('data-testid'))!.replace('sidebar-module-', '');
  await page.getByTestId(`button-open-module-${id}`).click();

  const card = page.getByTestId(`card-module-${id}`);
  await expect(card.getByTestId(`select-wind-detection-${id}`)).toHaveValue('Medium');
  const reduction = card.getByTestId('range-wind-reduction');
  const crossover = card.getByTestId('range-wind-crossoverHz');
  const smoothing = card.getByTestId('range-wind-smoothing');

  await expect(reduction).toHaveAttribute('min', '0');
  await expect(reduction).toHaveAttribute('max', '100');
  await expect(reduction).toHaveValue('72');
  await expect(crossover).toHaveAttribute('min', '40');
  await expect(crossover).toHaveValue('140');
  await expect(smoothing).toHaveAttribute('min', '0');
  await expect(smoothing).toHaveAttribute('max', '100');
  await expect(smoothing).toHaveValue('50');

  await reduction.fill('88');
  await crossover.fill('795');
  await smoothing.fill('70');
  await expect(reduction).toHaveValue('88');
  await expect(crossover).toHaveValue('795');
  await expect(smoothing).toHaveValue('70');
  await expect(card).toContainText('Higher Reduction removes more low-frequency signal');
});
