import { expect, test } from '@playwright/test';
import { open, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';

// This is deliberately not part of ordinary e2e runs: Chromium must write >4 GiB.
// Run with RF64_BROWSER_DOWNLOAD=1 pnpm exec playwright test tests/rf64-browser-download.spec.ts --browser chromium
test('picker-free browser download saves every byte of an RF64 WAV beyond 4 GiB', async ({ page }) => {
  test.skip(process.env.RF64_BROWSER_DOWNLOAD !== '1', 'Opt in to the >4 GiB disk-writing test with RF64_BROWSER_DOWNLOAD=1.');
  test.setTimeout(20 * 60_000);

  const dataBytes = 0x1_0000_0000 + 8 * 1024 * 1024;
  const headerBytes = 80;
  const frames = dataBytes / 8; // stereo float32
  const expectedBytes = headerBytes + dataBytes;
  const disk = await statfs(tmpdir());
  test.skip(disk.bavail * disk.bsize < expectedBytes * 2, 'At least 8 GiB of free temporary disk space is required.');

  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
  });
  await page.goto('/');

  // The real page destination and service-worker fetch path are used; only the
  // audio source is synthetic, so neither the app nor the test allocates 4 GiB.
  const downloadPromise = page.waitForEvent('download', {
    predicate: (download) => download.suggestedFilename() === 'rf64-boundary.wav',
    timeout: 60_000,
  });
  const writing = page.evaluate(async ({ frames, dataBytes }) => {
    const { createBrowserWavDownload } = await import('/src/lib/browser-wav-download.ts');
    const { generateFloat32WavHeader } = await import('/src/lib/large-wav.ts');
    const controller = new AbortController();
    const destination = await createBrowserWavDownload('rf64-boundary.wav', controller.signal, () => controller.abort());
    try {
      const header = generateFloat32WavHeader({ channels: 2, sampleRate: 48_000, frameCount: frames });
      await destination.write(header.buffer);
      const chunkBytes = 8 * 1024 * 1024;
      for (let offset = 0; offset < dataBytes; offset += chunkBytes) {
        const chunk = new ArrayBuffer(Math.min(chunkBytes, dataBytes - offset));
        const view = new DataView(chunk);
        // Valid float samples at the start, beyond the 4 GiB boundary and at EOF.
        if (offset === 0) view.setFloat32(0, 0.25, true);
        if (offset === 0x1_0000_0000) view.setFloat32(0, 0.5, true);
        if (offset + chunk.byteLength === dataBytes) view.setFloat32(chunk.byteLength - 4, -0.25, true);
        await destination.write(chunk);
      }
      await destination.close();
    } catch (error) {
      await destination.abort();
      throw error;
    }
  }, { frames, dataBytes });

  const download = await downloadPromise;
  await writing;
  expect(await download.failure()).toBeNull();
  const downloaded = await download.path(); // waits for Chromium to finish writing
  const file = await open(downloaded, 'r');
  try {
    const size = (await stat(downloaded)).size;
    expect(size).toBe(expectedBytes);
    const readAt = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      expect(bytesRead).toBe(length);
      return buffer;
    };
    const header = await readAt(0, headerBytes);
    expect(header.toString('ascii', 0, 4)).toBe('RF64');
    expect(header.readUInt32LE(4)).toBe(0xffffffff);
    expect(header.toString('ascii', 8, 12)).toBe('WAVE');
    expect(header.toString('ascii', 12, 16)).toBe('ds64');
    expect(header.readUInt32LE(16)).toBe(28);
    expect(header.readBigUInt64LE(20)).toBe(BigInt(expectedBytes - 8));
    expect(header.readBigUInt64LE(28)).toBe(BigInt(dataBytes));
    expect(header.readBigUInt64LE(36)).toBe(BigInt(frames));
    expect(header.toString('ascii', 48, 52)).toBe('fmt ');
    expect(header.readUInt16LE(56)).toBe(3); // IEEE float
    expect(header.readUInt16LE(58)).toBe(2);
    expect(header.readUInt32LE(60)).toBe(48_000);
    expect(header.readUInt16LE(70)).toBe(32);
    expect(header.toString('ascii', 72, 76)).toBe('data');
    expect(header.readUInt32LE(76)).toBe(0xffffffff);
    expect((await readAt(headerBytes, 4)).readFloatLE(0)).toBe(0.25);
    expect((await readAt(headerBytes + 0x1_0000_0000, 4)).readFloatLE(0)).toBe(0.5);
    expect((await readAt(size - 4, 4)).readFloatLE(0)).toBe(-0.25);
  } finally {
    await file.close();
  }
});