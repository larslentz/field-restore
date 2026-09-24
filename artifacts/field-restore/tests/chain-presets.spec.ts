import { expect, test } from '@playwright/test';

test('saving an edit chain makes it reloadable without changing the current project', async ({ page }) => {
  await page.goto('/');
  const presetMenu = page.getByTestId('select-local-preset');
  const humRow = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: 'Hum Removal' });
  const bypass = humRow.getByRole('button', { name: 'Bypass Hum Removal' });
  await bypass.click();
  await expect(humRow).toHaveClass(/bypassed/);

  await presetMenu.selectOption('save');
  const dialog = page.getByRole('dialog', { name: 'Save edit chain' });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('input-preset-name').fill('My quiet field chain');
  await dialog.getByTestId('button-confirm-save-preset').click();
  await expect(dialog).toBeHidden();
  await expect(presetMenu.locator('option', { hasText: 'My quiet field chain' })).toHaveCount(1);
  await expect(humRow).toHaveClass(/bypassed/);

  await page.reload();
  await expect(presetMenu.locator('option', { hasText: 'My quiet field chain' })).toHaveCount(1);
  await presetMenu.selectOption('common-field');
  await expect(humRow).not.toHaveClass(/bypassed/);
  await presetMenu.selectOption({ label: 'My quiet field chain' });
  await expect(humRow).toHaveClass(/bypassed/);
  await expect(page.getByTestId('button-open-full-chain')).toContainText('7/8 editable enabled');
});