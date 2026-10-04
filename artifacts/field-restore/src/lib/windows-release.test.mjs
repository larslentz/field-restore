import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWindowsRelease } from './windows-release.ts';

const release = {
  filename: 'Field-Restore-1.0.0-Windows-x64-Setup.exe',
  version: '1.0.0',
  sha256: 'AB'.repeat(32),
  unsigned: true,
  nativeWindowsTested: false,
};

test('existing unsigned releases remain downloadable without a publisher claim', () => {
  assert.deepEqual(parseWindowsRelease({ ...release, publisher: 'Not verified' }), {
    ...release, sha256: release.sha256.toLowerCase(), publisher: null,
  });
});

test('signed metadata preserves the expected publisher and independent Windows test status', () => {
  assert.deepEqual(parseWindowsRelease({
    ...release, unsigned: false, publisher: ' Example Publisher ', nativeWindowsTested: true,
  }), {
    ...release, unsigned: false, publisher: 'Example Publisher',
    sha256: release.sha256.toLowerCase(), nativeWindowsTested: true,
  });
});

test('signed releases without usable publisher metadata do not silently lose the download', () => {
  for (const publisher of [undefined, null, '', ' ', 12, 'x'.repeat(201), 'Name\nSpoof']) {
    const parsed = parseWindowsRelease({ ...release, unsigned: false, publisher });
    assert.ok(parsed);
    assert.equal(parsed.publisher, null);
    assert.equal(parsed.unsigned, false);
  }
});

test('signing status and Windows test status are not inferred from truthy values', () => {
  for (const unsigned of [undefined, null, 'false', 0, 1]) {
    assert.equal(parseWindowsRelease({ ...release, unsigned }), null);
  }
  for (const nativeWindowsTested of [undefined, 'true', 1]) {
    assert.equal(parseWindowsRelease({ ...release, nativeWindowsTested }).nativeWindowsTested, false);
  }
});

test('both release types reject unsafe filenames, invalid hashes and invalid versions', () => {
  for (const unsigned of [true, false]) {
    for (const filename of ['../setup.exe', 'setup..exe', '/setup.exe', 'https://example.com/setup.exe', 'setup.exe?x', 'setup.zip']) {
      assert.equal(parseWindowsRelease({ ...release, unsigned, filename }), null);
    }
    for (const sha256 of ['', 'a'.repeat(63), 'g'.repeat(64), 42]) {
      assert.equal(parseWindowsRelease({ ...release, unsigned, sha256 }), null);
    }
    for (const version of ['', ' ', 'x'.repeat(41), null]) {
      assert.equal(parseWindowsRelease({ ...release, unsigned, version }), null);
    }
  }
  for (const value of [null, [], 'release', 42]) assert.equal(parseWindowsRelease(value), null);
});