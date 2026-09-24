import { expect, test } from '@playwright/test';

test('edit chain offers separate fades with only their own 0–20 second control', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('button-add-module').click();
  await expect(page.getByTestId('menu-module-fade-in')).toHaveText('Fade In');
  await expect(page.getByTestId('menu-module-fade-out')).toHaveText('Fade Out');
  await expect(page.getByTestId('menu-module-fade')).toHaveCount(0);
  await page.getByTestId('menu-module-fade-in').click();

  for (const [name, own, other] of [
    ['Fade In', 'in', 'out'],
    ['Fade Out', 'out', 'in'],
  ] as const) {
    const sidebar = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: name }).first();
    const id = (await sidebar.getAttribute('data-testid'))!.replace('sidebar-module-', '');
    await page.getByTestId(`button-open-module-${id}`).click();
    const card = page.getByTestId(`card-module-${id}`);
    await expect(card.getByTestId(`range-fade-${own}`)).toHaveAttribute('max', '20');
    await expect(card.getByTestId(`range-fade-${other}`)).toHaveCount(0);
    await expect(card.getByTestId(`fade-${own}-usage-note`)).toHaveText(own === 'in'
      ? 'This creates a fade in from the Start marker position.'
      : 'This creates a fade out that ends at the End marker position.');
    await expect(card.getByTestId(`fade-${other}-usage-note`)).toHaveCount(0);
    await page.getByTestId('button-close-chain').click();
  }
});