import { expect, test } from '@playwright/test';

test('dragging a sidebar module reorders once, remains undoable, and does not trigger WAV import errors', async ({ page }) => {
  await page.goto('/');

  const rows = page.locator('[data-testid^="sidebar-module-"]');
  const moduleNames = () => rows.locator('.sidebar-chain-copy strong').allTextContents();
  const originalOrder = await moduleNames();
  expect(originalOrder.length).toBeGreaterThan(1);

  const firstHandle = rows.nth(0).locator('[data-testid^="drag-module-"]');
  const secondRow = rows.nth(1);
  const targetBox = await secondRow.boundingBox();
  expect(targetBox).not.toBeNull();
  await firstHandle.dragTo(secondRow, {
    targetPosition: { x: targetBox!.width / 2, y: targetBox!.height - 2 },
  });

  await expect.poll(moduleNames).toEqual([
    originalOrder[1],
    originalOrder[0],
    ...originalOrder.slice(2),
  ]);
  await expect(page.getByTestId('status-error')).toBeHidden();

  await page.getByTestId('button-undo').click();
  await expect.poll(moduleNames).toEqual(originalOrder);
});