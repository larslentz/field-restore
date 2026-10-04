import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { generateFloat32WavHeader } from '../src/lib/large-wav';

function recording(rf64: boolean) {
  const frameCount = 16000;
  const header = generateFloat32WavHeader({ channels: 1, sampleRate: 8000, frameCount, rf64 });
  const samples = Buffer.alloc(frameCount * 4);
  for (let i = 0; i < frameCount; i++) samples.writeFloatLE(.1 * Math.sin(2 * Math.PI * 300 * i / 8000), i * 4);
  return { name: 'backup-source.wav', mimeType: 'audio/wav', buffer: Buffer.concat([Buffer.from(header), samples]) };
}

async function records(page: Page): Promise<Array<{ id: string; title: string }>> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('field-restore-projects', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const query = db.transaction('projects').objectStore('projects').getAll();
      query.onsuccess = () => { resolve(query.result); db.close(); };
      query.onerror = () => { reject(query.error); db.close(); };
    };
  }));
}

for (const rf64 of [false, true]) {
  test(`${rf64 ? 'file-backed' : 'small'} project backup requires a verified source, preserves writing, and handles copy/replace`, async ({ page }) => {
    const upload = recording(rf64);
    await page.goto('/');
    await page.getByTestId('input-import-wav').setInputFiles(upload);
    await expect(page.getByTestId('text-source-name')).toHaveText(upload.name);
    await page.getByTestId('nav-project').click();
    await page.getByTestId('input-project-title').fill('Backup original');
    const description = '  Unicode 鳥\n\nexact paragraphs \n';
    await page.getByTestId('textarea-project-description-continuation').fill(description);
    await page.getByTestId('button-project-save').click();
    await expect(page.locator('.topbar .chip').first()).toContainText('Project saved');
    const downloadEvent = page.waitForEvent('download');
    await page.getByTestId('button-backup-export').click();
    const download = await downloadEvent;
    const text = await readFile((await download.path())!, 'utf8');
    const backup = JSON.parse(text);
    expect(download.suggestedFilename()).toMatch(/\.fieldrestore$/);
    expect(backup.project.trackDescription.continuation).toBe(description);
    expect(backup.project.source.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(text).not.toMatch(/fileHandle|originalBase64|originalLength/);
    const savedId = backup.project.id;
    const backupFile = { name: 'project.fieldrestore', mimeType: 'application/json', buffer: Buffer.from(text) };
    await page.getByTestId('input-project-backup').setInputFiles(backupFile);
    await expect(page.getByTestId('backup-conflict')).toBeVisible();
    await expect(page.getByTestId('button-backup-restore')).toBeDisabled();
    const beforeWrongSource = await records(page);
    const wrong = Buffer.from(upload.buffer);
    wrong[wrong.length - 1] ^= 1;
    await page.getByTestId('input-backup-source').setInputFiles({ ...upload, buffer: wrong });
    await expect(page.getByTestId('backup-error')).toContainText('does not match');
    expect(await records(page)).toEqual(beforeWrongSource);
    await page.getByTestId('button-backup-cancel').click();
    expect(await records(page)).toEqual(beforeWrongSource);
    await page.getByTestId('input-project-backup').setInputFiles(backupFile);
    await page.getByTestId('input-backup-source').setInputFiles(upload);
    await expect(page.getByTestId('backup-source-verified')).toBeVisible();
    await page.getByTestId('button-backup-copy').click();
    await expect(page.getByTestId('input-project-title')).toHaveValue('Backup original (restored copy)');
    await expect(page.getByTestId('textarea-project-description-continuation')).toHaveValue(description);
    const copiedRecords = await records(page);
    expect(copiedRecords.some((record) => record.id !== savedId && record.title === 'Backup original (restored copy)')).toBe(true);
    if (rf64) expect(copiedRecords.some((record) => record.id === savedId)).toBe(true);
    else expect(await page.evaluate(() => JSON.parse(localStorage.getItem('field-restore-project-v1')!).id)).toBe(savedId);
    await page.reload();
    await expect(page.locator('.topbar .chip').first()).toContainText('relink source audio');
    await page.getByTestId('input-import-wav').setInputFiles(upload);
    await page.getByTestId('nav-project').click();
    await expect(page.getByTestId('input-project-title')).toHaveValue('Backup original (restored copy)');
    await expect(page.getByTestId('textarea-project-description-continuation')).toHaveValue(description);
    await page.getByTestId('input-project-title').fill('Copy after relink');
    await page.getByTestId('button-project-save').click();
    await expect(page.locator('.topbar .chip').first()).toContainText('Project saved');
    await page.reload();
    await expect(page.locator('.topbar .chip').first()).toContainText('relink source audio');
    await page.getByTestId('input-import-wav').setInputFiles(upload);
    await page.getByTestId('nav-project').click();
    await expect(page.getByTestId('input-project-title')).toHaveValue('Copy after relink');
    await page.getByTestId('input-project-backup').setInputFiles(backupFile);
    await page.getByTestId('input-backup-source').setInputFiles(upload);
    await page.getByTestId('button-backup-restore').click();
    await expect(page.getByTestId('input-project-title')).toHaveValue('Backup original');
    expect((await records(page)).some((record) => record.id === savedId)).toBe(true);
    const beforeInvalid = await records(page);
    await page.getByTestId('input-project-backup').setInputFiles({ ...backupFile, buffer: Buffer.from('{"version":99}') });
    await expect(page.getByTestId('backup-error')).toContainText('Invalid or unsupported');
    expect(await records(page)).toEqual(beforeInvalid);
  });
}