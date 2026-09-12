# Whisper Setup

August uses [whisper.cpp](https://github.com/ggerganov/whisper.cpp)'s `whisper-cli.exe` to transcribe
audio locally. The binaries in `whisper/bin/` are git-ignored (large, platform-specific). For a fresh
clone, run the setup script to build and install everything automatically:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1
```

This installs build tools (CMake, MinGW-w64, Vulkan SDK) via winget, builds whisper.cpp v1.8.4 with
Vulkan GPU support, copies the binaries into `whisper/bin/`, and downloads the transcription model.

To rebuild manually, see [Building from source](#building-from-source-with-gpu-support) below.

## Model file

The transcription model, `ggml-large-v3-turbo.bin` (~1.5 GB), is expected at:

```
whisper/models/ggml-large-v3-turbo.bin
```

This path is relative to the repo root. The file is git-ignored because of its size.

### If the model is missing

Download it from Hugging Face:

```
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

and place it at `whisper/models/ggml-large-v3-turbo.bin` (create the `models` folder if it doesn't exist).

Expected SHA256 checksum:

```
1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69
```

Verify on Windows with:

```powershell
Get-FileHash "whisper\models\ggml-large-v3-turbo.bin" -Algorithm SHA256
```

## GPU acceleration

The `whisper-cli.exe` binary in `whisper/bin/` is built with Vulkan GPU support (`GGML_VULKAN=ON`).
It auto-detects a Vulkan-capable GPU at startup and uses it for transcription, falling back to
CPU-only if none is found. This works with NVIDIA, AMD, and Intel GPUs that support Vulkan — no
vendor-specific SDK (CUDA, ROCm, etc.) is required at runtime.

To force CPU-only mode regardless of GPU availability, pass `--no-gpu` on the command line.

## Overriding paths

Both the model path and the whisper-cli.exe binary path can be overridden via environment variables
(see `.env.example` at the repo root): `WHISPER_MODEL_PATH` and `WHISPER_BIN_PATH`. Leave them empty
to use the defaults described above.

## Building from source with GPU support

If `whisper/bin/` is ever cleared and needs to be rebuilt with Vulkan GPU support, here's how it was
built on Windows.

### Prerequisites

- [CMake](https://cmake.org/download/)
- MinGW-w64 (GCC) — a full toolchain including `gcc`, `g++`, and `mingw32-make`
- [Vulkan SDK](https://vulkan.lunarg.com/) (from LunarG)

Note: Windows paths containing non-ASCII characters (e.g. a Cyrillic username) can break this build
and the resulting binaries. Install/extract MinGW-w64 to a clean, ASCII-only path such as `D:\mingw64`
(or create a directory junction to one) rather than under a user profile folder with non-ASCII characters.

### Configure

```
cmake -S whisper.cpp -B build -G "MinGW Makefiles" \
  -DCMAKE_C_COMPILER=D:/mingw64/bin/gcc.exe \
  -DCMAKE_CXX_COMPILER=D:/mingw64/bin/g++.exe \
  -DCMAKE_MAKE_PROGRAM=D:/mingw64/bin/mingw32-make.exe \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_VULKAN=ON \
  -DGGML_OPENMP=OFF \
  -DBUILD_SHARED_LIBS=ON
```

### Build

```
cmake --build build --config Release -j 8
```

### Install

Copy the following from `build/bin/` into `whisper/bin/`:

- `whisper-cli.exe`
- `libwhisper.dll` (keep this name — `whisper-cli.exe`'s import table references it by exact
  filename, so renaming it to `whisper.dll` will break loading)
- `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`, `ggml-vulkan.dll`

And copy the MinGW runtime DLLs from the MinGW `bin/` directory (e.g. `D:\mingw64\bin\`):

- `libgcc_s_seh-1.dll`
- `libstdc++-6.dll`
- `libwinpthread-1.dll`
