import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprintWav, generateFloat32WavHeader, parseWavMetadata } from './large-wav.ts';
import { isVerifiedRelink, openVerifiedFileHandle } from './file-access.ts';

function wavFile(name = 'source.wav') {
  const header = generateFloat32WavHeader({ channels: 1, sampleRate: 48000, frameCount: 1 });
  const sample = new ArrayBuffer(4);
  const blob = new Blob([header, sample], { type: 'audio/wav' });
  return Object.assign(blob, { name, lastModified: 1 });
}

test('does not read a saved file handle when permission was denied', async () => {
  let read = false;
  const handle = {
    queryPermission: async () => 'denied',
    getFile: async () => { read = true; return wavFile(); },
  };
  assert.equal(await openVerifiedFileHandle(handle, 'expected'), null);
  assert.equal(read, false);
});

test('does not read a saved file handle after previously granted permission is revoked', async () => {
  let permission = 'granted';
  const handle = {
    queryPermission: async () => permission,
    getFile: async () => wavFile(),
  };
  permission = 'denied';
  assert.equal(await openVerifiedFileHandle(handle, 'expected'), null);
});

test('restores only a handle or relink whose content fingerprint is verified', async () => {
  const file = wavFile();
  const metadata = await parseWavMetadata(file);
  const fingerprint = await fingerprintWav(file, metadata);
  const handle = {
    queryPermission: async () => 'granted',
    getFile: async () => file,
  };
  const verified = await openVerifiedFileHandle(handle, fingerprint);
  assert.equal(verified?.fingerprint, fingerprint);
  assert.equal(isVerifiedRelink(fingerprint, verified.fingerprint), true);
  assert.equal(isVerifiedRelink(`${fingerprint}-changed`, verified.fingerprint), false);
});