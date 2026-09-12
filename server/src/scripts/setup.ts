// One-time (idempotent) setup script that downloads or builds the
// whisper-cli binary for the current platform into whisper/bin/<platform>/.
// Run via `npm run setup` (server/package.json) or the repo-root alias.
// Safe to re-run: it skips work when the target binary already exists.
//
// macOS needs only the Xcode Command Line Tools installed (this script opens
// Apple's installer if they're missing). cmake is used from PATH when
// present, or otherwise auto-downloaded — a portable, pinned, SHA256-verified
// build — into whisper/.build/, which is deleted after a successful build.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  WHISPER_CPP_VERSION,
  WHISPER_BIN_ROOT,
  WHISPER_BUILD_DIR,
  whisperPlatformDir,
  whisperBinName,
} from '../config.js';
import { downloadToFile, isOfflineError } from '../services/download.js';
import { checkFfmpegAvailable, FFMPEG_MISSING_MESSAGE, fileExists } from '../services/whisper.js';

const PORTABLE_CMAKE = {
  version: '4.4.3',
  url: 'https://github.com/Kitware/CMake/releases/download/v4.4.3/cmake-4.4.3-macos-universal.tar.gz',
  sha256: '0c5d65251c14cc884bfa16bdbed3c263ce5bffe2e21c0d0d00962cb0610464fa',
  // Path of the cmake binary inside the extracted tarball.
  binRelPath: path.join('cmake-4.4.3-macos-universal', 'CMake.app', 'Contents', 'bin', 'cmake'),
} as const;

function run(cmd: string, args: string[], failMessage: string): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(failMessage);
  }
}

function logProgressPercent(label: string, lastStepRef: { value: number }) {
  return (p: { percent: number }) => {
    const step = Math.floor(p.percent / 10);
    if (step !== lastStepRef.value) {
      lastStepRef.value = step;
      console.log(`  ${label}: ${p.percent.toFixed(0)}%`);
    }
  };
}

