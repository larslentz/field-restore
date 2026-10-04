import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { generateFloat32WavHeader } from './large-wav.ts';
const { NativeSaves } = createRequire(import.meta.url)('../../desktop/native-save.cjs');
async function temporary(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'field-restore-native-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('native saves commit chunks atomically and protect the original', () => temporary(async dir => {
  const saves = new NativeSaves();
  const original = path.join(dir, 'original.wav');
  const destination = path.join(dir, 'output.wav');
  const id = await saves.create(original);
  await saves.write(id, new Uint8Array([1, 2, 3]).buffer);
  await saves.close(id);
  await saves.protect(original);
  await assert.rejects(saves.create(original), /original recording/);
  const output = await saves.create(destination);
  await saves.write(output, new Uint8Array([4, 5]).buffer);
  await saves.write(output, new Uint8Array([6, 7]).buffer);
  await assert.rejects(stat(destination), /ENOENT/);
  await saves.close(output);
  assert.deepEqual([...await readFile(destination)], [4, 5, 6, 7]);
  assert.deepEqual([...await readFile(original)], [1, 2, 3]);
  assert.equal(saves.jobs.size, 0);
}));
test('native cancellation removes partial output and does not damage an existing destination', () => temporary(async dir => {
  const saves = new NativeSaves();
  const destination = path.join(dir, 'output.txt');
  const first = await saves.create(destination);
  await saves.write(first, new Uint8Array([42]).buffer);
  await saves.close(first);
  const next = await saves.create(destination);
  await saves.write(next, new Uint8Array([99]).buffer);
  await saves.abort(next);
  assert.deepEqual([...await readFile(destination)], [42]);
  assert.deepEqual(await readdir(dir), ['output.txt']);
  await assert.rejects(saves.write(next, new Uint8Array([1]).buffer), /Invalid/);
  const invalid = await saves.create(path.join(dir, 'invalid.wav'));
  await assert.rejects(saves.write(invalid, new ArrayBuffer(8 * 1024 * 1024 + 1)), /Invalid save chunk/);
  await saves.abort(invalid);
}));
test('native sequential RF64 output crosses 4 GiB without whole-file allocation', {
  skip: process.env.NATIVE_LARGE_SAVE !== '1',
}, () => temporary(async dir => {
  const saves = new NativeSaves();
  const destination = path.join(dir, 'boundary.wav');
  const bytes = 0x1_0000_0000 + 8 * 1024 * 1024;
  const frames = bytes / 8;
  const header = generateFloat32WavHeader({ channels: 2, sampleRate: 48000, frameCount: frames });
  const id = await saves.create(destination);
  await saves.write(id, header.buffer);
  const chunk = new ArrayBuffer(8 * 1024 * 1024);
  for (let offset = 0; offset < bytes; offset += chunk.byteLength) {
    new DataView(chunk).setFloat32(0, offset === 0x1_0000_0000 ? .5 : .25, true);
    await saves.write(id, chunk);
  }
  await saves.close(id);
  assert.equal((await stat(destination)).size, header.byteLength + bytes);
  const handle = await open(destination, 'r');
  try {
    const sample = Buffer.alloc(4);
    await handle.read(sample, 0, 4, header.byteLength + 0x1_0000_0000);
    assert.equal(sample.readFloatLE(0), .5);
  } finally { await handle.close(); }
}));