import { expect, test } from '@playwright/test';

test('Analysis explains LBPR with formulas and both pages display PLR measurements', async ({ page }, testInfo) => {
  await page.goto('/');
  const chainPlr = page.getByTestId('panel-signal-statistics').getByTestId('stat-plr');
  await expect(chainPlr).toContainText('PLR · Peak-to-loudness ratio');
  await expect(chainPlr.locator('.stat-value')).toHaveText(/[+-]?\d+\.\d LU/);
  const value = await chainPlr.locator('.stat-value').innerText();
  await page.getByTestId('tab-analyze').click();
  const analysisPlr = page.getByTestId('stat-plr');
  await expect(analysisPlr).toHaveCount(3);
  await expect(analysisPlr.first().locator('.stat-value')).toHaveText(value);
  await expect(analysisPlr.nth(1)).toContainText('Original PLR');
  await expect(analysisPlr.nth(2)).toContainText('Current PLR');
  const method = page.getByTestId('lbpr-methodology');
  await expect(method.getByRole('heading', { name: 'How LBPR is calculated' })).toBeVisible();
  await expect(method).toContainText('k_c = ceil(0.20 × m_c)');
  await expect(method).toContainText('D_c = P_c − A_c');
  await expect(method).toContainText('Stereo LBPR = (D_Left + D_Right) / 2');
  await expect(page.locator('main')).not.toContainText(/Interpretation notes|TT DR|MAAT|DR14/i);
  await method.screenshot({ path: testInfo.outputPath('lbpr-methodology.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await method.screenshot({ path: testInfo.outputPath('lbpr-methodology-mobile.png') });
  expect(await method.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(await method.evaluate((element) => element.clientWidth));
});