import { expect, test } from '@playwright/test';

const explanation = 'Save edits, markers, trim, and notes in this browser. No WAV is downloaded; use Export for audio.';

test('save explains browser storage and both export entry points remain equivalent', async ({ page }) => {
  await page.goto('/');
  const sessionOrder = await page.locator('[data-testid="nav-import"], [data-testid="nav-export"], [data-testid="nav-save"], [data-testid="nav-demo"]')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-testid')));
  expect(sessionOrder).toEqual(['nav-import', 'nav-export', 'nav-save', 'nav-demo']);
  const sidebarSave = page.getByTestId('nav-save');
  await expect(sidebarSave).toHaveAccessibleName('Save project');
  await expect(sidebarSave).toHaveAttribute('aria-describedby', 'sidebar-save-project-description');
  await expect(page.locator('#sidebar-save-project-description')).toBeVisible();
  await expect(page.locator('#sidebar-save-project-description')).toHaveText(explanation);

  await page.getByTestId('nav-project').click();
  const projectSave = page.getByTestId('button-project-save');
  await expect(projectSave).toHaveText('Save project');
  await expect(projectSave).toHaveAttribute('aria-describedby', 'project-save-description');
  await expect(page.locator('#project-save-description')).toHaveText(explanation);
  await expect(page.locator('#project-save-description')).toBeVisible();

  for (const exportButton of ['nav-export', 'button-export']) {
    await expect(page.getByTestId(exportButton)).toHaveAccessibleName('Export 32-bit WAV');
    await page.getByTestId(exportButton).click();
    await expect(page.getByRole('dialog', { name: 'Export restoration' })).toBeVisible();
    await expect(page.getByTestId('button-confirm-export')).toHaveText('Export 32-bit float WAV + report');
    await page.getByTestId('button-close-export').click();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebarSave).toHaveAccessibleName('Save project');
  await expect(sidebarSave).toHaveAttribute('aria-describedby', 'sidebar-save-project-description');
  await expect(page.locator('#sidebar-save-project-description')).toHaveCSS('position', 'absolute');
  await expect(page.locator('#project-save-description')).toBeVisible();
  const noteFits = await page.locator('#project-save-description').evaluate((note) => note.getBoundingClientRect().right <= window.innerWidth + 1);
  expect(noteFits).toBe(true);
});