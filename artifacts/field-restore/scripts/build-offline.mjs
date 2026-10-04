import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve('dist/public');
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? files(absolute) : [path.relative(root, absolute).replaceAll('\\', '/')];
  }))).flat();
}
// Only shipped application resources. Never include installers, recordings or generated exports.
const assets = (await files(root)).filter(file =>
  file !== 'export-download-sw.js' && !file.startsWith('releases/') && !file.endsWith('.map')).sort();
const hash = createHash('sha256');
for (const file of assets) hash.update(file).update(await readFile(path.join(root, file)));
const offline = { version: hash.digest('hex').slice(0, 20), assets };
const worker = path.join(root, 'export-download-sw.js');
await writeFile(worker, (await readFile(worker, 'utf8')).replace('const OFFLINE = null;', `const OFFLINE = ${JSON.stringify(offline)};`));
console.info(`Offline release: ${offline.version}, ${assets.length} local resources`);