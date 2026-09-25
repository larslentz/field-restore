import { expect, test } from '@playwright/test';

test('both removal items offer independent low-end shelves with honest response curves', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: 'Bring Back the Low End' })).toHaveCount(0);
  await page.getByTestId('button-add-module').click();
  await expect(page.getByTestId('menu-module-bring-back-low-end')).toHaveCount(0);
  await page.getByTestId('button-add-module').click();

  for (const [name, initiallyEnabled, noteName] of [
    ['Low Rumble Removal', true, 'Low Rumble Removal'],
    ['Wind Removal', false, 'Wind Removal'],
  ] as const) {
    const row = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: name });
    const id = (await row.getAttribute('data-testid'))!.replace('sidebar-module-', '');
    await page.getByTestId(`button-open-module-${id}`).click();
    const card = page.getByTestId(`card-module-${id}`);
    const toggle = card.getByTestId(`toggle-low-end-${id}`);
    await expect(toggle).toHaveJSProperty('checked', initiallyEnabled);
    await expect(card.getByTestId(`bring-back-low-end-usage-note-${id}`)).toContainText(noteName);
    for (const [key, min, max, step] of [
      ['lowEndFrequency', '20', '240', '0.5'],
      ['lowEndQ', '0.1', '2', '0.01'],
      ['lowEndGain', '-12', '12', '0.1'],
    ]) {
      const range = card.getByTestId(`range-wind-${key}`);
      await expect(range).toHaveAttribute('min', min);
      await expect(range).toHaveAttribute('max', max);
      await expect(range).toHaveAttribute('step', step);
    }
    if (!initiallyEnabled) await toggle.check();
    const curve = card.getByTestId(`eq-curve-${id}`);
    await expect(curve).toBeVisible();
    const initialPath = await curve.getByTestId('eq-response-path').getAttribute('d');
    await card.getByTestId('range-wind-lowEndGain').fill('8');
    await expect.poll(() => curve.getByTestId('eq-response-path').getAttribute('d')).not.toBe(initialPath);
    if (name === 'Wind Removal') await expect(curve).toContainText('wind reduction not shown');
    await toggle.uncheck();
    if (name === 'Wind Removal') await expect(curve).toHaveCount(0);
    await card.getByTestId(`button-bypass-${id}`).click();
    if (name === 'Low Rumble Removal') await expect(curve).toContainText('Bypassed · not applied');
    await page.getByTestId('button-close-chain').click();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('button-open-chain').click();
  await page.getByRole('dialog', { name: 'Edit chain' }).getByRole('button', { name: 'Add module' }).click();
  await expect(page.locator('.drawer-module-menu').getByRole('button', { name: 'Bring Back the Low End' })).toHaveCount(0);
});