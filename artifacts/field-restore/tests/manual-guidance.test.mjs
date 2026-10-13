import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeModule } from '../src/lib/edit-chain.ts';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(packageRoot, 'public');
const htmlPath = path.join(publicRoot, 'operator-manual.html');
const pdfPath = path.join(publicRoot, 'Field-Restore-Operators-Manual.pdf');
// Use the same new-module configuration that populates the app controls, not
// another copy of the numbers printed in the manuals.
const windDefaults = makeModule('wind').params;
const windDefaultControls = [
  { key: 'reduction', label: 'Reduction', unit: '%', pattern: /(\d+(?:\.\d+)?)\s*%\s*reduction\b/ },
  { key: 'crossoverHz', label: 'Crossover frequency', unit: ' Hz', pattern: /(\d+(?:\.\d+)?)\s*hz\s*crossover frequency\b/ },
  { key: 'smoothing', label: 'Smoothing', unit: '%', pattern: /(\d+(?:\.\d+)?)\s*%\s*smoothing\b/ },
];

const windGuidanceChecks = [
  ['Reduction effect', /\breduction sets how much low-frequency signal is removed while wind is detected[.;]\s*higher values remove more\b/],
  ['Crossover frequency effect', /\bcrossover frequency sets the upper edge of the affected low-frequency range[.;]\s*raising it covers a wider range\b/],
  ['Smoothing effect', /\bsmoothing controls how quickly reduction changes[.;]\s*higher values make it ramp more slowly as detection starts and stops\b/],
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

function assertHasCurrentWindDefaults(manualName, text, defaults = windDefaults) {
  // Restrict matching to the defaults sentence so a value mentioned elsewhere
  // (for example as an adjustment suggestion) cannot mask a stale default.
  const documentedDefaults = text.match(/\bstart with the defaults\b([^.]*(?:\.\d+[^.]*)*)/)?.[1] ?? '';
  const mismatches = windDefaultControls.flatMap(({ key, label, unit, pattern }) => {
    const expected = defaults[key];
    assert.ok(Number.isFinite(expected), `App Wind Removal ${label} default must be a finite number.`);
    const match = documentedDefaults.match(pattern);
    if (match && Number(match[1]) === expected) return [];
    const documented = match ? `${match[1]}${unit}` : 'missing';
    return [`${label}: documented ${documented}; app default ${expected}${unit}`];
  });
  assert.equal(
    mismatches.length,
    0,
    `${manualName} has stale Wind Removal defaults:\n${mismatches.join('\n')}`,
  );
}

test('online operator guide explains current Wind Removal controls and cautions', () => {
  assertHasCurrentWindGuidance('Online operator guide', extractHtmlWindGuidance());
});

test('downloadable operator PDF exists and explains current Wind Removal controls and cautions', () => {
  assertHasCurrentWindGuidance('Downloadable operator manual PDF', extractPdfWindGuidance());
});

test('online operator guide defaults match the app Wind Removal configuration', () => {
  assertHasCurrentWindDefaults('Online operator guide', extractHtmlWindGuidance());
});

test('downloadable operator PDF defaults match the app Wind Removal configuration', () => {
  assertHasCurrentWindDefaults('Downloadable operator manual PDF', extractPdfWindGuidance());
});

for (const { key, label, unit } of windDefaultControls) {
  test(`manual default drift reports the mismatched ${label} control`, () => {
    const text = normalizeText(`Start with the defaults—${windDefaults.reduction}% Reduction,
      ${windDefaults.crossoverHz} Hz Crossover frequency, and ${windDefaults.smoothing}% Smoothing.`);
    const changedDefaults = { ...windDefaults, [key]: Number(windDefaults[key]) + 1 };
    assert.throws(() => assertHasCurrentWindDefaults('Test manual', text, changedDefaults), error => {
      assert.ok(error.message.includes(
        `${label}: documented ${windDefaults[key]}${unit}; app default ${changedDefaults[key]}${unit}`,
      ), error.message);
      for (const other of windDefaultControls.filter(control => control.key !== key)) {
        assert.ok(!error.message.includes(`${other.label}:`), error.message);
      }
      return true;
    });
  });
}

test('manual default drift reports every missing control despite values elsewhere', () => {
  const text = normalizeText(`Start with the defaults—listen before adjusting.
    Try ${windDefaults.reduction}% Reduction, ${windDefaults.crossoverHz} Hz Crossover frequency,
    and ${windDefaults.smoothing}% Smoothing.`);
  assert.throws(() => assertHasCurrentWindDefaults('Test manual', text), error => {
    for (const { key, label, unit } of windDefaultControls) {
      assert.ok(error.message.includes(`${label}: documented missing; app default ${windDefaults[key]}${unit}`), error.message);
    }
    return true;
  });
});
