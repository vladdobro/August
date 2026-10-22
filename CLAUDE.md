You always:
- aware about we have 2 platforms (macOS and Windows)

## Cross-platform rules

The app ships on **Windows x64** and **macOS arm64/x64**. Platform-specific code is spread across ~30 files; careless edits in shared paths break the other platform silently.

### Key divergences

| Area | Windows | macOS |
|---|---|---|
| Whisper binary | prebuilt zip download | cmake build from source |
| GPU engine | CUDA (optional download) | Metal (auto on Apple Silicon) |
| System audio capture | WASAPI loopback helper / Stereo Mix / VB-Cable | audiotee / BlackHole / avfoundation |
| Non-ASCII paths | 8.3 short paths via `toSafePath` | passthrough |
| Data dir (packaged) | `<install dir>/data` | `~/Library/Application Support/August/data` |
| Binary names | `.exe` suffix (`whisper-cli.exe`, `ffmpeg.exe`) | no suffix |
| Electron display media | loopback audio track | native picker (macOS 15+) or video-only |

### Mandatory checks

1. If a change touches a `process.platform` branch — verify both branches still work; don't assume the other path is unaffected.
2. New platform-specific code must be a no-op on the other platform (guard with `if (process.platform === '...')`, never bare).
3. Shared functions in `config.ts`, `systemCapture.ts`, `setup.ts`, `electron/src/main.ts` are the highest-risk files — changes there affect both platforms.
4. Tests (`gpuBackend.test.ts`, `config.test.ts`) mock `process.platform` for both values — keep them passing on both.
5. Path separators: use `path.join()`, never hardcoded `/` or `\`.
