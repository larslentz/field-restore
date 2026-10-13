// Run from the workspace root. Only operates on an isolated browser demo session.
const { chromium } = require('../../../node_modules/.pnpm/node_modules/playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const output = path.resolve(__dirname, '../public/images');

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/repl/tools/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await page.goto('http://localhost:80/', { waitUntil: 'networkidle' });
    await page.getByTestId('canvas-spectrogram').waitFor();
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${output}/workspace.png` });
    await page.getByTestId('nav-analyze').click();
    await page.locator('.panel').filter({ hasText: 'Original vs Current comparison' }).screenshot({ path: `${output}/comparison.png` });
    await page.getByTestId('nav-edit').click();
    // File dragenter invokes the real import overlay without importing a file.
    await page.evaluate(() => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([''], 'recording.wav', { type: 'audio/wav' }));
      document.querySelector('.app-shell').dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }));
    });
    await page.locator('.wav-drop-card').screenshot({ path: `${output}/import.png` });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    const plot = await page.getByTestId('canvas-spectrogram').boundingBox();
    await page.mouse.move(plot.x + plot.width * .25, plot.y + plot.height * .45);
    await page.mouse.down();
    await page.mouse.move(plot.x + plot.width * .52, plot.y + plot.height * .45, { steps: 12 });
    await page.mouse.up();
    await page.locator('.instrument-grid').screenshot({ path: `${output}/selection.png` });
    await page.locator('.sidebar-chain').screenshot({ path: `${output}/chain.png` });
    await page.locator('.sidebar-chain-select').filter({ hasText: 'Wind Removal' }).click();
    await page.locator('.chain-drawer').getByRole('button', { name: 'Enable Wind Removal', exact: true }).click();
    await page.locator('.chain-drawer').screenshot({ path: `${output}/wind.png` });
    await page.keyboard.press('Escape');
    await page.getByTestId('button-add-module').click();
    await page.locator('.sidebar-module-menu').getByRole('button', { name: 'Short Sound Repair', exact: true }).click();
    const repairPlot = await page.getByTestId('canvas-spectrogram').boundingBox();
    await page.mouse.move(repairPlot.x + repairPlot.width * .3, repairPlot.y + repairPlot.height * .2);
    await page.mouse.down();
    await page.mouse.move(repairPlot.x + repairPlot.width * .48, repairPlot.y + repairPlot.height * .35, { steps: 10 });
    await page.mouse.up();
    await page.locator('.instrument-grid').screenshot({ path: `${output}/repair.png` });
    await page.getByTestId('nav-analyze').click();
    await page.waitForTimeout(1000);
    console.log((await page.locator('.panel').allTextContents()).map(t => t.slice(0, 120)));
    const stats = page.locator('.panel').filter({ hasText: 'Signal statistics' }).last();
    await stats.screenshot({ path: `${output}/statistics.png` });
    await page.getByTestId('nav-project').click();
    await page.locator('.main-content').screenshot({ path: `${output}/project.png` });
    await page.getByTestId('button-export').click();
    await page.locator('.modal-card').screenshot({ path: `${output}/export.png` });
    for (const file of (await fs.readdir(output)).filter(file => file.endsWith('.png'))) {
      execFileSync('magick', [path.join(output, file), '-quality', '92', path.join(output, file.replace(/\.png$/, '.jpg'))]);
    }
    execFileSync('magick', [`${output}/wind.png`, '-crop', '900x580+30+350', '+repage', '-quality', '95', `${output}/wind.jpg`]);
    execFileSync('magick', [`${output}/project.png`, '-crop', '2400x860+20+3070', '+repage', '-quality', '94', `${output}/project.jpg`]);
    console.log('Captured genuine product imagery in', output);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
