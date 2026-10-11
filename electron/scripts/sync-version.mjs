// The root `version` file is the single source of truth for the app version. electron-builder and
// app.getVersion() read package.json, so this copies the version there (and into the lockfile root)
// before every build. Plain Node keeps it working on both macOS and Windows shells.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = readFileSync(join(root, 'version'), 'utf8').trim();

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`sync-version: invalid version "${version}" in the version file`);
  process.exit(1);
}

function update(file, apply) {
  const path = join(root, file);
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  const json = JSON.parse(raw);
  if (!apply(json)) return;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(path, JSON.stringify(json, null, 2).replace(/\n/g, eol) + eol);
  console.log(`sync-version: ${file} -> ${version}`);
}

update('package.json', (pkg) => {
  if (pkg.version === version) return false;
  pkg.version = version;
  return true;
});

update('package-lock.json', (lock) => {
  const rootPkg = lock.packages?.[''];
  if (lock.version === version && (!rootPkg || rootPkg.version === version)) return false;
  lock.version = version;
  if (rootPkg) rootPkg.version = version;
  return true;
});
