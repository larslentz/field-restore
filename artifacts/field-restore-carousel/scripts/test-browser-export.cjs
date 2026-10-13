// Run against the managed carousel workflow. Output stays in ignored generated-artifacts.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('../../../node_modules/.pnpm/node_modules/playwright');
const { unzipSync } = require('../node_modules/fflate');

const output = path.resolve(__dirname, '../../../generated-artifacts/carousel-export-check');
const base = process.env.CAROUSEL_TEST_URL || 'http://localhost:80/field-restore-carousel/';

async function downloadDeck(page, name) {
  const event = page.waitForEvent('download', { timeout: 180000 });
  await page.getByRole('button', { name: 'Download all PNGs (ZIP)' }).click();
  const download = await event;
  assert.equal(download.suggestedFilename(), 'Field-Restore-Social-Carousel.zip');
  assert.equal(await download.failure(), null);
  const file = path.join(output, name);
  await download.saveAs(file);
  await page.getByRole('status').filter({ hasText: 'ZIP sent to your browser' }).waitFor();
  const images = unzipSync(new Uint8Array(await fs.readFile(file)));
  assert.deepEqual(Object.keys(images).sort(), Array.from({ length: 10 }, (_, i) =>
    `Field-Restore-${String(i + 1).padStart(2, '0')}.png`));
  for (const image of Object.values(images)) {
    const bytes = Buffer.from(image);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), 1080);
    assert.equal(bytes.readUInt32BE(20), 1350);
  }
  assert.equal(await page.locator('iframe[title="Carousel export renderer"]').count(), 0);
  return images;
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/repl/tools/bin/chromium', headless: true, args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const initial = await downloadDeck(page, 'initial.zip');

    // Simulate the latest saved SDM module differing, without changing approved
    // copy or any files in the deck. The new export iframe must request it again.
    const documentRoute = '**/src/data/slides/slide1.sdm.yaml*';
    await page.route(documentRoute, async route => {
      const response = await route.fetch();
      const body = await response.text();
      assert.ok(body.includes('#F5F3EF'));
      await route.fulfill({ response, body: body.replaceAll('#F5F3EF', '#F1C3EF') });
    });
    const edited = await downloadDeck(page, 'edited.zip');
    assert.notDeepEqual(initial['Field-Restore-01.png'], edited['Field-Restore-01.png']);
    // Confirm the simulated edit is visibly in the PNG, not merely metadata.
    const pixel = await page.evaluate(async bytes => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = 1080; canvas.height = 1350;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const color = [...ctx.getImageData(0, 0, 1, 1).data];
      bitmap.close();
      return color;
    }, [...edited['Field-Restore-01.png']]);
    assert.deepEqual(pixel, [241, 195, 239, 255]);
    await page.unroute(documentRoute);

    let unexpectedDownload = false;
    const onDownload = () => { unexpectedDownload = true; };
    page.on('download', onDownload);
    const assetRoute = '**/images/workspace.jpg*';
    await page.route(assetRoute, route => route.fulfill({ status: 404, body: 'Missing test image' }));
    await page.getByRole('button', { name: 'Download all PNGs (ZIP)' }).click();
    await page.getByRole('alert').filter({ hasText: 'Download failed.' }).waitFor({ timeout: 90000 });
    assert.match(await page.getByRole('alert').innerText(), /404.*workspace\.jpg/);
    assert.equal(unexpectedDownload, false, 'A failed export must not return an old/partial ZIP');
    assert.equal(await page.locator('iframe[title="Carousel export renderer"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Download all PNGs (ZIP)' }).isEnabled(), true);
    await page.unroute(assetRoute);
    page.off('download', onDownload);
    const retried = await downloadDeck(page, 'retry.zip');
    assert.deepEqual(retried['Field-Restore-01.png'], initial['Field-Restore-01.png']);
    assert.deepEqual(errors, []);
    console.log('Passed: ten native portrait PNGs; fresh saved edits; missing-asset error without a download; successful retry; renderer cleanup.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
