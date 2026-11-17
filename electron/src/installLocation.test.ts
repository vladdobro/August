import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DATA_LOCATION_FILE,
  directoryExists,
  parseDataLocation,
  pinnedInstallDir,
  quoteWindowsArg,
  readDataLocation,
  resolveDataDir,
  serializeDataLocation,
  verbatimInstallerSpawn,
  windowsCommandLine,
  writeDataLocation,
} from './installLocation.js';

const INSTALL = 'D:\\Apps\\August\\data';
const OLD = 'E:\\Old\\August\\data';
const CYRILLIC = 'D:\\Программы\\Август\\data';
const existing = (...dirs: string[]) => (dir: string) => dirs.includes(dir);

/// Runs body while process.platform reports `platform`. The rules take the platform as an input, so every
/// case below must give the same answer on a Windows and a macOS host.
function withHostPlatform(platform: NodeJS.Platform, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    body();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

for (const host of ['win32', 'darwin'] as const) {
  test(`[host ${host}] no pointer falls back to the install folder and writes the pointer`, () => {
    withHostPlatform(host, () => {
      assert.deepEqual(
        resolveDataDir({ platform: 'win32', installDataDir: INSTALL, pointerRaw: null, dirExists: existing(INSTALL) }),
        { dataDir: INSTALL, source: 'install-dir', pointerDir: null, writePointer: true },
      );
    });
  });

  test(`[host ${host}] pointer to an existing other folder wins`, () => {
    withHostPlatform(host, () => {
      assert.deepEqual(
        resolveDataDir({ platform: 'win32', installDataDir: INSTALL, pointerRaw: serializeDataLocation(OLD), dirExists: existing(OLD, INSTALL) }),
        { dataDir: OLD, source: 'pointer', pointerDir: OLD, writePointer: false },
      );
    });
  });

  test(`[host ${host}] pointer to a missing folder falls back and rewrites the pointer`, () => {
    withHostPlatform(host, () => {
      assert.deepEqual(
        resolveDataDir({ platform: 'win32', installDataDir: INSTALL, pointerRaw: serializeDataLocation(OLD), dirExists: existing(INSTALL) }),
        { dataDir: INSTALL, source: 'pointer-missing', pointerDir: OLD, writePointer: true },
      );
    });
  });

  test(`[host ${host}] pointer equal to the install folder up to case and trailing separator`, () => {
    withHostPlatform(host, () => {
      const r = resolveDataDir({
        platform: 'win32',
        installDataDir: INSTALL,
        pointerRaw: serializeDataLocation('d:\\apps\\august\\DATA\\'),
        dirExists: () => false,
      });
      assert.equal(r.dataDir, INSTALL);
      assert.equal(r.source, 'install-dir');
      assert.equal(r.writePointer, false);
    });
  });

  test(`[host ${host}] unusable pointer content is ignored`, () => {
    withHostPlatform(host, () => {
      for (const raw of ['', 'not json', '[]', '{"dataDir": 5}', '{"dataDir": "relative\\\\data"}', '{}']) {
        assert.deepEqual(
          resolveDataDir({ platform: 'win32', installDataDir: INSTALL, pointerRaw: raw, dirExists: existing(OLD) }),
          { dataDir: INSTALL, source: 'install-dir', pointerDir: null, writePointer: true },
          `pointer content ${JSON.stringify(raw)}`,
        );
      }
    });
  });

  test(`[host ${host}] darwin never uses the pointer`, () => {
    withHostPlatform(host, () => {
      assert.deepEqual(
        resolveDataDir({
          platform: 'darwin',
          installDataDir: '/Users/u/Library/Application Support/August/data',
          pointerRaw: serializeDataLocation(OLD),
          dirExists: () => { throw new Error('must not be called'); },
        }),
        { dataDir: '/Users/u/Library/Application Support/August/data', source: 'install-dir', pointerDir: null, writePointer: false },
      );
    });
  });

  test(`[host ${host}] Cyrillic path round-trips through the pointer file`, () => {
    withHostPlatform(host, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'august-pointer-'));
      try {
        const file = path.join(dir, 'nested', DATA_LOCATION_FILE);
        writeDataLocation(file, CYRILLIC);
        assert.deepEqual(fs.readFileSync(file), Buffer.from(serializeDataLocation(CYRILLIC), 'utf-8'));
        assert.equal(parseDataLocation(readDataLocation(file)), CYRILLIC);
        assert.equal(
          resolveDataDir({ platform: 'win32', installDataDir: INSTALL, pointerRaw: readDataLocation(file), dirExists: existing(CYRILLIC) }).dataDir,
          CYRILLIC,
        );
        assert.deepEqual(fs.readdirSync(path.dirname(file)), [DATA_LOCATION_FILE]);
        assert.equal(parseDataLocation('\uFEFF' + serializeDataLocation(CYRILLIC)), CYRILLIC);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test(`[host ${host}] readDataLocation and directoryExists handle missing paths`, () => {
    withHostPlatform(host, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'august-pointer-'));
      try {
        const file = path.join(dir, 'f.txt');
        fs.writeFileSync(file, 'x');
        assert.equal(readDataLocation(path.join(dir, 'missing.json')), null);
        assert.equal(directoryExists(dir), true);
        assert.equal(directoryExists(file), false);
        assert.equal(directoryExists(path.join(dir, 'missing')), false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test(`[host ${host}] pinnedInstallDir pins packaged Windows folders, with or without a space`, () => {
    withHostPlatform(host, () => {
      assert.equal(pinnedInstallDir('win32', true, 'D:\\claude\\August\\installed\\August.exe'), 'D:\\claude\\August\\installed');
      assert.equal(pinnedInstallDir('win32', true, 'D:\\Программы\\Август\\August.exe'), 'D:\\Программы\\Август');
      assert.equal(pinnedInstallDir('win32', false, 'D:\\claude\\August\\installed\\August.exe'), null);
      assert.equal(pinnedInstallDir('darwin', true, '/Applications/August.app/Contents/MacOS/August'), null);
      assert.equal(pinnedInstallDir('win32', true, 'C:\\Program Files\\August\\August.exe'), 'C:\\Program Files\\August');
      assert.equal(
        pinnedInstallDir('win32', true, 'C:\\Users\\John Smith\\AppData\\Local\\Programs\\August\\August.exe'),
        'C:\\Users\\John Smith\\AppData\\Local\\Programs\\August',
      );
      assert.equal(pinnedInstallDir('win32', true, 'C:\\Bad"Dir\\August.exe'), null);
    });
  });

  test(`[host ${host}] verbatimInstallerSpawn keeps /D= raw for a folder with a space`, () => {
    withHostPlatform(host, () => {
      const cmd = 'C:\\Users\\John Smith\\AppData\\Local\\august-updater\\pending\\August-Setup.exe';
      const dir = 'C:\\Program Files\\August';
      const v = verbatimInstallerSpawn('win32', cmd, ['--updated', '/S', '--force-run', `/D=${dir}`], dir)!;
      assert.ok(v);
      const line = windowsCommandLine(v);
      assert.equal(line, `"${cmd}" --updated /S --force-run /D=C:\\Program Files\\August`);
      assert.ok(line.endsWith(' /D=C:\\Program Files\\August'));
    });
  });

  test(`[host ${host}] verbatimInstallerSpawn is null for a folder without a space`, () => {
    withHostPlatform(host, () => {
      const dir = 'D:\\claude\\August\\installed';
      assert.equal(verbatimInstallerSpawn('win32', 'C:\\x\\Setup.exe', ['--updated', '/S', `/D=${dir}`], dir), null);
    });
  });

  test(`[host ${host}] verbatimInstallerSpawn handles Cyrillic paths byte-identically`, () => {
    withHostPlatform(host, () => {
      const cmd = 'C:\\Users\\Влад Д\\AppData\\Local\\august-updater\\pending\\August-Setup.exe';
      const dir = 'C:\\Users\\Влад Д\\Программы\\August';
      const v = verbatimInstallerSpawn('win32', cmd, ['--updated', '/S', '--force-run', `/D=${dir}`], dir)!;
      assert.equal(v.argv0, `"${cmd}"`);
      assert.equal(v.args[v.args.length - 1], `/D=${dir}`);
      assert.ok(windowsCommandLine(v).endsWith(` /D=${dir}`));
    });
  });

  test(`[host ${host}] verbatimInstallerSpawn covers the elevate.exe variant`, () => {
    withHostPlatform(host, () => {
      const elevate = 'C:\\Program Files\\August\\resources\\elevate.exe';
      const installer = 'C:\\Users\\John Smith\\AppData\\Local\\august-updater\\pending\\August-Setup.exe';
      const dir = 'C:\\Program Files\\August';
      const v = verbatimInstallerSpawn('win32', elevate, [installer, '--updated', '/S', '--force-run', `/D=${dir}`], dir)!;
      assert.equal(windowsCommandLine(v), `"${elevate}" "${installer}" --updated /S --force-run /D=${dir}`);
    });
  });

  test(`[host ${host}] verbatimInstallerSpawn guards`, () => {
    withHostPlatform(host, () => {
      const dir = 'C:\\Program Files\\August';
      assert.equal(verbatimInstallerSpawn('darwin', 'x', ['--updated', `/D=${dir}`], dir), null);
      assert.equal(verbatimInstallerSpawn('win32', 'x', ['--updated', `/D=${dir}`], null), null);
      assert.equal(verbatimInstallerSpawn('win32', 'x', [`/D=${dir}`, '--package-file=x'], dir), null);
    });
  });

  test(`[host ${host}] quoteWindowsArg follows MS C runtime rules`, () => {
    withHostPlatform(host, () => {
      assert.equal(quoteWindowsArg(''), '""');
      assert.equal(quoteWindowsArg('abc'), 'abc');
      assert.equal(quoteWindowsArg('a b'), '"a b"');
      assert.equal(quoteWindowsArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
      assert.equal(quoteWindowsArg('a"b c'), '"a\\"b c"');
    });
  });
}
