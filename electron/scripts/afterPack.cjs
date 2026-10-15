// electron-builder afterPack hook (electron/electron-builder.yml → afterPack).
//
// Ad-hoc signs the macOS bundle when no Developer ID certificate is configured.
// Apple Silicon refuses to launch arm64 code whose signature is missing or broken, and electron-builder
// invalidates Electron's original seal when it renames the executable and rewrites Info.plist. Without
// this step an unsigned build shows Gatekeeper's "damaged and can't be opened" for every user, and clearing
// quarantine does not help. An ad-hoc signed app still shows the "unverified developer" prompt, which the
// user can bypass (right-click → Open, or Privacy & Security → Open Anyway) — "damaged" cannot be bypassed.
// With CSC_LINK set, electron-builder signs with the real certificate and this hook does nothing.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function listExecutables(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listExecutables(full));
    else if (entry.isFile() && (fs.statSync(full).mode & 0o111) !== 0) out.push(full);
  }
  return out;
}

exports.default = async function afterPack(context) {
  // Windows: pre-compile the WASAPI loopback helper so the packaged app doesn't
  // depend on csc.exe at runtime. The exe goes into data/tools/ at the install root,
  // which is where the server's config.toolsDir points in packaged builds.
  if (context.electronPlatformName === 'win32') {
    const source = path.join(context.appOutDir, 'resources', 'app', 'server', 'tools', 'wasapi-loopback', 'WasapiLoopback.cs');
    if (fs.existsSync(source)) {
      const toolsDir = path.join(context.appOutDir, 'data', 'tools');
      const exePath = path.join(toolsDir, 'wasapi-loopback.exe');
      const hashPath = path.join(toolsDir, 'wasapi-loopback.sha256');
      const root = process.env.SystemRoot || 'C:\\Windows';
      const cscCandidates = [
        path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
        path.join(root, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
      ];
      const csc = cscCandidates.find((c) => fs.existsSync(c));
      if (csc) {
        fs.mkdirSync(toolsDir, { recursive: true });
        execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${exePath}`, source], { timeout: 60_000, windowsHide: true });
        const hash = require('node:crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex');
        fs.writeFileSync(hashPath, hash, 'utf-8');
        console.log(`  • pre-compiled WASAPI loopback helper → ${path.relative(context.appOutDir, exePath)}`);
      } else {
        console.log('  • WASAPI helper: csc.exe not found, skipping pre-compilation (will compile on first launch)');
      }
    }
  }

  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const sign = (target, extra = []) =>
    execFileSync('codesign', ['--force', '--sign', '-', ...extra, target], { stdio: 'inherit' });

  // Bundled CLI tools (whisper-cli, ffmpeg, ffprobe) live in Resources, which --deep does not cover.
  for (const bin of listExecutables(path.join(appPath, 'Contents', 'Resources', 'whisper', 'bin'))) sign(bin);
  sign(appPath, ['--deep']);
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${appName} (no CSC_LINK configured)`);
};
