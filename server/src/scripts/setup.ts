// One-time (idempotent) setup script that downloads or builds the
// whisper-cli binary for the current platform into whisper/bin/<platform>/,
// and downloads a pinned, SHA256-verified static ffmpeg + ffprobe build into
// the same folder (AUG-115) so the app never depends on a PATH install.
// On Windows it also bundles the Khronos Vulkan loader (vulkan-1.dll, AUG-117) next to whisper-cli,
// because the release build imports it statically and cannot start without it.
// Run via `npm run setup` (server/package.json) or the repo-root alias.
// Safe to re-run: it skips each step whose target binaries already exist.
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
  ffmpegBinName,
  type WhisperPlatformDir,
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

// Pinned static ffmpeg builds (AUG-115). Windows: BtbN's LGPL static build from a permanent autobuild tag
// (github.com/BtbN/FFmpeg-Builds, LGPL v3, sources in that repo). macOS: Martin Riedl's per-architecture
// static release builds (ffmpeg.martin-riedl.de, GPL v3 — built with --enable-gpl --enable-version3; source
// links on the site). Every SHA256 was computed from the downloaded archive; the macOS values also match the
// publisher's .sha256 files. Bump all three together when upgrading.
export const FFMPEG_VERSION = '9.0.2';

interface FfmpegArchive {
  url: string;
  sha256: string;
  // Files to copy out of the extracted archive, keyed to the bundled binary they become.
  entries: Array<{ archivePath: string; target: 'ffmpeg' | 'ffprobe' }>;
}

const FFMPEG_BUILDS: Record<WhisperPlatformDir, FfmpegArchive[]> = {
  'win-x64': [
    {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-20-13-11/ffmpeg-n9.0.2-3-ga5923073bf-win64-lgpl-9.0.zip',
      sha256: 'ec1706ea5c63a73030e485ec6954f0d6a672508c9548a1c5ed07c85c90ee4ef3',
      entries: [
        { archivePath: path.join('ffmpeg-n9.0.2-3-ga5923073bf-win64-lgpl-9.0', 'bin', 'ffmpeg.exe'), target: 'ffmpeg' },
        { archivePath: path.join('ffmpeg-n9.0.2-3-ga5923073bf-win64-lgpl-9.0', 'bin', 'ffprobe.exe'), target: 'ffprobe' },
      ],
    },
  ],
  'darwin-arm64': [
    {
      url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip',
      sha256: 'c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924',
      entries: [{ archivePath: 'ffmpeg', target: 'ffmpeg' }],
    },
    {
      url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip',
      sha256: 'fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6',
      entries: [{ archivePath: 'ffprobe', target: 'ffprobe' }],
    },
  ],
  'darwin-x64': [
    {
      url: 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip',
      sha256: '7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4',
      entries: [{ archivePath: 'ffmpeg', target: 'ffmpeg' }],
    },
    {
      url: 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffprobe.zip',
      sha256: '2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd',
      entries: [{ archivePath: 'ffprobe', target: 'ffprobe' }],
    },
  ],
};

