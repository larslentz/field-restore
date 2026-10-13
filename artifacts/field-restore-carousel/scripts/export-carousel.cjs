const { chromium } = require('../../../node_modules/.pnpm/node_modules/playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const yaml = require('../node_modules/yaml');
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, '../../generated-artifacts/field-restore-carousel');

(async () => {
  const manifest = JSON.parse(await fs.readFile(`${root}/src/data/slides-manifest.json`, 'utf8'));
  const approved = JSON.parse(await fs.readFile(`${root}/src/data/approved-copy.json`, 'utf8'));
  if (manifest.length !== 10) throw new Error('Expected exactly ten carousel slides.');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/repl/tools/bin/chromium', headless: true, args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    const files = [];
    for (const slide of manifest.sort((a, b) => a.position - b.position)) {
      const document = yaml.parse(await fs.readFile(path.join(root, slide.filepath), 'utf8'));
      if (document.size.width !== 1080 || document.size.height !== 1350) throw new Error('Unexpected canvas size.');
      const content = document.elements.filter(e => ['headline', 'body', 'subtitle', 'cta'].includes(e.id))
        .flatMap(e => e.body.paragraphs.map(p => p.runs.map(r => r.text).join('')));
      const expected = approved[slide.position - 1];
      const expectedLines = [expected.headline, ...expected.body.map(line => line.replace(/^- /, ''))];
      if (JSON.stringify(content) !== JSON.stringify(expectedLines)) throw new Error(`Approved copy differs on slide ${slide.position}.`);
      await page.goto(`http://localhost:80/field-restore-carousel/slide${slide.position}?replitNav=parent`, { waitUntil: 'networkidle' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(image => image.decode()));
      });
      const visibleText = await page.locator('body').innerText();
      for (const line of expectedLines) {
        if (!visibleText.includes(line)) throw new Error(`Missing rendered text on slide ${slide.position}: ${line}`);
      }
      if (failures.length) throw new Error(failures.join('\n'));
      const filename = `Field-Restore-${String(slide.position).padStart(2, '0')}.png`;
      await page.screenshot({ path: path.join(output, filename), animations: 'disabled' });
      files.push(filename);
      console.log('Exported', filename);
    }
    await page.goto('http://localhost:80/field-restore-carousel/allslides', { waitUntil: 'networkidle' });
    const wrappers = await page.locator('.slide[data-slide-id]').evaluateAll(elements => elements.map(e => ({
      width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height,
    })));
    if (wrappers.length !== 10 || wrappers.some(s => s.width !== 1080 || s.height !== 1350)) {
      throw new Error('Portrait export wrapper verification failed.');
    }
    execFileSync('zip', ['-j', path.join(output, 'Field-Restore-Social-Carousel.zip'), ...files.map(f => path.join(output, f))]);
    console.log('Verified ten portrait export wrappers and created the ZIP.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
