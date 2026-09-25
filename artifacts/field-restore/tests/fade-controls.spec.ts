import { expect, test } from '@playwright/test';

test('default chain and both add menus offer one fade with independently adjustable sides', async ({ page }) => {
  await page.goto('/');
  const fades = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: 'Fade In/Out' });
  await expect(fades).toHaveCount(1);
  await page.getByTestId('button-add-module').click();
  await expect(page.getByTestId('menu-module-fade')).toHaveText('Fade In/Out');
  await expect(page.getByTestId('menu-module-fade-in')).toHaveCount(0);
  await expect(page.getByTestId('menu-module-fade-out')).toHaveCount(0);
  await page.getByTestId('menu-module-fade').click();
  await expect(fades).toHaveCount(2);

  const id = (await fades.last().getAttribute('data-testid'))!.replace('sidebar-module-', '');
  await page.getByTestId(`button-open-module-${id}`).click();
  const card = page.getByTestId(`card-module-${id}`);
  for (const side of ['in', 'out']) {
    await expect(card.getByTestId(`range-fade-${side}`)).toHaveAttribute('max', '20');
    await expect(card.getByTestId(`range-fade-${side}`)).toHaveAttribute('step', '0.1');
    await expect(card.getByTestId(`toggle-fade-${side}`)).toBeChecked();
  }
  await expect(card).toContainText('7 s in · 7 s out');
  await card.getByTestId('toggle-fade-in').uncheck();
  await expect(card).toContainText('In off · 7 s out');
  await expect(card.getByTestId('toggle-fade-out')).toBeChecked();
  await card.getByTestId('toggle-fade-in').check();
  await card.getByTestId('toggle-fade-out').uncheck();
  await expect(card).toContainText('7 s in · Out off');
  await card.getByTestId('toggle-fade-out').check();
  await expect(card.getByTestId('fade-in-usage-note')).toContainText('Start marker');
  await expect(card.getByTestId('fade-out-usage-note')).toContainText('End marker');
  await page.getByTestId('button-close-chain').click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('button-open-chain').click();
  const drawer = page.getByRole('dialog', { name: 'Edit chain' });
  await drawer.getByRole('button', { name: 'Add module' }).click();
  await expect(drawer.locator('.drawer-module-menu').getByRole('button', { name: 'Fade In/Out' })).toHaveCount(1);
});