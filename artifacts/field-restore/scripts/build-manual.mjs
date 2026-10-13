import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
export const manualSource = path.join(publicRoot, 'operator-manual.html');
export const manualOutput = path.join(publicRoot, 'Field-Restore-Operators-Manual.pdf');

export async function buildManual({
  sourcePath = manualSource,
  outputPath = manualOutput,
  executablePath = process.env.CHROMIUM_PATH,
} = {}) {
  // Replit provides Chromium; elsewhere use Playwright's installed browser.
  executablePath ??= existsSync('/repl/tools/bin/chromium')
    ? '/repl/tools/bin/chromium'
    : undefined;
  let browser;
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    browser = await chromium.launch({ executablePath });
    const page = await browser.newPage();
    await page.goto(pathToFileURL(sourcePath).href, { waitUntil: 'networkidle' });
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      tagged: true,
    });
    if (pdf.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('Chromium did not produce a PDF.');
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(temporaryPath, pdf);
    await rename(temporaryPath, outputPath);
    console.info(`Operator manual: ${sourcePath} → ${outputPath} (${pdf.length} bytes)`);
  } finally {
    await browser?.close();
    await rm(temporaryPath, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildManual();
  } catch (error) {
    console.error('Manual build failed. Install Chromium with pnpm exec playwright install chromium,'
      + ' or set CHROMIUM_PATH to a compatible browser executable.');
    console.error(error);
    process.exitCode = 1;
  }
}
