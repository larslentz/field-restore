import { expect, test } from '@playwright/test';

const dialogs = [
  {
    name: 'Export restoration',
    opener: 'button-export',
    close: 'button-close-export',
    action: 'button-cancel-export',
    last: 'button-confirm-export',
  },
  {
    name: 'A quiet tool for noisy places',
    opener: 'button-help',
    close: 'button-close-help',
    action: 'button-done-help',
    last: 'button-done-help',
  },
  {
    name: 'Preferences',
    opener: 'button-settings',
    close: 'button-close-settings',
    action: 'button-done-settings',
    last: 'button-done-settings',
  },
] as const;

for (const { name, opener: openerId, close: closeId, action: actionId, last: lastId } of dialogs) {
  test(`${name} contains keyboard focus and restores its opener on dismissal`, async ({ page }) => {
    await page.goto('/');
    const opener = page.getByTestId(openerId);
    const dialog = page.getByRole('dialog', { name });
    const close = dialog.getByTestId(closeId);
    const action = dialog.getByTestId(actionId);
    const last = dialog.getByTestId(lastId);

    for (const dismissal of ['Escape', 'close', 'action'] as const) {
      await opener.focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await expect(close).toBeFocused();

      await page.keyboard.press('Shift+Tab');
      await expect(dialog.locator(':focus')).toHaveCount(1);
      await expect(last).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(close).toBeFocused();
      await last.focus();
      await page.keyboard.press('Tab');
      await expect(close).toBeFocused();

      if (dismissal === 'Escape') await page.keyboard.press('Escape');
      if (dismissal === 'close') await close.click();
      if (dismissal === 'action') await action.click();
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    }
  });
}

test('alternate export and project settings openers also regain focus', async ({ page }) => {
  await page.goto('/');
  const exportOpener = page.getByTestId('nav-export');
  await exportOpener.click();
  await expect(page.getByRole('dialog', { name: 'Export restoration' }).getByTestId('button-close-export')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(exportOpener).toBeFocused();

  await page.getByTestId('tab-project').click();
  const settingsOpener = page.getByTestId('button-project-settings');
  await settingsOpener.click();
  await expect(page.getByRole('dialog', { name: 'Preferences' }).getByTestId('button-close-settings')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(settingsOpener).toBeFocused();
});