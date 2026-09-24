import { expect, test } from '@playwright/test';

test('Remove DC Offset stays first and has no edit controls', async ({ page }) => {
  await page.goto('/');
  const automaticRow = page.getByTestId('sidebar-automatic-dc');
  await expect(automaticRow).toContainText('01');
  await expect(automaticRow).toContainText('Remove DC Offset');
  await expect(automaticRow.locator('[draggable]')).toHaveCount(0);
  await expect(automaticRow.getByRole('button')).toHaveCount(1);
  await expect(page.locator('[data-testid^="sidebar-module-"]').first().locator('.module-index')).toHaveText('02');

  await page.getByTestId('button-open-automatic-dc').click();
  const drawer = page.getByRole('dialog', { name: 'Remove DC Offset' });
  await expect(drawer).toContainText('Automatically applied before all editable modules');
  await expect(drawer.getByTestId('card-automatic-dc').locator('input, select, button')).toHaveCount(0);
  await drawer.getByTestId('button-close-chain').click();
  await expect(drawer).toBeHidden();

  await page.getByTestId('button-open-full-chain').click();
  const fullChain = page.getByRole('dialog', { name: 'Edit chain' });
  await expect(fullChain.locator('.chain-drawer-full-list > .module-card').first()).toContainText('Remove DC Offset');
  await expect(fullChain.locator('.chain-drawer-full-list > .module-card').nth(1).locator('.module-index')).toHaveText('02');
});