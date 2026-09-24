import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChainPresets, readChainPresets, saveChainPreset } from './chain-presets.ts';
import { makeModule } from './edit-chain.ts';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('named chain presets retain order, settings, and bypass state across reads', () => {
  const storage = memoryStorage();
  const chain = [
    { ...makeModule('gain'), params: { db: 3.2 } },
    { ...makeModule('hum'), enabled: false, name: 'My notch' },
  ];
  const saved = saveChainPreset(storage, '  Dawn cleanup  ', chain);
  chain[0].params.db = -5;
  assert.equal(saved[0].name, 'Dawn cleanup');
  assert.deepEqual(readChainPresets(storage)[0].modules.map(({ name, enabled, params }) => ({ name, enabled, params })), [
    { name: 'Gain', enabled: true, params: { db: 3.2 } },
    { name: 'My notch', enabled: false, params: { mode: 'Static', frequency: 60, reduction: 12 } },
  ]);
});

test('duplicate names and corrupt stored data never overwrite saved presets', () => {
  const storage = memoryStorage();
  saveChainPreset(storage, 'Clean', [makeModule('gain')]);
  assert.throws(() => saveChainPreset(storage, ' clean ', []), /already exists/);
  assert.equal(readChainPresets(storage).length, 1);
  assert.deepEqual(parseChainPresets(null), []);
  assert.throws(() => parseChainPresets('{"oops":true}'), /could not be read/);
  assert.throws(() => parseChainPresets('{broken'), /could not be read/);
});