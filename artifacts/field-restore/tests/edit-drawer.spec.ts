import { expect, test } from '@playwright/test';

test('the edit drawer keeps module controls, summaries, bypass, reorder, and compact reopening in sync', async ({ page }) => {
  await page.goto('/');

  const sidebarRows = page.locator('[data-testid^="sidebar-module-"]');
  const humRow = sidebarRows.filter({ hasText: 'Hum Removal' });
  const humId = (await humRow.getAttribute('data-testid'))?.replace('sidebar-module-', '');
  expect(humId).toBeTruthy();

  await page.getByTestId(`button-open-module-${humId}`).click();

  const drawer = page.getByRole('dialog', { name: 'Edit Hum Removal' });
  const card = page.getByTestId(`card-module-${humId}`);
  await expect(drawer).toBeVisible();
  await expect(card.getByText('Mode', { exact: true })).toBeVisible();
  await expect(card.getByTestId(`select-hum-mode-${humId}`)).toHaveValue('Adaptive');
  await expect(card.locator('.field-label').filter({ hasText: 'Fundamental' })).toContainText('60 Hz');
  await expect(card.getByTestId('range-hum-frequency')).toHaveValue('60');
  await expect(card.locator('.field-label').filter({ hasText: 'Reduction' })).toContainText('12 dB');
  await expect(card.getByTestId('range-hum-reduction')).toHaveValue('12');
  await expect(card).toContainText('Browser-safe approximation');

  await card.getByTestId('range-hum-frequency').fill('72');
  await expect(card.locator('.module-summary')).toHaveText('Adaptive · 72 Hz');
  await expect(humRow.locator('.sidebar-chain-copy small')).toHaveText('Adaptive · 72 Hz');

  const bypassButton = card.getByTestId(`button-bypass-${humId}`);
  await bypassButton.click();
  await expect(bypassButton).toHaveAttribute('aria-pressed', 'false');
  await expect(card).toHaveClass(/bypassed/);
  await expect(humRow).toHaveClass(/bypassed/);
  await expect(page.getByTestId('button-open-full-chain')).toContainText('7/8 enabled');

  const moduleNames = () => sidebarRows.locator('.sidebar-chain-copy strong').allTextContents();
  const orderBeforeMove = await moduleNames();
  const humIndex = orderBeforeMove.indexOf('Hum Removal');
  expect(humIndex).toBeGreaterThanOrEqual(0);
  expect(humIndex).toBeLessThan(orderBeforeMove.length - 1);

  await card.getByTestId(`button-down-${humId}`).click();
  await expect.poll(moduleNames).toEqual([
    ...orderBeforeMove.slice(0, humIndex),
    orderBeforeMove[humIndex + 1],
    'Hum Removal',
    ...orderBeforeMove.slice(humIndex + 2),
  ]);
  await expect(card.locator('.module-index')).toHaveText(String(humIndex + 2).padStart(2, '0'));

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId(`button-open-module-${humId}`)).toBeFocused();

  await page.setViewportSize({ width: 800, height: 900 });
  const compactChainButton = page.getByTestId('button-open-chain');
  await expect(compactChainButton).toBeVisible();
  await compactChainButton.click();
  await expect(page.getByRole('dialog', { name: 'Edit chain' })).toBeVisible();
  await expect(page.getByTestId(`card-module-${humId}`)).toContainText('Adaptive · 72 Hz');
});

for (const layout of ['desktop', 'compact'] as const) {
  test(`${layout} edit drawer traps Tab and restores focus after every close action`, async ({ page }) => {
    await page.setViewportSize(layout === 'compact' ? { width: 800, height: 900 } : { width: 1440, height: 900 });
    await page.goto('/');

    const opener = layout === 'compact'
      ? page.getByTestId('button-open-chain')
      : page.getByTestId('button-open-full-chain');
    const drawer = page.getByRole('dialog', { name: 'Edit chain' });
    const closeButton = drawer.getByTestId('button-close-chain');

    for (const close of ['Escape', 'button', 'backdrop'] as const) {
      await opener.focus();
      await page.keyboard.press('Enter');
      await expect(drawer).toBeFocused();

      // Starting on the dialog itself, reverse tabbing must wrap to the last control.
      await page.keyboard.press('Shift+Tab');
      await expect(drawer.locator(':focus')).toHaveCount(1);
      await expect(closeButton).not.toBeFocused();
      await page.keyboard.press('Tab');
      await expect(closeButton).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(drawer.locator(':focus')).toHaveCount(1);
      await page.keyboard.press('Tab');
      await expect(closeButton).toBeFocused();

      if (close === 'Escape') await page.keyboard.press('Escape');
      if (close === 'button') await closeButton.click();
      if (close === 'backdrop') await page.locator('.chain-drawer-backdrop').click({ position: { x: 5, y: 450 } });

      await expect(drawer).toBeHidden();
      await expect(opener).toBeFocused();
    }
  });
}