// Pinned Vulkan loader (AUG-117). The v1.8.4 Windows release zip links ggml-vulkan.dll into ggml.dll statically, and
// ggml-vulkan.dll imports vulkan-1.dll, so on a machine without a Vulkan-capable GPU driver whisper-cli dies at process
// load (0xC0000135) for every flag set — --no-gpu cannot help. Bundling the Khronos loader (LunarG's signed runtime
// build; Apache-2.0 + MIT, licence file shipped next to the DLL) makes whisper-cli start everywhere: with no driver the
// loader reports no device and whisper-cli falls back to CPU by itself. Windows only — the macOS build has no Vulkan.
// The archive SHA256 was computed from the downloaded zip. Bump url + sha256 + archive paths together when upgrading.
export const VULKAN_RUNTIME = {
  version: '1.4.357.0',
  url: 'https://sdk.lunarg.com/sdk/download/1.4.357.0/windows/VulkanRT-X64-1.4.357.0-Components.zip',
  sha256: 'a14672efed15aafc7f5a16572d35cd3a3416eadf670aeee3cdf50ee32d5fbf83',
  dllArchivePath: path.join('VulkanRT-X64-1.4.357.0-Components', 'x64', 'vulkan-1.dll'),
  licenseArchivePath: path.join('VulkanRT-X64-1.4.357.0-Components', 'VulkanRT-License.txt'),
  dllTarget: 'vulkan-1.dll',
  licenseTarget: 'VulkanRT-License.txt',
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

/// Extracts a zip with tar (bsdtar ships with Windows 10+ and macOS); on Windows falls back to Expand-Archive.
/// Windows calls System32\tar.exe by absolute path: Git Bash puts GNU tar first on PATH, and GNU tar reads
/// "D:\..." as a remote host:path archive ("Cannot connect to D:"), which bsdtar does not.
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const tarBin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const tarResult = spawnSync(tarBin, ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
  if (tarResult.status === 0) return;
  if (process.platform !== 'win32') {
    throw new Error(`Failed to extract ${path.basename(zipPath)}`);
  }
  run(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
    `Failed to extract ${path.basename(zipPath)} (both tar and Expand-Archive failed)`,
  );
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
  await extractZip(zipPath, extractDir);

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

/// Downloads the pinned static ffmpeg + ffprobe for this platform into targetDir (next to whisper-cli).
/// Returns true when it downloaded something (so the caller cleans whisper/.build/), false when both
/// binaries were already present.
async function setupFfmpeg(platformDir: WhisperPlatformDir, targetDir: string): Promise<boolean> {
  const targets = {
    ffmpeg: path.join(targetDir, ffmpegBinName('ffmpeg')),
    ffprobe: path.join(targetDir, ffmpegBinName('ffprobe')),
  };
  if ((await fileExists(targets.ffmpeg)) && (await fileExists(targets.ffprobe))) {
    console.log(`✔ ffmpeg already present at ${targets.ffmpeg} — skipping.`);
    return false;
  }

  const archives = FFMPEG_BUILDS[platformDir];
  const workDir = path.join(WHISPER_BUILD_DIR, 'ffmpeg');
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
  console.log(`Downloading ffmpeg ${FFMPEG_VERSION} (static build) for ${platformDir}...`);

  for (const [index, archive] of archives.entries()) {
    const archivePath = path.join(workDir, `archive-${index}.zip`);
    const lastStep = { value: -1 };
    const { sha256 } = await downloadToFile(archive.url, archivePath, {
      onProgress: logProgressPercent(`ffmpeg download ${index + 1}/${archives.length}`, lastStep),
    });
    if (sha256 !== archive.sha256) {
      await fs.unlink(archivePath).catch(() => {});
      throw new Error(`ffmpeg archive checksum mismatch for ${archive.url} (expected ${archive.sha256}, got ${sha256})`);
    }

    const extractDir = path.join(workDir, `extracted-${index}`);
    await extractZip(archivePath, extractDir);
    for (const entry of archive.entries) {
      const source = path.join(extractDir, entry.archivePath);
      if (!(await fileExists(source))) {
        throw new Error(`${entry.archivePath} missing inside ${path.basename(archive.url)}`);
      }
      await fs.copyFile(source, targets[entry.target]);
      if (process.platform !== 'win32') await fs.chmod(targets[entry.target], 0o755);
    }
  }

  for (const bin of Object.values(targets)) {
    if (!(await fileExists(bin))) throw new Error(`ffmpeg setup finished but ${bin} is missing`);
  }
  return true;
}

/// Windows only: bundles the Vulkan loader + its licence next to whisper-cli (AUG-117). Idempotent — skipped when
/// vulkan-1.dll is already in targetDir. Returns true when it downloaded something (caller cleans whisper/.build/).
async function setupVulkanLoader(targetDir: string): Promise<boolean> {
  const dllTarget = path.join(targetDir, VULKAN_RUNTIME.dllTarget);
  if (await fileExists(dllTarget)) {
    console.log(`✔ Vulkan loader already present at ${dllTarget} — skipping.`);
    return false;
  }

  const workDir = path.join(WHISPER_BUILD_DIR, 'vulkan');
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
  console.log(`Downloading Vulkan loader ${VULKAN_RUNTIME.version} (LunarG runtime components, ~18 MB)...`);

  const zipPath = path.join(workDir, 'vulkan-runtime.zip');
  const lastStep = { value: -1 };
  const { sha256 } = await downloadToFile(VULKAN_RUNTIME.url, zipPath, {
    onProgress: logProgressPercent('Vulkan loader download', lastStep),
  });
  if (sha256 !== VULKAN_RUNTIME.sha256) {
    await fs.unlink(zipPath).catch(() => {});
    throw new Error(`Vulkan runtime checksum mismatch (expected ${VULKAN_RUNTIME.sha256}, got ${sha256})`);
  }

  const extractDir = path.join(workDir, 'extracted');
  await extractZip(zipPath, extractDir);
  const copies: Array<[archivePath: string, target: string]> = [
    [VULKAN_RUNTIME.dllArchivePath, dllTarget],
    [VULKAN_RUNTIME.licenseArchivePath, path.join(targetDir, VULKAN_RUNTIME.licenseTarget)],
  ];
  for (const [archivePath, target] of copies) {
    const source = path.join(extractDir, archivePath);
    if (!(await fileExists(source))) {
      throw new Error(`${archivePath} missing inside ${path.basename(VULKAN_RUNTIME.url)}`);
    }
    await fs.copyFile(source, target);
  }
  if (!(await fileExists(dllTarget))) {
    throw new Error(`Vulkan loader setup finished but ${dllTarget} is missing`);
  }
  return true;
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
  let usedBuildDir = false;

  if (await fileExists(targetBin)) {
    console.log(`✔ whisper-cli already present at ${targetBin} — skipping.`);
  } else {
    if (process.platform === 'win32') {
      await setupWindows(targetDir, targetBin);
    } else if (process.platform === 'darwin') {
      await setupMacOS(targetDir, targetBin);
    }
    usedBuildDir = true;
  }

  if (platformDir === 'win-x64' && (await setupVulkanLoader(targetDir))) {
    usedBuildDir = true;
  }
  if (await setupFfmpeg(platformDir, targetDir)) {
    usedBuildDir = true;
  }
  if (usedBuildDir) {
    await fs.rm(WHISPER_BUILD_DIR, { recursive: true, force: true });
  }

  // config.ffmpegPath was resolved at import time (possibly before the download above), so probe the bundled binary directly.
  const bundledFfmpeg = path.join(targetDir, ffmpegBinName('ffmpeg'));
  if (await checkFfmpegAvailable(bundledFfmpeg)) {
    console.log(`✔ ffmpeg ${FFMPEG_VERSION} ready at ${bundledFfmpeg}`);
  } else {
    console.warn(FFMPEG_MISSING_MESSAGE);
  }

  if (platformDir === 'win-x64') {
    console.log(`✔ Vulkan loader ${VULKAN_RUNTIME.version} bundled at ${path.join(targetDir, VULKAN_RUNTIME.dllTarget)}`);
  }

  console.log('ℹ The whisper model (~1.6 GB) downloads automatically on first server start.');
  console.log('✔ Setup complete.');
}

main().catch((err) => {
  if (isOfflineError(err)) {
    console.error('❌ No internet connection. Cannot download whisper-cli / Vulkan loader / ffmpeg.');
  } else {
    console.error(`❌ Setup failed: ${(err as Error)?.message || err}`);
    console.error(`   Build artifacts left at: ${WHISPER_BUILD_DIR}`);
  }
  process.exit(1);
});
