import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreamingEditChain } from './streaming-edit-chain.ts';

const sampleRate = 48000;
const totalFrames = 12000;
const modules = [
  { id: 'dc', type: 'dc', name: 'DC', enabled: true, params: { mode: 'Auto', amount: 0 } },
  { id: 'wind', type: 'wind', name: 'Wind', enabled: true, params: { cutoff: 100, q: 0.7 } },
  { id: 'eq', type: 'eq', name: 'EQ', enabled: true, params: { mode: 'low-shelf', frequency: 80, q: 0.5, gain: 2 } },
  { id: 'fade', type: 'fade', name: 'Fade', enabled: true, params: { in: 0.1, out: 0.1 } },
];

function source() {
  return [
    Float32Array.from({ length: totalFrames }, (_, i) => 0.08 + Math.sin(i * 0.031) * 0.3),
    Float32Array.from({ length: totalFrames }, (_, i) => -0.04 + Math.cos(i * 0.027) * 0.25),
  ];
}

test('sequential chunks equal one streaming pass across boundaries', () => {
  const input = source();
  const whole = createStreamingEditChain(modules, sampleRate, totalFrames).process(input, 0);
  const chunked = input.map(() => new Float32Array(totalFrames));
  const processor = createStreamingEditChain(modules, sampleRate, totalFrames);
  for (let start = 0; start < totalFrames; start += 257) {
    const end = Math.min(totalFrames, start + 257);
    const output = processor.process(input.map((channel) => channel.slice(start, end)), start);
    output.forEach((channel, index) => chunked[index].set(channel, start));
  }
  chunked.forEach((channel, channelIndex) => {
    for (let i = 0; i < totalFrames; i += 1) assert.equal(channel[i], whole[channelIndex][i]);
  });
});

test('restoring warmed state makes repeated selection loops deterministic', () => {
  const input = source();
  const selectionStart = 3000;
  const selectionEnd = 5000;
  const processor = createStreamingEditChain(modules, sampleRate, totalFrames, 2000);
  processor.process(input.map((channel) => channel.slice(2000, selectionStart)), 2000);
  const warmed = processor.snapshot();
  const selection = input.map((channel) => channel.slice(selectionStart, selectionEnd));
  const first = processor.process(selection, selectionStart);
  processor.restore(warmed);
  const second = processor.process(selection, selectionStart);
  first.forEach((channel, index) => assert.deepEqual(channel, second[index]));
});