import { expect, test } from '@playwright/test';

test('switching to Original while an edited render is pending never starts the queued edited playback', async ({ page }) => {
  await page.addInitScript(() => {
    const starts: number[] = [];
    (window as typeof window & { __audioStarts: number[] }).__audioStarts = starts;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      starts.push(this.buffer!.getChannelData(0)[1000]);
      return start.apply(this, args);
    };
  });
  await page.goto('/');

  const sampleRate = 48000;
  const seconds = 10;
  const frames = sampleRate * seconds;
  const period = new Float32Array(sampleRate * 2);
  for (let frame = 0; frame < sampleRate; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      let value = channel ? .012 : -.012;
      for (let tone = 1; tone <= 350; tone++)
        value += .0015 * Math.sin(2 * Math.PI * 40 * tone * frame / sampleRate + channel * .23);
      period[frame * 2 + channel] = value;
    }
  }
  const bytes = Buffer.alloc(44 + frames * 8);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 8, 28);
  bytes.writeUInt16LE(8, 32); bytes.writeUInt16LE(32, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 8, 40);
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < 2; channel++)
      bytes.writeFloatLE(period[(frame % sampleRate) * 2 + channel], 44 + frame * 8 + channel * 4);

  await page.getByTestId('input-import-wav').setInputFiles({ name: 'dense.wav', mimeType: 'audio/wav', buffer: bytes });
  await expect(page.getByTestId('memory-render-status')).toContainText('Preparing edited audio');
  await page.getByTestId('button-play').click();
  await page.getByTestId('select-monitor').selectOption('original');
  await page.getByTestId('button-play').click();
  await expect(page.getByTestId('button-play')).toHaveAttribute('aria-label', 'Pause playback');
  await expect(page.getByTestId('memory-render-status')).toHaveCount(0);
  await page.waitForTimeout(250);
  const starts = await page.evaluate(() => (window as typeof window & { __audioStarts: number[] }).__audioStarts);
  expect(starts).toHaveLength(1);
  expect(starts[0]).toBeCloseTo(period[1000 * 2], 6);
});