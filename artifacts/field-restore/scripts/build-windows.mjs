import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const desktopPkg = JSON.parse(await readFile(path.join(root, 'desktop/package.json'), 'utf8'));
if (pkg.version !== desktopPkg.version) throw new Error('Web and desktop release versions must match.');
const env = { ...process.env, PORT: '4173', BASE_PATH: '/', NODE_ENV: 'production', CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
execFileSync('pnpm', ['run', 'build'], { cwd: root, env, stdio: 'inherit' });
await rm(path.join(root, 'desktop/web'), { recursive: true, force: true });
await cp(path.join(root, 'dist/public'), path.join(root, 'desktop/web'), { recursive: true,
  filter: filename => !filename.includes(`${path.sep}releases`) });
// Produce the complete application, then compile an unsigned installer on Linux.
// NSIS WriteUninstaller embeds its own uninstaller: no Wine/bootstrap execution is needed.
execFileSync('pnpm', ['exec', 'electron-builder', '--projectDir', 'desktop', '--config',
  path.join(root, 'electron-builder.cjs'), '--win', '--dir', '--x64', '--publish', 'never'], { cwd: root, env, stdio: 'inherit' });
const filename = `Field-Restore-${pkg.version}-Windows-x64-Setup.exe`;
const installer = path.join(root, 'release', filename);
// Delete only shipped files on uninstall, not any recordings or other user files in that folder.
const appDir = path.join(root, 'release/win-unpacked');
const directories = [];
const deletes = [];
const escape = name => name.replaceAll('$', '$$').replaceAll('"', '$\\"').replaceAll('/', '\\');
async function inventory(dir, relative = '') {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = `${relative}${item.name}`;
    if (item.isDirectory()) { await inventory(path.join(dir, item.name), `${file}/`); directories.push(file); }
    else deletes.push(`Delete "$INSTDIR\\${escape(file)}"`);
  }
}
await inventory(appDir);
const uninstallInclude = path.join(root, 'release/uninstall-files.nsh');
await writeFile(uninstallInclude, [...deletes, ...directories.map(dir => `RMDir "$INSTDIR\\${escape(dir)}"`)].join('\n'));
execFileSync(process.env.MAKENSIS_PATH ?? 'makensis', [
  `-DAPP_DIR=${appDir}`, `-DOUTPUT_FILE=${installer}`, `-DUNINSTALL_INCLUDE=${uninstallInclude}`,
  `-DAPP_ICON=${path.join(root, 'public/icons/app.ico')}`, `-DAPP_VERSION=${pkg.version}`,
  path.join(root, 'desktop/installer.nsi'),
], { cwd: root, stdio: 'inherit' });
const hash = createHash('sha256');
for await (const chunk of createReadStream(installer)) hash.update(chunk);
const sha256 = hash.digest('hex');
const releases = path.join(root, 'public/releases');
await mkdir(releases, { recursive: true });
await cp(installer, path.join(releases, filename));
const metadata = { filename, version: pkg.version, sha256, unsigned: true, architecture: 'x64',
  supportedWindows: 'Windows 10/11 x64', nativeWindowsTested: false };
await writeFile(path.join(releases, 'windows-release.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(path.join(releases, 'SHA256SUMS.txt'), `${sha256}  ${filename}\n`);
// Put the completed, real download in the next static publication, never in the offline cache.
await cp(releases, path.join(root, 'dist/public/releases'), { recursive: true });
console.info(`Unsigned installer ready: public/releases/${filename}\nSHA-256: ${sha256}`);