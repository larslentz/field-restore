import { expect, test, type Page } from '@playwright/test';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

function shortWav() {
  const sampleRate = 8_000;
  const frames = sampleRate * 16;
  const wav = Buffer.alloc(44 + frames * 4);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(frames * 4, 40);
  return wav;
}

async function playheadSeconds(page: Page) {
  const text = await page.getByTestId('text-playhead').textContent();
  const match = text?.match(/^(\d+):(\d+\.\d+)/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
}

test('clicking a new playhead overrides an old selection for Play and Space, but a new drag still plays its range', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('input-import-wav').setInputFiles({ name: 'seek-check.wav', mimeType: 'audio/wav', buffer: shortWav() });
  await expect(page.getByTestId('text-source-name')).toHaveText('seek-check.wav');
  await expect(page.getByTestId('text-selection-time')).toHaveText('No selection · full track');
  await page.getByTestId('select-monitor').selectOption('original');

  const canvas = page.getByTestId('canvas-spectrogram');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const x = (fraction: number) => 48 + (box.width - 120) * fraction;
  const y = box.height / 4;
  await page.mouse.move(box.x + x(.2), box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x(.35), box.y + y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('text-selection-time')).toContainText('selected');
  await canvas.click({ position: { x: x(.65), y } });
  await expect(page.getByTestId('text-selection-time')).toHaveText('No selection · full track');
  await expect.poll(() => playheadSeconds(page)).toBeGreaterThan(10);
  await page.getByTestId('button-play').click();
  await expect(page.getByTestId('button-play')).toHaveAttribute('aria-label', 'Pause playback');
  await expect.poll(() => playheadSeconds(page)).toBeGreaterThan(10);
  await page.getByTestId('button-play').click();

  await canvas.click({ position: { x: x(.38), y } });
  await expect.poll(() => playheadSeconds(page)).toBeGreaterThan(5.8);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('button-play')).toHaveAttribute('aria-label', 'Pause playback');
  await expect.poll(() => playheadSeconds(page)).toBeGreaterThan(5.8);
  await canvas.click({ position: { x: x(.75), y } });
  await expect.poll(() => playheadSeconds(page)).toBeGreaterThan(11.5);
  await page.getByTestId('button-play').click();

  await page.mouse.move(box.x + x(.2), box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x(.35), box.y + y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('text-selection-time')).toContainText('selected');
  await page.getByTestId('button-loop').click();
  await page.getByTestId('button-play').click();
  await expect.poll(() => playheadSeconds(page)).toBeGreaterThan(3);
  await expect.poll(() => playheadSeconds(page)).toBeLessThan(5.8);
  await page.getByTestId('button-stop').click();
});

test('a file-backed recording starts unselected and plays from the chosen playhead', async ({ page }) => {
  const fixtureDir = path.join(import.meta.dirname, '.fixtures');
  const fixture = path.join(fixtureDir, 'playhead-file-backed.wav');
  const frames = 64 * 1024 * 1024 / 2 + 8_000;
  const sampleRate = 192_000;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(frames * 2 + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(frames * 2, 40);
  await mkdir(fixtureDir, { recursive: true });
  const file = await open(fixture, 'w');
  try {
    await file.write(header, 0, header.length, 0);
    await file.truncate(header.length + frames * 2);
  } finally {
    await file.close();
  }

  await page.goto('/');
  await page.getByTestId('input-import-wav').setInputFiles(fixture);
  await expect(page.getByTestId('text-source-name')).toHaveText('playhead-file-backed.wav');
  await expect(page.getByTestId('text-selection-time')).toHaveText('No selection · full track');
  await page.getByTestId('select-monitor').selectOption('original');
  const canvas = page.getByTestId('canvas-spectrogram');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: 48 + (box.width - 120) * .5, y: box.height / 4 } });
  await expect(page.getByTestId('text-selection-time')).toHaveText('No selection · full track');
  await expect.poll(() => playheadSeconds(page)).toBeGreaterThan(70);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('button-play')).toHaveAttribute('aria-label', 'Pause playback');
  await expect.poll(() => playheadSeconds(page)).toBeGreaterThan(70);
  await page.getByTestId('button-stop').click();
});