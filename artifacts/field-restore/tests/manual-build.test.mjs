import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildManual, manualSource } from '../scripts/build-manual.mjs';

const textOf = file => execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });

test('manual PDF uses the current guide and its print styles', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'field-restore-manual-'));
  try {
    const outputPath = path.join(directory, 'manual.pdf');
    await buildManual({ outputPath });
    const text = textOf(outputPath).replace(/\s+/g, ' ');
    const html = await readFile(manualSource, 'utf8');
    const headings = [...html.matchAll(/<h[23][^>]*>([^<]+)<\/h[23]>/g)];
    assert.ok(headings.length > 10, 'Check all guide sections, not an empty document.');
    for (const [, heading] of headings) {
      assert.ok(text.includes(heading), `PDF is missing heading: ${heading}`);
    }
    assert.ok(!text.includes('Download PDF'), 'Print styling should hide web-only actions.');
    assert.ok(!text.includes('file:///'), 'Browser path headers must not appear in the PDF.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source edits reach regenerated PDFs and failures preserve the previous download', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'field-restore-manual-'));
  try {
    const sourcePath = path.join(directory, 'source.html');
    const outputPath = path.join(directory, 'manual.pdf');
    for (const revision of ['First manual revision', 'Updated manual revision']) {
      await writeFile(sourcePath, `<!doctype html><title>Manual</title><h1>${revision}</h1>`);
      await buildManual({ sourcePath, outputPath });
      assert.ok(textOf(outputPath).includes(revision));
    }
    const previous = await readFile(outputPath);
    await assert.rejects(buildManual({
      sourcePath, outputPath, executablePath: path.join(directory, 'missing-browser'),
    }));
    assert.deepEqual(await readFile(outputPath), previous);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
