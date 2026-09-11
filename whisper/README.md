# Whisper Setup

August uses [whisper.cpp](https://github.com/ggerganov/whisper.cpp)'s `whisper-cli.exe` to transcribe
audio locally. The binaries in `whisper/bin/` (whisper-cli.exe, whisper.dll, ggml.dll, ggml-base.dll,
ggml-cpu.dll) are already included for Windows and are ignored by git (see `.gitignore`) because they
are large, platform-specific binaries — re-copy them from a whisper.cpp release build if this folder
is ever cleared.

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

## Overriding paths

Both the model path and the whisper-cli.exe binary path can be overridden via environment variables
(see `.env.example` at the repo root): `WHISPER_MODEL_PATH` and `WHISPER_BIN_PATH`. Leave them empty
to use the defaults described above.
