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
    const sidebar = page.locator('.sidebar-shell');
    const main = page.locator('.main-shell');

    for (const dismissal of ['Escape', 'close', 'action'] as const) {
      await expect(sidebar).not.toHaveAttribute('inert');
      await expect(main).not.toHaveAttribute('inert');
      await expect(opener).toBeVisible();
      await opener.focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await expect(close).toBeFocused();
      for (const background of [sidebar, main]) {
        await expect(background).toHaveAttribute('inert', '');
        await expect(background).toHaveAttribute('aria-hidden', 'true');
      }
      await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toHaveCount(0);
      await expect(page.getByRole('main')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Play playback' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Export', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('heading', { name })).toBeVisible();

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
      for (const background of [sidebar, main]) {
        await expect(background).not.toHaveAttribute('inert');
        await expect(background).not.toHaveAttribute('aria-hidden');
      }
      await expect(opener).toBeFocused();
      await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible();
      await expect(page.getByRole('main')).toBeVisible();
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

test('Save edit chain contains focus, hides the background, and restores the preset menu on dismissal', async ({ page }) => {
  await page.goto('/');
  const opener = page.getByTestId('select-local-preset');
  const dialog = page.getByRole('dialog', { name: 'Save edit chain' });
  const input = dialog.getByTestId('input-preset-name');
  const close = dialog.getByTestId('button-close-save-preset');
  const save = dialog.getByTestId('button-confirm-save-preset');
  const sidebar = page.locator('.sidebar-shell');
  const main = page.locator('.main-shell');

  for (const dismissal of ['Escape', 'close', 'Cancel'] as const) {
    await opener.selectOption('save');
    await expect(dialog).toBeVisible();
    await expect(input).toBeFocused();
    for (const background of [sidebar, main]) {
      await expect(background).toHaveAttribute('inert', '');
      await expect(background).toHaveAttribute('aria-hidden', 'true');
    }
    await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toHaveCount(0);
    await expect(page.getByRole('main')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Play playback' })).toHaveCount(0);
    await expect(page.getByText('Coastal dawn / north bluff')).toHaveCount(0);

    await page.keyboard.press('Shift+Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(save).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(input).toBeFocused();

    if (dismissal === 'Escape') await page.keyboard.press('Escape');
    if (dismissal === 'close') await close.click();
    if (dismissal === 'Cancel') await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    for (const background of [sidebar, main]) {
      await expect(background).not.toHaveAttribute('inert');
      await expect(background).not.toHaveAttribute('aria-hidden');
    }
    await expect(opener).toBeFocused();
    await expect(page.getByRole('main')).toBeVisible();
  }
});

test('saving an edit chain returns focus to the preset menu', async ({ page }) => {
  await page.goto('/');
  const opener = page.getByTestId('select-local-preset');
  await opener.selectOption('save');
  const dialog = page.getByRole('dialog', { name: 'Save edit chain' });
  await dialog.getByTestId('input-preset-name').fill('Accessible field chain');
  await dialog.getByTestId('button-confirm-save-preset').click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(opener.locator('option', { hasText: 'Accessible field chain' })).toHaveCount(1);
  await expect(page.locator('.main-shell')).not.toHaveAttribute('aria-hidden');
});

test('the edit drawer retains its existing background and focus behavior', async ({ page }) => {
  await page.goto('/');
  const opener = page.getByTestId('button-open-full-chain');
  await opener.click();
  const drawer = page.getByRole('dialog', { name: 'Edit chain' });
  await expect(drawer).toBeFocused();
  await expect(page.locator('.sidebar-shell')).not.toHaveAttribute('inert');
  await expect(page.locator('.main-shell')).not.toHaveAttribute('aria-hidden');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
});