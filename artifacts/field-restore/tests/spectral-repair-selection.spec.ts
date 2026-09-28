import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function drawOnSpectrogram(page: Page, fromX: number, toX: number, fromY: number, toY: number) {
  const canvas = page.getByTestId('canvas-spectrogram');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * fromX, box.y + box.height * fromY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * toX, box.y + box.height * toY, { steps: 8 });
  await page.mouse.up();
}

test('sidebar Short Sound Repair choice enters rectangle mode, then adds an enabled edit with controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByTestId('button-add-module').click();
  await page.getByTestId('menu-module-spectral-repair').click();
  await expect(page.getByTestId('button-spectral-selection-mode')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('text-spectral-selection')).toContainText('time-and-frequency rectangle');
  await expect(page.getByTestId('text-spectral-selection').locator('..')).toContainText('10 seconds max');
  await expect(page.getByTestId('sidebar-module-menu')).toHaveCount(0);

  await page.getByTestId('button-add-spectral-repair').click();
  await expect(page.getByTestId('status-spectral-error')).toContainText('A time-only selection is not enough');
  await drawOnSpectrogram(page, .28, .38, .18, .35);
  await expect(page.getByTestId('text-spectral-selection')).toContainText('Hz');
  await expect(page.getByTestId('status-spectral-error')).toHaveCount(0);
  await page.getByTestId('button-add-spectral-repair').click();

  const drawer = page.getByRole('dialog', { name: 'Edit Short Sound Repair' });
  await expect(drawer).toBeVisible();
  const card = drawer.locator('[data-testid^="card-module-spectral-repair"]');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-testid^="button-bypass-"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('[data-testid^="input-spectral-low-"]')).toBeVisible();
  await expect(page.locator('[data-testid^="sidebar-module-spectral-repair"]')).toHaveClass(/selected/);
});

test('drawer add menu returns to spectrogram, and ordinary time selection stays distinct', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/');
  await page.getByTestId('button-open-chain').click();
  const drawer = page.getByRole('dialog', { name: 'Edit chain' });
  await drawer.getByRole('button', { name: 'Add module' }).click();
  await drawer.locator('.drawer-module-menu').getByRole('button', { name: 'Short Sound Repair' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByTestId('button-spectral-selection-mode')).toHaveAttribute('aria-pressed', 'true');
  await drawOnSpectrogram(page, .3, .4, .62, .75);
  await expect(page.getByTestId('text-spectral-selection')).toContainText('Hz');
  await page.getByTestId('button-spectral-selection-mode').click();
  await expect(page.getByTestId('button-spectral-selection-mode')).toHaveAttribute('aria-pressed', 'false');
  const before = await page.getByTestId('text-spectral-selection').textContent();
  await drawOnSpectrogram(page, .35, .45, .25, .25);
  await expect(page.getByTestId('text-selection-time')).toContainText('selected');
  await expect(page.getByTestId('text-spectral-selection')).toHaveText(before!);
});

test('the repair created from a rectangle changes exported audio compared with bypass', async ({ page }) => {
  const rate = 16_000;
  const frames = rate * 2;
  const wav = Buffer.alloc(44 + frames * 4);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const tone = .12 * Math.sin(2 * Math.PI * 400 * t) +
      (t >= .8 && t < 1.2 ? .3 * Math.sin(2 * Math.PI * 1000 * t) : 0);
    wav.writeInt16LE(Math.round(tone * 32767), 44 + i * 4);
    wav.writeInt16LE(Math.round(tone * 32767), 46 + i * 4);
  }
  await page.goto('/');
  await page.getByTestId('input-import-wav').setInputFiles({ name: 'spectral-defect.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(page.getByTestId('text-source-name')).toHaveText('spectral-defect.wav');
  // The default chain starts in a mixed state; enable all first, then bypass all.
  const allModules = page.getByTestId('toggle-all-modules-sidebar');
  await allModules.check();
  await allModules.uncheck();
  await page.getByTestId('button-add-module').click();
  await page.getByTestId('menu-module-spectral-repair').click();
  await drawOnSpectrogram(page, .35, .65, .25, .4);
  await page.getByTestId('button-add-spectral-repair').click();
  const card = page.getByRole('dialog', { name: 'Edit Short Sound Repair' })
    .locator('[data-testid^="card-module-spectral-repair"]');
  const id = (await card.getAttribute('data-testid'))!.replace('card-module-', '');
  for (const [key, value] of [['start', '0.8'], ['end', '1.2'], ['low', '900'], ['high', '1150']] as const) {
    const input = card.getByTestId(`input-spectral-${key}-${id}`);
    await input.fill(value);
    await input.blur();
    await expect(input).toHaveValue(value);
  }
  await page.getByTestId('button-close-chain').click();

  const exportWav = async () => {
    await page.getByTestId('nav-export').click();
    const downloadPromise = page.waitForEvent('download', { predicate: (download) => download.suggestedFilename().endsWith('.wav') });
    await page.getByTestId('button-confirm-export').click();
    return readFile(await (await downloadPromise).path());
  };
  const edited = await exportWav();
  await page.getByTestId(`button-open-module-${id}`).click();
  await page.getByTestId(`button-bypass-${id}`).click();
  await page.getByTestId('button-close-chain').click();
  const bypassed = await exportWav();
  const level = (bytes: Buffer) => {
    expect(bytes.readUInt16LE(20)).toBe(3); // 32-bit float WAV
    let real = 0;
    let imaginary = 0;
    const first = Math.floor(.95 * rate);
    const last = Math.floor(1.05 * rate);
    for (let i = first; i < last; i++) {
      const sample = bytes.readFloatLE(44 + i * 8);
      const phase = 2 * Math.PI * 1000 * i / rate;
      real += sample * Math.cos(phase);
      imaginary -= sample * Math.sin(phase);
    }
    return 2 * Math.hypot(real, imaginary) / (last - first);
  };
  expect(level(bypassed)).toBeGreaterThan(.15);
  expect(level(edited)).toBeLessThan(level(bypassed) * .8);
});