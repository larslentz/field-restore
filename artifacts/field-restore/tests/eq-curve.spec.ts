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
    const shelfCurve = card.getByTestId(`eq-curve-low-end-${id}`);
    await expect(shelfCurve).toBeVisible();
    if (!initiallyEnabled) await expect(shelfCurve).toContainText('Off · not applied');
    const shelfFollowsControls = await card.evaluate((element, moduleId) => {
      const controls = element.querySelector(`[data-testid="low-end-controls-${moduleId}"]`);
      return controls?.nextElementSibling?.getAttribute('data-testid') === `eq-curve-low-end-${moduleId}`;
    }, id);
    expect(shelfFollowsControls).toBe(true);

    const removalCurve = name === 'Low Rumble Removal' ? card.getByTestId(`eq-curve-${id}`) : null;
    if (removalCurve) {
      await expect(removalCurve).toContainText('Frequency response · Low Rumble Removal');
      const removalPrecedesShelf = await card.evaluate((element, moduleId) => {
        const curve = element.querySelector(`[data-testid="eq-curve-${moduleId}"]`);
        const controls = element.querySelector(`[data-testid="low-end-controls-${moduleId}"]`);
        return Boolean(curve && controls && (curve.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING));
      }, id);
      expect(removalPrecedesShelf).toBe(true);
    } else {
      await expect(card.getByTestId(`eq-curve-${id}`)).toHaveCount(0);
    }
    if (!initiallyEnabled) await toggle.check();
    if (name === 'Wind Removal') {
      const scope = card.getByTestId(`select-low-end-scope-${id}`);
      const timing = card.getByTestId(`wind-compensation-timing-${id}`);
      await expect(scope).toHaveValue('Whole recording');
      await expect(timing).toHaveCount(0);
      await scope.selectOption('Detected wind only');
      await expect(timing).toBeVisible();
      const attack = card.getByTestId(`range-wind-compensation-attack-${id}`);
      const release = card.getByTestId(`range-wind-compensation-release-${id}`);
      await expect(attack).toHaveValue('25');
      await expect(attack).toHaveAttribute('min', '5');
      await expect(attack).toHaveAttribute('max', '250');
      await expect(release).toHaveValue('180');
      await expect(release).toHaveAttribute('min', '20');
      await expect(release).toHaveAttribute('max', '1000');
      await attack.fill('105');
      await release.fill('520');
      await expect(attack).toHaveValue('105');
      await expect(release).toHaveValue('520');
    }
    const initialShelfPath = await shelfCurve.getByTestId('eq-response-path').getAttribute('d');
    const initialRemovalPath = removalCurve && await removalCurve.getByTestId('eq-response-path').getAttribute('d');
    await card.getByTestId('range-wind-lowEndGain').fill('8');
    await expect.poll(() => shelfCurve.getByTestId('eq-response-path').getAttribute('d')).not.toBe(initialShelfPath);
    if (removalCurve) await expect(removalCurve.getByTestId('eq-response-path')).toHaveAttribute('d', initialRemovalPath!);
    if (name === 'Wind Removal') {
      await expect(shelfCurve).toContainText('wind reduction varies over time and is not shown');
      await expect(shelfCurve).toContainText('Detected wind only');
      await expect(shelfCurve).toContainText('shelf follows detected wind');
    }
    await toggle.uncheck();
    await expect(shelfCurve).toContainText('Off · not applied');
    if (name === 'Wind Removal') await expect(card.getByTestId(`wind-compensation-timing-${id}`)).toHaveCount(0);
    await card.getByTestId(`button-bypass-${id}`).click();
    await expect(shelfCurve).toContainText('Bypassed · not applied');
    if (removalCurve) await expect(removalCurve).toContainText('Bypassed · not applied');
    await page.getByTestId('button-close-chain').click();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('button-open-chain').click();
  await page.getByRole('dialog', { name: 'Edit chain' }).getByRole('button', { name: 'Add module' }).click();
  await expect(page.locator('.drawer-module-menu').getByRole('button', { name: 'Bring Back the Low End' })).toHaveCount(0);
  await page.getByRole('dialog', { name: 'Edit chain' }).getByRole('button', { name: 'Add module' }).click();
  for (const name of ['Low Rumble Removal', 'Wind Removal']) {
    await page.locator('.chain-drawer-mobile-list').getByRole('button', { name: new RegExp(name) }).click();
    const card = page.locator('.chain-drawer-body [data-testid^="card-module-"]');
    const id = (await card.getAttribute('data-testid'))!.replace('card-module-', '');
    await expect(card.getByTestId(`eq-curve-low-end-${id}`)).toBeVisible();
    if (name === 'Low Rumble Removal') await expect(card.getByTestId(`eq-curve-${id}`)).toBeVisible();
    const plotsFitViewport = await card.locator('.eq-curve').evaluateAll((plots) => plots.every((plot) => {
      const { left, right } = plot.getBoundingClientRect();
      return left >= 0 && right <= window.innerWidth + 1;
    }));
    expect(plotsFitViewport).toBe(true);
  }
});