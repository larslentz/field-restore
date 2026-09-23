import assert from 'node:assert/strict';
import test from 'node:test';
import { generateFloat32WavHeader, parseWavMetadata, readFrames, withLargeExportLeaveWarning, writeFloat32WavChunks } from './large-wav.ts';

const text = (bytes, start, length) => String.fromCharCode(...bytes.slice(start, start + length));

test('generates a compact RIFF float header', () => {
  const header = generateFloat32WavHeader({ channels: 2, sampleRate: 48000, frameCount: 10 });
  assert.equal(header.byteLength, 44);
  assert.equal(text(header, 0, 4), 'RIFF');
  assert.equal(text(header, 8, 4), 'WAVE');
  assert.equal(new DataView(header.buffer).getUint32(40, true), 80);
});

test('generates RF64 headers without allocating the data payload', () => {
  const header = generateFloat32WavHeader({ channels: 2, sampleRate: 48000, frameCount: 0x40000000n });
  assert.equal(header.byteLength, 80);
  assert.equal(text(header, 0, 4), 'RF64');
  assert.equal(text(header, 12, 4), 'ds64');
  assert.equal(new DataView(header.buffer).getBigUint64(28, true), 0x200000000n);
});

test('parses and range-decodes float WAV without reading the whole source', async () => {
  const header = generateFloat32WavHeader({ channels: 2, sampleRate: 48000, frameCount: 3 });
  const samples = new ArrayBuffer(24);
  const view = new DataView(samples);
  [0.25, -0.5, 0.75, -1, 0.125, -0.25].forEach((value, index) => view.setFloat32(index * 4, value, true));
  const blob = new Blob([header, samples]);
  const metadata = await parseWavMetadata(blob, { name: 'range.wav' });
  assert.equal(metadata.frameCount, 3);
  assert.equal(metadata.channels, 2);
  const channels = await readFrames(blob, metadata, 1, 1);
  assert.deepEqual(Array.from(channels[0]), [0.75]);
  assert.deepEqual(Array.from(channels[1]), [-1]);
});

const sparseWav = (header, size) => ({
  size,
  slice(start, end) {
    const length = Math.max(0, end - start);
    const output = new Uint8Array(length);
    if (start < header.byteLength) output.set(header.slice(start, Math.min(end, header.byteLength)));
    return new Blob([output]);
  },
});

test('round-trips RF64 header sizes and chunk placement beyond 4 GiB without a giant fixture', async () => {
  const frames = 0x20000000n;
  const header = generateFloat32WavHeader({ channels: 2, sampleRate: 96000, frameCount: frames });
  const metadata = await parseWavMetadata(sparseWav(header, Number(80n + frames * 8n)), { name: 'hours.rf64.wav' });
  assert.equal(metadata.format, 'RF64');
  assert.equal(metadata.frameCount, Number(frames));
  assert.equal(metadata.dataLengthBigInt, 0x100000000n);
  assert.equal(metadata.dataOffset, 80);
  assert.equal(text(header, 48, 4), 'fmt ');
  assert.equal(text(header, 72, 4), 'data');
});

test('keeps the largest valid RIFF below the boundary and switches immediately above it', () => {
  const maxRiffFrames = (0xffffffffn - 36n) / 8n;
  assert.equal(text(generateFloat32WavHeader({ channels: 2, sampleRate: 48000, frameCount: maxRiffFrames }), 0, 4), 'RIFF');
  assert.equal(text(generateFloat32WavHeader({ channels: 2, sampleRate: 48000, frameCount: maxRiffFrames + 1n }), 0, 4), 'RF64');
});

test('rejects a truncated RF64 data chunk', async () => {
  const header = generateFloat32WavHeader({ channels: 2, sampleRate: 96000, frameCount: 0x20000000n });
  await assert.rejects(parseWavMetadata(new Blob([header])), /truncated or incomplete/);
});

test('aborts and reports an incomplete export when a streamed write fails', async () => {
  let writes = 0;
  let aborted = false;
  let closed = false;
  const stream = {
    async write() {
      writes += 1;
      if (writes === 3) throw new Error('disk removed');
    },
    async close() { closed = true; },
    async abort() { aborted = true; },
  };
  await assert.rejects(writeFloat32WavChunks(stream, {
    channels: 1,
    sampleRate: 2,
    frameCount: 4,
    chunkFrames: 2,
    readFrames: async (_start, count) => [new Float32Array(count)],
  }), /Export incomplete: disk removed/);
  assert.equal(aborted, true);
  assert.equal(closed, false);
});

test('aborts and reports an incomplete export when cancellation interrupts streaming', async () => {
  const controller = new AbortController();
  let aborted = false;
  const stream = {
    async write() { controller.abort(); },
    async close() { assert.fail('cancelled export must not close successfully'); },
    async abort() { aborted = true; },
  };
  await assert.rejects(writeFloat32WavChunks(stream, {
    channels: 1,
    sampleRate: 2,
    frameCount: 2,
    signal: controller.signal,
    readFrames: async () => [new Float32Array(2)],
  }), /Export incomplete: Export was cancelled/);
  assert.equal(aborted, true);
});

function beforeUnloadTarget() {
  let listener;
  return {
    target: {
      addEventListener(type, next) {
        assert.equal(type, 'beforeunload');
        listener = next;
      },
      removeEventListener(type, current) {
        assert.equal(type, 'beforeunload');
        if (listener === current) listener = undefined;
      },
    },
    dispatch() {
      let prevented = false;
      const event = {
        preventDefault() { prevented = true; },
        returnValue: undefined,
      };
      listener?.(event);
      return { prevented, returnValue: event.returnValue };
    },
    isRegistered() {
      return listener !== undefined;
    },
  };
}

test('warns before leaving only while a large export is active', async () => {
  const lifecycle = beforeUnloadTarget();
  let finish;
  const operation = withLargeExportLeaveWarning(
    () => new Promise((resolve) => { finish = resolve; }),
    lifecycle.target,
  );

  assert.equal(lifecycle.isRegistered(), true);
  assert.deepEqual(lifecycle.dispatch(), { prevented: true, returnValue: '' });

  finish('complete');
  assert.equal(await operation, 'complete');
  assert.equal(lifecycle.isRegistered(), false);
  assert.deepEqual(lifecycle.dispatch(), { prevented: false, returnValue: undefined });
});

test('removes the leave warning immediately after a failed large export', async () => {
  const lifecycle = beforeUnloadTarget();
  await assert.rejects(
    withLargeExportLeaveWarning(async () => { throw new Error('write failed'); }, lifecycle.target),
    /write failed/,
  );
  assert.equal(lifecycle.isRegistered(), false);
  assert.deepEqual(lifecycle.dispatch(), { prevented: false, returnValue: undefined });
});