import { expect, test, type Page } from '@playwright/test';
import { fingerprintAudio, parseAudioMetadata } from '../src/lib/source-audio';
import type { EditModule } from '../src/lib/edit-chain';

function recording() {
  const rate = 8_000;
  const frames = rate * 2;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(2000 * Math.sin(2 * Math.PI * 300 * i / rate)), 44 + i * 2);
  return wav;
}

async function seedProject(page: Page, modules: EditModule[], wav: Buffer) {
  const file = new File([wav], 'reopen-test.wav', { type: 'audio/wav' });
  const metadata = await parseAudioMetadata(file, { name: file.name });
  const fingerprint = await fingerprintAudio(file, metadata);
  await page.evaluate(({ modules, fingerprint }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('field-restore-projects', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('projects')) {
        const store = database.createObjectStore('projects', { keyPath: 'id' });
        store.createIndex('savedAt', 'savedAt');
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('projects', 'readwrite');
      transaction.objectStore('projects').put({
        id: 'reopen-test-project',
        title: 'Saved field project',
        notes: '',
        savedAt: '2026-09-28T00:00:00.000Z',
        modules,
        markers: [],
        regions: [],
        source: { name: 'reopen-test.wav', sampleRate: 8000, duration: 2, channels: 1, fingerprint },
      });
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  }), { modules, fingerprint });
  await page.reload();
  await expect(page.getByTestId('text-source-name')).toHaveText('reopen-test.wav');
}

async function savedModules(page: Page): Promise<EditModule[]> {
  return page.evaluate(() => new Promise<EditModule[]>((resolve, reject) => {
    const request = indexedDB.open('field-restore-projects', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('projects', 'readonly');
      const get = transaction.objectStore('projects').get('reopen-test-project');
      get.onsuccess = () => { database.close(); resolve(get.result.modules); };
      get.onerror = () => { database.close(); reject(get.error); };
    };
  }));
}

test('saved choices appear before relink and edits made while waiting survive relink', async ({ page }) => {
  await page.goto('/');
  const wav = recording();
  const modules: EditModule[] = [
    { id: 'saved-hum', type: 'hum', name: 'Hum Removal', enabled: false, params: { mode: 'Static', frequency: 50, reduction: 4 } },
    { id: 'saved-wind', type: 'wind', name: 'Wind Removal', enabled: false, params: {
      mode: 'Automatic', detection: 'Medium', removal: 'Medium', compensationAttackMs: 25, compensationReleaseMs: 180,
    } },
  ];
  await seedProject(page, modules, wav);
  const hum = page.getByTestId('sidebar-module-saved-hum');
  const wind = page.getByTestId('sidebar-module-saved-wind');
  await expect(page.getByTestId('button-open-full-chain')).toContainText('0/2 editable enabled');
  await expect(hum).toHaveClass(/bypassed/);
  await expect(wind).toHaveClass(/bypassed/);
  await wind.getByRole('button', { name: 'Enable Wind Removal' }).click();
  await expect(wind).not.toHaveClass(/bypassed/);
  await page.getByTestId('input-import-wav').setInputFiles({ name: 'reopen-test.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(page.getByTestId('button-open-full-chain')).toContainText('1/2 editable enabled');
  await expect(hum).toHaveClass(/bypassed/);
  await expect(wind).not.toHaveClass(/bypassed/);
  await expect(wind).toContainText('Medium detection');
  expect(await savedModules(page)).toEqual(modules);
});

test('an empty saved chain opens with Common Field and does not silently rewrite the project', async ({ page }) => {
  await page.goto('/');
  const wav = recording();
  await seedProject(page, [], wav);
  await page.getByTestId('nav-project').click();
  for (const key of ['sentence1', 'sentence2', 'sentence3', 'continuation']) {
    await expect(page.getByTestId(`textarea-project-description-${key}`)).toHaveValue('');
  }
  await page.getByTestId('nav-edit').click();
  await expect(page.getByTestId('button-open-full-chain')).toContainText('4/6 editable enabled');
  const hum = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: 'Hum Removal' });
  const wind = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: 'Wind Removal' });
  const rumble = page.locator('[data-testid^="sidebar-module-"]').filter({ hasText: 'Low Rumble Removal' });
  await expect(hum).toHaveClass(/bypassed/);
  await expect(wind).toHaveClass(/bypassed/);
  await expect(rumble).not.toHaveClass(/bypassed/);
  const humId = await hum.getAttribute('data-testid');
  expect(await savedModules(page)).toEqual([]);
  await page.getByTestId('input-import-wav').setInputFiles({ name: 'reopen-test.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(page.getByTestId('button-open-full-chain')).toContainText('4/6 editable enabled');
  await expect(hum).toHaveAttribute('data-testid', humId!);
  expect(await savedModules(page)).toEqual([]);
});