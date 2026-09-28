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
  await expect(page.getByTestId('button-open-full-chain')).toContainText('5/6 editable enabled');
});

test('a noise sample captured on an imported file cannot be applied after switching to the demo', async ({ page }) => {
  const sampleRate = 8_000;
  const frames = sampleRate * 2;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(700 * Math.sin(2 * Math.PI * 400 * i / sampleRate)), 44 + i * 2);

  await page.goto('/');
  await page.getByTestId('input-import-wav').setInputFiles({ name: 'recording-a.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(page.getByTestId('text-source-name')).toHaveText('recording-a.wav');
  await expect(page.getByTestId('text-selection-time')).toHaveText('No selection · full track');
  const canvas = page.getByTestId('canvas-spectrogram');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const plotWidth = box.width - 120;
  const y = box.y + box.height / 4;
  await page.mouse.move(box.x + 48 + plotWidth * .15, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 48 + plotWidth * .7, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('text-selection-time')).toContainText('selected');
  await page.getByTestId('button-add-module').click();
  await page.getByTestId('menu-module-noise').click();
  const noiseRow = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: 'Noise Reduction' });
  const moduleId = (await noiseRow.getAttribute('data-testid'))!.replace('sidebar-module-', '');
  await page.getByTestId(`button-open-module-${moduleId}`).click();
  const card = page.getByTestId(`card-module-${moduleId}`);
  await card.getByTestId(`button-noise-sample-${moduleId}`).click();
  await expect(card.getByTestId(`select-noise-mode-${moduleId}`)).toHaveValue('Sample');
  await page.getByTestId('button-close-chain').click();

  const presetMenu = page.getByTestId('select-local-preset');
  await presetMenu.selectOption('save');
  await page.getByTestId('input-preset-name').fill('Recording A sample');
  await page.getByTestId('button-confirm-save-preset').click();
  await page.getByTestId('nav-demo').click();
  await presetMenu.selectOption({ label: 'Recording A sample' });
  await expect(page.getByTestId('status-error')).toContainText('Noise Reduction is now Automatic');
  const newRow = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: 'Noise Reduction' });
  const newId = (await newRow.getAttribute('data-testid'))!.replace('sidebar-module-', '');
  await page.getByTestId(`button-open-module-${newId}`).click();
  const newCard = page.getByTestId(`card-module-${newId}`);
  await expect(newCard.getByTestId(`select-noise-mode-${newId}`)).toHaveValue('Automatic');
  await expect(newCard.getByTestId(`select-noise-mode-${newId}`).locator('option[value="Sample"]')).toHaveCount(0);
});