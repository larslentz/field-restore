import { expect, test } from '@playwright/test';

test('low rumble and low-end shelf curves reflect live controls and bypass', async ({ page }) => {
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
  const shelfCard = page.getByTestId(`card-module-${lowShelfId}`);
  const shelfCurve = shelfCard.getByTestId(`eq-curve-${lowShelfId}`);
  await expect(shelfCurve).toBeVisible();
  const initialShelf = await shelfCurve.getByTestId('eq-response-path').getAttribute('d');
  await shelfCard.getByTestId('range-eq-gain').fill('8');
  await expect.poll(() => shelfCurve.getByTestId('eq-response-path').getAttribute('d')).not.toBe(initialShelf);
});