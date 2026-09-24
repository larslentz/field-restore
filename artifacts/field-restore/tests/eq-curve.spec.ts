import { expect, test } from '@playwright/test';

test('low rumble and newly added EQ curves reflect live controls and bypass', async ({ page }) => {
  await page.goto('/');
  const lowRumble = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: 'Low Rumble Removal' });
  const lowRumbleId = (await lowRumble.getAttribute('data-testid'))!.replace('sidebar-module-', '');
  await page.getByTestId(`button-open-module-${lowRumbleId}`).click();

  const lowRumbleCard = page.getByTestId(`card-module-${lowRumbleId}`);
  const highPassCurve = lowRumbleCard.getByTestId(`eq-curve-${lowRumbleId}`);
  await expect(highPassCurve).toBeVisible();
  const initialHighPass = await highPassCurve.getByTestId('eq-response-path').getAttribute('d');
  await lowRumbleCard.getByTestId('range-wind-cutoff').fill('180');
  await expect.poll(() => highPassCurve.getByTestId('eq-response-path').getAttribute('d')).not.toBe(initialHighPass);
  await lowRumbleCard.getByTestId(`button-bypass-${lowRumbleId}`).click();
  await expect(highPassCurve).toContainText('Bypassed · not applied');
  await page.getByTestId('button-close-chain').click();

  const lowShelf = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: 'Bring Back the Low End' });
  const lowShelfId = (await lowShelf.getAttribute('data-testid'))!.replace('sidebar-module-', '');
  await page.getByTestId(`button-open-module-${lowShelfId}`).click();
  await expect(page.getByTestId(`eq-curve-${lowShelfId}`)).toBeVisible();
  await page.getByTestId('button-close-chain').click();

  await page.getByTestId('button-add-module').click();
  await page.getByTestId('menu-module-eq').click();
  const eqRow = page.locator('[data-testid^="sidebar-module-"]').filter({ has: page.locator('strong').getByText('EQ', { exact: true }) });
  const eqId = (await eqRow.getAttribute('data-testid'))!.replace('sidebar-module-', '');
  await page.getByTestId(`button-open-module-${eqId}`).click();
  const eqCard = page.getByTestId(`card-module-${eqId}`);
  const eqCurve = eqCard.getByTestId(`eq-curve-${eqId}`);
  await expect(eqCurve).toBeVisible();
  const initialEq = await eqCurve.getByTestId('eq-response-path').getAttribute('d');
  await eqCard.getByTestId('range-eq-low').fill('8');
  await expect.poll(() => eqCurve.getByTestId('eq-response-path').getAttribute('d')).not.toBe(initialEq);
  await expect(eqCurve).toContainText('Mid and high controls share the upper band');
});