import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(packageRoot, 'public');
const htmlPath = path.join(publicRoot, 'operator-manual.html');
const pdfPath = path.join(publicRoot, 'Field-Restore-Operators-Manual.pdf');

const windGuidanceChecks = [
  ['Reduction effect', /\breduction sets how much low-frequency signal is removed while wind is detected[.;]\s*higher values remove more\b/],
  ['Crossover frequency effect', /\bcrossover frequency sets the upper edge of the affected low-frequency range[.;]\s*raising it covers a wider range\b/],
  ['Smoothing effect', /\bsmoothing controls how quickly reduction changes[.;]\s*higher values make it ramp more slowly as detection starts and stops\b/],
  ['default Reduction', /\b72\s*%\s*reduction\b/],
  ['default Crossover frequency', /\b140\s*hz\s*crossover frequency\b/],
  ['default Smoothing', /\b50\s*%\s*smoothing\b/],
  ['wanted-bass caution', /\bwanted bass\b/],
  ['low-call caution', /\blow calls?\b/],
  ['missed and false wind detection limits', /\bit can miss wind or react to other low-frequency sounds\b/],
  ['severe microphone overload limit', /\bit cannot repair severe microphone overload\b/],
  ['automatic Wind Removal behavior', /\bwind removal is automatic and varies with detection\b/],
  ['fixed Low Rumble Removal behavior', /\blow rumble removal is a fixed high-pass filter that acts throughout the recording\b/],
];

function normalizeText(text) {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractHtmlWindGuidance() {
  assert.ok(existsSync(htmlPath), `Online operator guide is missing: ${htmlPath}`);
  const html = readFileSync(htmlPath, 'utf8');
  const match = html.match(/<div class="wind-guidance">([\s\S]*?)<\/div>/i);
  assert.ok(match, 'Online operator guide is missing its Wind Removal controls section.');
  return normalizeText(match[1]);
}

function extractPdfWindGuidance() {
  assert.ok(existsSync(pdfPath), `Downloadable operator manual PDF is missing: ${pdfPath}`);
  assert.ok(statSync(pdfPath).size > 0, `Downloadable operator manual PDF is empty: ${pdfPath}`);

  let pdfText;
  try {
    pdfText = execFileSync('pdftotext', ['-layout', pdfPath, '-'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error.code === 'ENOENT'
      ? 'pdftotext was not found; install Poppler so the manual can be checked.'
      : `pdftotext could not read the PDF: ${error.stderr?.toString().trim() || error.message}`;
    assert.fail(`Cannot verify the downloadable operator manual: ${detail}`);
  }

  const normalized = normalizeText(pdfText);
  const sectionStart = normalized.indexOf('wind removal controls');
  assert.notEqual(sectionStart, -1, 'Downloadable operator manual is missing its Wind Removal controls section.');
  const sectionEnd = normalized.indexOf('processing settings are linked', sectionStart);
  assert.notEqual(sectionEnd, -1, 'Downloadable operator manual is missing the end of its Wind Removal controls section.');
  return normalized.slice(sectionStart, sectionEnd);
}

function assertHasCurrentWindGuidance(manualName, text) {
  const missing = windGuidanceChecks
    .filter(([, pattern]) => !pattern.test(text))
    .map(([description]) => description);
  assert.deepEqual(
    missing,
    [],
    `${manualName} has missing or stale Wind Removal guidance: ${missing.join(', ')}.`,
  );
}

test('online operator guide explains current Wind Removal controls and cautions', () => {
  assertHasCurrentWindGuidance('Online operator guide', extractHtmlWindGuidance());
});

test('downloadable operator PDF exists and explains current Wind Removal controls and cautions', () => {
  assertHasCurrentWindGuidance('Downloadable operator manual PDF', extractPdfWindGuidance());
});