async function setupWindows(targetDir: string, targetBin: string): Promise<void> {
  // Legacy migration: earlier versions of this repo kept the binaries
  // directly under whisper/bin/ instead of whisper/bin/win-x64/.
  const legacyBin = path.join(WHISPER_BIN_ROOT, 'whisper-cli.exe');
  if (await fileExists(legacyBin)) {
    await fs.mkdir(targetDir, { recursive: true });
    const entries = await fs.readdir(WHISPER_BIN_ROOT);
    await fs.copyFile(legacyBin, targetBin);
    for (const entry of entries) {
      if (entry.toLowerCase().endsWith('.dll')) {
        await fs.copyFile(path.join(WHISPER_BIN_ROOT, entry), path.join(targetDir, entry));
      }
    }
    console.log('Migrated existing binaries from whisper/bin/ to whisper/bin/win-x64/');
    return;
  }

  await fs.mkdir(WHISPER_BUILD_DIR, { recursive: true });
  const zipPath = path.join(WHISPER_BUILD_DIR, 'whisper-bin-x64.zip');
  const url = `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_CPP_VERSION}/whisper-bin-x64.zip`;

  console.log(`Downloading whisper-cli (v${WHISPER_CPP_VERSION}) for Windows x64...`);
  const lastStep = { value: -1 };
  await downloadToFile(url, zipPath, { onProgress: logProgressPercent('Download', lastStep) });

  const extractDir = path.join(WHISPER_BUILD_DIR, 'extracted');
  await fs.mkdir(extractDir, { recursive: true });

  const tarResult = spawnSync('tar', ['-xf', zipPath, '-C', extractDir], { stdio: 'inherit' });
  if (tarResult.status !== 0) {
    run(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`],
      'Failed to extract whisper-bin-x64.zip (both tar and Expand-Archive failed)',
    );
  }

  await fs.mkdir(targetDir, { recursive: true });
  const releaseDir = path.join(extractDir, 'Release');
  const releaseEntries = await fs.readdir(releaseDir);
  await fs.copyFile(path.join(releaseDir, 'whisper-cli.exe'), targetBin);
  for (const entry of releaseEntries) {
    if (entry.toLowerCase().endsWith('.dll')) {
      await fs.copyFile(path.join(releaseDir, entry), path.join(targetDir, entry));
    }
  }

  if (!(await fileExists(targetBin))) {
    throw new Error(`whisper-cli.exe missing after extraction (expected at ${targetBin})`);
  }
}

async function resolveCmake(): Promise<string> {
  const cmakeCheck = spawnSync('cmake', ['--version'], { stdio: 'ignore' });
  if (cmakeCheck.status === 0) {
    return 'cmake';
  }

  const toolsDir = path.join(WHISPER_BUILD_DIR, 'tools');
  const cmakeBin = path.join(toolsDir, PORTABLE_CMAKE.binRelPath);
  if (await fileExists(cmakeBin)) {
    return cmakeBin;
  }

  console.log(
    `cmake not found on PATH — downloading portable CMake ${PORTABLE_CMAKE.version} (~90 MB) into whisper/.build/ (removed after the build)...`,
  );
  const tarballPath = path.join(toolsDir, 'cmake.tar.gz');
  const lastStep = { value: -1 };
  const { sha256 } = await downloadToFile(PORTABLE_CMAKE.url, tarballPath, {
    onProgress: logProgressPercent('CMake download', lastStep),
  });
  if (sha256 !== PORTABLE_CMAKE.sha256) {
    await fs.unlink(tarballPath).catch(() => {});
    throw new Error(`Portable CMake checksum mismatch (expected ${PORTABLE_CMAKE.sha256}, got ${sha256})`);
  }

  run('tar', ['-xzf', tarballPath, '-C', toolsDir], 'Failed to extract portable CMake');
  await fs.unlink(tarballPath).catch(() => {});

  if (!(await fileExists(cmakeBin))) {
    throw new Error(`Portable CMake extraction did not produce the expected binary at ${cmakeBin}`);
  }
  return cmakeBin;
}

async function setupMacOS(targetDir: string, targetBin: string): Promise<void> {
  const xcodeCheck = spawnSync('xcode-select', ['-p'], { stdio: 'ignore' });
  if (xcodeCheck.status !== 0) {
    spawnSync('xcode-select', ['--install'], { stdio: 'inherit' });
    throw new Error(
      'Xcode Command Line Tools are required to compile whisper-cli. The installer has been opened — finish it, then run `npm run dev` (or `npm run setup`) again.',
    );
  }

  await fs.mkdir(WHISPER_BUILD_DIR, { recursive: true });
  const cmakeBin = await resolveCmake();

  const tarballPath = path.join(WHISPER_BUILD_DIR, `whisper.cpp-${WHISPER_CPP_VERSION}.tar.gz`);
  const url = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_CPP_VERSION}.tar.gz`;

  console.log(`Downloading whisper.cpp v${WHISPER_CPP_VERSION} source...`);
  const lastStep = { value: -1 };
  await downloadToFile(url, tarballPath, { onProgress: logProgressPercent('Download', lastStep) });

  run('tar', ['-xzf', tarballPath, '-C', WHISPER_BUILD_DIR], 'Failed to extract whisper.cpp source tarball');

  const srcDir = path.join(WHISPER_BUILD_DIR, `whisper.cpp-${WHISPER_CPP_VERSION}`);
  const buildDir = path.join(srcDir, 'build');
  const isArm64 = process.arch === 'arm64';
  const osxArch = isArm64 ? 'arm64' : 'x86_64';

  console.log('Building whisper-cli from source — this takes a few minutes...');

  const cmakeArgs = [
    '-S', srcDir,
    '-B', buildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=OFF',
    '-DWHISPER_SDL2=OFF',
    `-DCMAKE_OSX_ARCHITECTURES=${osxArch}`,
    `-DGGML_METAL=${isArm64 ? 'ON' : 'OFF'}`,
    '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
  ];
  if (isArm64) {
    cmakeArgs.push('-DGGML_METAL_EMBED_LIBRARY=ON');
  }
  run(cmakeBin, cmakeArgs, 'cmake configure failed');
  run(
    cmakeBin,
    ['--build', buildDir, '--config', 'Release', '--target', 'whisper-cli', '-j', String(os.cpus().length)],
    'cmake build failed',
  );

  await fs.mkdir(targetDir, { recursive: true });
  await fs.copyFile(path.join(buildDir, 'bin', 'whisper-cli'), targetBin);
  await fs.chmod(targetBin, 0o755);
}

async function main(): Promise<void> {
  const platformDir = whisperPlatformDir();
  if (!platformDir) {
    console.error(`❌ Unsupported platform ${process.platform}-${process.arch}. Supported: Windows x64, macOS arm64/x64.`);
    process.exit(1);
    return;
  }

  const targetDir = path.join(WHISPER_BIN_ROOT, platformDir);
  const targetBin = path.join(targetDir, whisperBinName());

  if (await fileExists(targetBin)) {
    console.log(`✔ whisper-cli already present at ${targetBin} — skipping.`);
  } else {
    if (process.platform === 'win32') {
      await setupWindows(targetDir, targetBin);
    } else if (process.platform === 'darwin') {
      await setupMacOS(targetDir, targetBin);
    }
    await fs.rm(WHISPER_BUILD_DIR, { recursive: true, force: true });
  }

  if (!(await checkFfmpegAvailable())) {
    console.warn(FFMPEG_MISSING_MESSAGE);
  }

  console.log('ℹ The whisper model (~1.6 GB) downloads automatically on first server start.');
  console.log('✔ Setup complete.');
}

main().catch((err) => {
  if (isOfflineError(err)) {
    console.error('❌ No internet connection. Cannot download whisper-cli.');
  } else {
    console.error(`❌ Setup failed: ${(err as Error)?.message || err}`);
    console.error(`   Build artifacts left at: ${WHISPER_BUILD_DIR}`);
  }
  process.exit(1);
});
