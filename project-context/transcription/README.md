# Transcription Route

## TL;DR
- whisper-cli (whisper.cpp), built for Windows and macOS, transcribes session audio locally; output is raw timestamped segments in milliseconds.
- runWhisper() in whisper.ts is the single whisper-cli invocation path for both batch and live transcription.
- runWhisper() retries a Vulkan-class failure once with --no-gpu and keeps the process on CPU afterwards (AUG-116, services/gpuBackend.ts).
- runWhisper() may confirm or flip the GPU state only if the job ran the native GPU binary and the GpuState epoch is unchanged since spawn (AUG-140).
- On Windows x64, GPU transcription uses the CUDA engine (switchable in Settings); CPU is the default; the bundled Vulkan loader is legacy (AUG-117/136).
- TranscriptMerger filters hallucinations and filler, dedupes near-duplicate segments, and joins nearby segments into readable lines.
- stripCreditHallucination replaces the "Редактор субтитров А.Семкин Корректор А.Егорова" hallucination with [OOPS] via regex, not silent drop.
- A session moves through uploading → preparing → transcribing → completed or failed; the preparing phase runs ensureWav/ffprobe in the background so the upload responds instantly (AUG-147).
- Failed sessions can be retranscribed from the UI; the retranscribe endpoint runs a whisper-cli and model preflight check before flipping status.
- Dual-track recording (mic + system) produces one session; mergeDualStream interleaves both streams with [Me]/[Them] role labels.
- Server-captured system tracks are offset-aligned by alignDualSegments (session.systemOffsetMs) before mergeDualStream; browser-recorded dual tracks have offset 0.
- Transcript headers never print systemOffsetMs; the alignment offset is a diagnostic kept only in session.json.
- TranscriptMerger constants are a faithful port from SplitVox's C# implementation — never re-tune without re-validating against known audio.
- Single-track transcripts have no role prefix; dual-track transcripts prefix each line with [Me] or [Them].
- Active whisper child processes are tracked per session in a Map; cancelTranscription kills all tracked processes for a session.
- Audio boost mode applies ffmpeg preprocessing (highpass, lowpass, volume gain, loudnorm) to quiet mic tracks before whisper runs.
- performanceTracker.ts stores rolling processing-seconds per audio-second ratios (last 10, pipeline 2) in data/perf-stats.json for ETA estimation.
- whisper-cli decodes greedily (--beam-size 1 --best-of 1, WHISPER_DECODING in config.ts), ported from SplitVox; --max-context 0 and default flash attention stay.
- Batch jobs pass --vad with the bundled Silero model ggml-silero-v5.1.2.bin; timestamps stay on the original track timeline.
- Dual-track sessions transcribe mic then system sequentially through one global batch slot; live chunks bypass the slot.
- Dual-track session.duration equals alignedDualDuration(mic, system, systemOffsetMs), the real call length, in upload, retranscribe and completion paths.
- describeTrackMismatch warns (server log + session.trackWarning shown in TranscriptView) when tracks differ by more than 60 s or 10%.
- estimatedDuration = (mic + system seconds) × median perf ratio for the current GPU/CPU mode; defaults 0.03 Metal/GPU, 0.16 CPU.
- Retranscribe reuses existing audio-*.wav conversions and boosted WAVs whose mtime is not older than the source.
- getAudioDuration() uses ffprobe to measure audio length before transcription starts, enabling accurate time estimates.
- File upload accepts .wav, .mp3, .ogg, .flac, .m4a, .mp4 and .mov, case-insensitive; for .mp4/.mov ensureWav extracts the audio track to 16 kHz mono WAV with the bundled ffmpeg (-vn) (AUG-144).
- Upload size limit: 2 GB, enforced client-side (FileUpload.tsx rejects before upload) and server-side (multer LIMIT_FILE_SIZE → HTTP 413 JSON); both sides define MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024 (AUG-145).
- Before uploading a .mp4/.mov, the browser reads the file's moov box locally and blocks only a video confirmed to have no audio track; when undecided it uploads and the server ffprobe check decides (AUG-146).
- POST /api/sessions/from-url accepts a direct HTTP/HTTPS media link, downloads the file locally, and runs it through the standard whisper pipeline (AUG-148).
- URL downloads enforce SSRF protection: private/loopback/link-local hosts are blocked, redirects capped at 5 with re-validation at each hop (AUG-148).
- Video-site links (YouTube, Vimeo, Dailymotion; host list PLATFORM_HOSTS in ytDlp.ts) are detected first in from-url and handled by a bundled yt-dlp: metadata probe → audio-only download → the same preparing → transcribing pipeline (AUG-149).
- HTML responses from a pasted link are rejected with "This link is not a direct media file — download it and upload the file instead."
- The 2 GB size cap applies to URL downloads via Content-Length pre-check and streaming byte count; stall timeout is 60 seconds.
- After every batch transcription the server computes confidenceScore (0–100) in server/src/services/confidenceScore.ts from whisper's per-segment signals and stores it with a confidenceDetail breakdown in session.json (AUG-152).
- Confidence formula: acousticScore = 100 × duration-weighted (1 − no_speech_prob) base (neutral 1.0 on whisper-cli 1.8.4), minus 40 × duration share of segments with avg_logprob < −1.0, minus min(30, 100 × merger drop ratio), minus 30 × coverage shortfall below 50 %; then the semantic term (AUG-163) subtracts min(50, 40 × duration share of text-flagged segments + 30 × share flagged only by perplexity + min(30, 15 × loop segments) + 25 when the session median perplexity > 600); the semantic term only lowers the score (score ≤ acousticScore), so the auto-delete WAV rule never gets more aggressive; an empty transcript scores 0 (AUG-152, AUG-163).
- Semantic layer 1 (always on, AUG-163): server/src/services/textStats.ts flags each raw whisper segment for loop (zlib compression ratio > 2.4, or a near-duplicate of the previous segment whose joined ratio > 2.4), oov (> 45 % of ≥ 5 words missing from the bundled en/ru top-50K lists), stopwords (function-word share outside 8–80 % on ≥ 8 words), script (≥ 60 % letters in the other alphabet when the session language is ru or en), rate (> 6.5 words/s, or < 0.4 words/s on segments ≥ 10 s) and token-dip (≥ 2 tokens with p < 0.05 and ln p 2.5 below their ±3 neighbours, ≥ 10 % of tokens).
- Semantic layer 2 (only when the local language model is on and downloaded, AUG-163): semanticCheck.scorePerplexity scores every segment of ≥ 3 words in the same batch slot right after whisper, with the two previous segments of the same track as prefix; segments with PPL > 4 × the session median (≥ 5 scored) are flagged; 240 s time budget, the rest is skipped.
- Meaning corrections (AUG-163): with the Settings → Transcription checkbox llmCorrections on, every flagged segment found verbatim inside a transcript line is sent to the local model (temperature 0, 'fix only misheard words, add/remove/reorder nothing, return unchanged if unsure'); suggestions that add words or differ by more than 40 % (character similarity < 0.6) are discarded; max 40 per session, 180 s budget; results go to transcript.corrected.json, transcript.md is never written.
- avg_logprob is rebuilt in transcribe() as the mean ln(p) of a segment's non-special tokens from --output-json-full; neither whisper-cli 1.8.4 nor upstream whisper.cpp master writes segment-level no_speech_prob / avg_logprob to JSON, so the binary is not patched and the no-speech term stays neutral until a build exports it (AUG-152).
- With the Settings → Transcription toggle "Delete audio.wav after transcription" on and confidenceScore ≥ the threshold (50–95, default 70), sessionManager.autoDeleteDerivedWavs removes only converted WAVs that have a non-WAV source beside them; source files and server-captured audio-system.wav are never auto-deleted, and ensureWav rebuilds the WAV on retranscription (AUG-152).
- Also known as: video upload, MP4/MOV transcription, audio extraction from video (AUG-144), client-side no-audio pre-check, video audio track detection (AUG-146), preparing phase, async extraction (AUG-147), URL transcription, paste link, link download, from-url endpoint (AUG-148), YouTube transcription, video-site link, platform URL, yt-dlp (AUG-149), audio deleted, re-download audio (AUG-150), confidence score, transcription quality score, confidenceScore, auto-delete WAV, wavAutoDeletedAt (AUG-152), semantic confidence, text statistics, perplexity, loop detection, wrong-language decode, meaning corrections, transcript.corrected.json, Accept fix (AUG-163).
- For WAV uploads, estimatedDuration is computed synchronously in the endpoint; for non-WAV uploads, prepareAndTranscribe sets it after background extraction before starting whisper (AUG-147).
- Orphaned sessions stuck in "transcribing" or "preparing" with no active process are auto-recovered to "failed" on server startup.
- Live transcription mode streams real-time audio chunks over WebSocket to whisper-cli or Groq Whisper API (opt-in) — see child route live-transcription/.
- Live transcription supports two engines: local whisper-cli (default) and Groq Whisper API (opt-in via GROQ_API_KEY); post-recording transcription is always local.
- Per-platform binaries, the setup script, and model auto-download live in the whisper-setup child route.
- Live phantom [Me] lines ("Okay.") are prevented by a frame-based speech gate plus Silero VAD on live local chunks (AUG-127; root cause AUG-126).
- Live repeated fragments come from the 1 s chunk overlap being decoded twice with no overlap dedup (AUG-126).
- With --vad, whisper.cpp stretches segment end times across skipped silence, so batch segment ends are unreliable (AUG-126).
- whisper-cli 1.8.4 JSON lacks no_speech_prob, so the merger no-speech gate is a no-op; token-level p is available and feeds the confidence score (AUG-126, AUG-152); the per-token p array is now kept on each segment as tokenProbs for the token-dip check (AUG-163).

This route governs how audio becomes a transcript: the whisper.cpp CLI wrapper, the TranscriptMerger cleanup pass, URL download, and the session states in between.

## Purpose

Document the exact mechanics of turning a recorded or uploaded audio file into a usable markdown transcript, and the filtering rules that keep whisper.cpp's known failure modes (hallucinated captions, looping, filler noise) out of the final output.

## Core Concepts

- whisper.cpp CLI wrapper: server/src/services/whisper.ts's runWhisper() is the shared spawner that invokes whisper-cli as a child process against a session's audio file; transcribe() calls it and maps the returned JSON into segments.
- TranscriptMerger: server/src/services/transcriptMerger.ts takes raw whisper.cpp segments and produces the cleaned transcript — filtering, deduplication, and join logic.
- Session lifecycle: a session's status field moves uploading → preparing → transcribing → completed, or preparing → failed / transcribing → failed. WAV uploads skip preparing. A failed session can be retranscribed, re-entering preparing or transcribing.
- Transcript rendering: the final transcript is markdown — a header followed by [HH:MM:SS] text lines (single-track) or [HH:MM:SS] [Me]/[Them] text lines (dual-track), one per merged segment.
- Transcript header lines are exactly "- Date:" and "- Duration:"; renderTranscript takes no offset parameter.
- The former "- Track offset: ±N ms" header (AUG-108) was removed as a user-facing technical detail; existing transcript.md files keep it until retranscribed.
- Dual-stream merge: mergeDualStream takes mic and system segments, tags them with roles (Me/Them), sorts chronologically, then applies the same dedup/join pipeline — joinAdjacentSameRole only joins segments with matching roles.
- Confidence score: runTranscription and runDualTranscription call semanticCheck.runSemanticPass({ tracks, utterances, dropped, audioDurationSec, language }) right after the merge, before status flips to completed; it calls computeConfidence({ tracks, dropped, audioDurationSec, language, perplexity }) and, when the local model is ready, runs perplexity and optional corrections inside withBatchSlot + withLocalLlm; any local-model failure falls back to the text-statistics score with detail.semantic.perplexityError set, and never fails the session (AUG-152, AUG-163).
- Merger drop count: mergeSingleStreamDetailed / mergeDualStreamDetailed return { utterances, dropped } where dropped = raw segments − segments kept by dedupHallucinations (filler, blacklist, repeats, no-speech gate); mergeSingleStream / mergeDualStream stay as wrappers (AUG-152).
- confidenceDetail { source, segments, dropped, coverage, lowLogProbShare, noSpeechBase, acousticScore, semantic { penalty, textFlaggedShare, pplFlaggedShare, loops, pplCeilingHit, perplexity { model, medianPpl, k, scored, skipped, ms }, perplexityError, segments[] (flagged only: track, index, start, end, flags, compressionRatio, oovRatio, stopWordRatio, wordsPerSec, tokenDips, perplexity) } } is a diagnostic kept in session.json and the server log only, never rendered in the UI (AUG-152, AUG-163).
- Perplexity method (AUG-163): llama-server does not echo prompt logprobs, so the segment is forced as the continuation of POST /v1/completions with a GBNF grammar `root ::= " <segment text>"`, temperature 0, logprobs 1; the raw logprob of each forced token is read back; the prompt must not end with a space (the literal starts with one) and the final empty-token entry (forced end, ≈ −16) is dropped.
- Corrections file: transcript.corrected.json = { version: 1, createdAt, model, items: [{ id, index (k-th timestamp line), start, role, original (the flagged segment text), suggested, status: pending | accepted | rejected }] }; POST /api/sessions/:id/corrections/:itemId { status } updates one item and rewrites transcript.corrected.md (transcript.md with accepted items applied: each replaces the first occurrence of its original inside its line); POST /api/sessions/:id/corrections/bulk { status: accepted | rejected } decides every pending item in one write (Accept all; registered before the :itemId route); GET /api/sessions/:id/corrections and GET /api/sessions/:id/transcript/corrected read them; both files are deleted when a new transcript is written (retranscription) (AUG-163).
- Process tracking: whisper.ts maintains a Map<string, ChildProcess[]> keyed by session ID. whisper-cli, ffmpeg (ensureWav), ffprobe (assertVideoHasAudio) and yt-dlp (via trackChildProcess, AUG-149) child processes are all registered under the session key and deregistered when they exit.
- Dual-track tracks run sequentially, so at most one batch whisper-cli process is registered and running at a time.
- Batch slot: transcribe() acquires a process-wide promise-chain slot in whisper.ts, so two sessions or two tracks never run GPU-backed whisper-cli concurrently.
- Cancellation generations: cancelTranscription(key) bumps a per-session generation; beginTranscriptionJob(key) returns an isCancelled check used by queued jobs and between the mic and system tracks.
- A cancelled job returns silently from its catch block, so a retranscribe started after the cancel is never marked failed by the old job.
- Cancellation: cancelTranscription(sessionId) kills all tracked child processes (whisper-cli, ffmpeg, ffprobe, yt-dlp) for that session. The cancel endpoint (POST /api/sessions/:id/cancel) accepts both "preparing" and "transcribing" states, calls cancelTranscription and sets status to "failed" with "Cancelled by user". The catch block in runTranscription/runDualTranscription/prepareAndTranscribe skips overwriting if status is already "failed" to avoid a race with the cancel endpoint.
- Failed-session recovery: when a session is in "failed" state, the UI shows a "Transcribe again" button with language and boost options. Clicking it calls POST /api/sessions/:id/retranscribe, which runs a preflight check (whisper-cli binary exists, model file exists) before flipping the session to "transcribing". If audio files are missing, the endpoint returns 400; for sessions stripped on the Archive page (audioDeletedAt, AUG-150) the message is "Audio was deleted — re-download it first" (sourceUrl) or "Audio was deleted — this session cannot be transcribed again", and the UI disables Redo and offers "Re-download audio" for link sessions. The header Redo node also triggers retranscription independently. When the auto-deleted WAV and its source are both gone (wavAutoDeletedAt set), the 400 message names the automatic removal and the confidence score and tells link sessions to re-download first (AUG-152).
- URL download flow: POST /api/sessions/from-url validates the URL (http/https only, no private hosts), creates a session with status "uploading" and sourceUrl set, responds immediately, then downloads in the background. Redirects are followed manually (≤5 hops) with URL re-validation at each hop. The file is saved as audio.{ext} in the session directory. On completion, the session enters "preparing" (non-WAV) or "transcribing" (WAV) via the standard pipeline.
- URL download progress: the server streams the download and updates session.downloadProgress (0–100) from Content-Length; the client polls and renders a progress bar with percentage in TranscriptView when session.sourceUrl is set.
- URL download cancellation: activeDownloads Map tracks per-session AbortControllers. The cancel endpoint accepts "uploading" status and aborts the download before falling through to cancelTranscription. The download error handler skips overwriting if status is already "failed" (same race-avoidance pattern as transcription cancel).
- Platform-link flow (AUG-149): startPlatformDownload in sessions.ts checks the yt-dlp binary (400 with an install hint when the resolved bundled/env path is missing), creates an "uploading" session titled "Video from <host>", then in the background: probePlatformVideo (yt-dlp --skip-download --write-info-json) → live/upcoming check → duration guard → title set from the video title → downloadPlatformAudio (--load-info-json, -f bestaudio/best, audio.%(ext)s) → status "preparing" → prepareAndTranscribe.
- yt-dlp progress: --progress-template prints "AUGPROG downloaded total estimate" lines on stdout; percent = downloaded / (total or estimate), capped at 99 until done, written at most every 500 ms.
- yt-dlp errors are mapped by classifyYtDlpError (ytDlp.ts) to plain messages: private, age-restricted, bot check, members-only, live, unsupported URL, unavailable, no audio format, network. Unknown errors fall back to "yt-dlp failed: <last ERROR line>".
- yt-dlp path resolution (config.ts resolveYtDlpPath): YTDLP_PATH env → yt-dlp(.exe) next to whisper-cli → bare yt-dlp on PATH. Packaged Electron sets YTDLP_PATH to resources/whisper/bin/<platform>/.
- Orphan recovery: recoverOrphanedSessions() runs on server startup — any session in "transcribing", "preparing", or "uploading" (with sourceUrl and no active download) state with no active tracked process is moved to "failed" with an explanatory error message.
- Transcription metadata: SessionMetadata includes transcriptionStartedAt (ISO timestamp) and estimatedDuration (seconds). For WAV uploads these are set synchronously in the endpoint; for non-WAV uploads they are set by prepareAndTranscribe after background extraction completes, just before whisper starts (AUG-147). The client shows a "Preparing audio…" shimmer bar until transcribing begins.
- Audio boost preprocessing: boostAudio() in whisper.ts applies an ffmpeg filter chain (highpass 100Hz, lowpass 4000Hz, 5x volume gain, loudnorm normalization) and converts to 16kHz mono WAV. Used when the retranscribe endpoint receives boost=true. Boosted files are saved as {basename}-boosted.wav next to the original.
- Boosted files are deleted only after a successful transcript and are kept after failure or cancel so a retry can reuse them.
- Video input (AUG-144): ensureWav treats .mp4/.mov (isVideoContainer in server/src/services/mediaFormats.ts) as video; it first probes for an audio stream with ffprobe (-select_streams a), then runs ffmpeg with -vn -sn -dn -ar 16000 -ac 1 pcm_s16le and a 600 s timeout (audio inputs keep 120 s).
- Video errors: no audio stream → "The video has no audio track — nothing to transcribe."; ffprobe or ffmpeg cannot read the container → "Could not read video file — it may be corrupt or incomplete."; raw ffmpeg stderr goes to the server log only.
- A video upload responds immediately with status "preparing" (AUG-147); ensureWav runs in the background and sets the session to "failed" with a plain-language error if extraction fails — the session then offers "Transcribe again".
- Client no-audio pre-check (AUG-146): FileUpload.tsx calls probeVideoHasAudio (client/src/services/videoAudioProbe.ts) for .mp4/.mov after the size check. It walks top-level box headers (32/64-bit sizes, max 100 boxes) to find moov (moov at start or end, max 64 MB read), then reads each trak → mdia → hdlr handler type. Result true = a 'soun' track exists, false = moov fully parsed with ≥1 trak and none 'soun', null = undecided.
- Only false blocks: the dropzone error shows "The video has no audio track — nothing to transcribe." (same text as the server) and no upload request or session is made. null (corrupt file, missing/compressed moov, trak without hdlr, any read error, >2 s timeout) uploads as before, so the server ffprobe check stays the safety net; a false "no audio" is worse than an unnecessary upload.
- The pre-check reads only box headers plus the moov box, never mdat, so it does not scale with file size (~3 ms on a 2 GB file in Node, AUG-146); no npm media dependency is used.
- Upload size limit (AUG-145): MAX_UPLOAD_BYTES (2 GB) is a named constant on both sides. Client FileUpload.tsx checks file.size before any network request and shows "File is too large (X.X GB). Maximum is 2 GB." Server routes/sessions.ts wraps the multer middleware in a callback that catches MulterError: LIMIT_FILE_SIZE → 413 JSON { error: "File is too large. Maximum is 2 GB." }, other multer errors → 400 JSON. The multer error fires before the route handler, so no session is created for oversized uploads.
- The single-track upload stores the source as audio.{lowercased ext}, so meeting.MOV becomes audio.mov and its derivative audio.wav.
- Derived WAV reuse: ensureWav and boostAudio reuse an existing output when it is non-empty and its mtime ≥ the source mtime.
- Derived WAVs are written to {basename}-partial.wav or {basename}-boosted-partial.wav and renamed, so a killed ffmpeg never leaves a truncated file that looks fresh.
- ffmpeg availability: checkFfmpegAvailable() probes ffmpeg at runtime. The /api/health endpoint reports ffmpegAvailable and ffmpegMessage (the shared FFMPEG_MISSING_MESSAGE when unavailable); the client disables the boost toggle when false. Server startup also logs FFMPEG_MISSING_MESSAGE as a pre-flight check. The retranscribe endpoint validates ffmpeg presence before accepting a boost request.
- Performance tracking: server/src/services/performanceTracker.ts records the ratio of processing seconds to audio seconds fed to whisper after each completed transcription (dual-track audio = mic + system).
- perf-stats.json entries carry pipeline: 2 and gpu: boolean; entries without pipeline 2 (pre-AUG-125) are ignored; the last 10 entries are kept, separated by single vs dual track.
- ETA estimation: estimatedDuration = (mic + system seconds) × median perf ratio for the current GPU/CPU mode; defaults are 0.03 for Metal/GPU and 0.16 for CPU.
- For WAV uploads, the endpoint computes estimatedDuration synchronously; for non-WAV uploads, prepareAndTranscribe computes it after extraction, and the client polls until the session enters "transcribing" to render the Chronometer Ring.
- Greedy decoding rationale: SplitVox measured beam search 1.6-3.4x slower with no quality gain; on Metal the encoder dominates so the gain is small, on CPU it is large.
- VAD: runWhisper adds --vad --vad-model only when opts.vad is set (transcribe() and live transcribeChunk() both set it, AUG-127) and the model file exists; a missing model logs one warning and transcribes without VAD.
- VAD model path: config.whisperVadModelPath = WHISPER_VAD_MODEL_PATH env, else ggml-silero-v5.1.2.bin next to whisper-cli.
- session.json optional fields trackDurations {mic, system} (seconds, ffprobe of the 16 kHz WAVs) and trackWarning (string) exist for dual-track sessions only; both are backward compatible.
- prepareDualTracks() in routes/sessions.ts converts and measures both tracks, then sets duration, estimatedDuration, trackDurations and trackWarning before the response. Dual-track uploads stay synchronous (AUG-147: only single-track non-WAV uploads use the preparing phase).
- Completion duration for dual-track = max(alignedDualDuration from trackDurations, last utterance end).
- Long single [Them] lines are expected when the mic track is silent or missing: joinAdjacentSameRole joins same-role segments closer than 2 s.
- Chronometer Ring UI: during transcribing state, the client renders a circular SVG progress ring with a requestAnimationFrame-driven MM:SS:mm countdown. Three visual phases: amber (normal), red (< 60 seconds remaining), zeroed (0:00:00 with "Exterminatus Initiated" banner and pulsing digits).

## Components

- confidenceScore (component): part of the August server; computes confidenceScore from whisper segment probabilities and TranscriptMerger drop counts (AUG-152).
- sessions route (component): depends on semanticCheck, confidenceScore, transcriptCorrections and sessionManager.autoDeleteDerivedWavs after each batch transcription (AUG-152, AUG-163).
- TranscriptMerger (component): part of the August server; mergeSingleStreamDetailed / mergeDualStreamDetailed report the drop count that confidenceScore uses (AUG-152).
- textStats (component): part of the August server; used by confidenceScore for the always-on semantic flags (AUG-163).
- semanticCheck (component): part of the August server; depends on llmServer (withLocalLlm), llmClient (complete, chat), confidenceScore and whisper.withBatchSlot (AUG-163).
- transcriptCorrections (component): part of the August server; used by the sessions route to read and write transcript.corrected.json / .md (AUG-163).

## Invariants

- TranscriptMerger constants are copied exactly from SplitVox's original C# implementation — never re-tune them without re-validating against known reference audio.
- FILLER_ONLY_TEXTS are dropped outright: blank audio, silence, music, typing, inaudible, no audio, background noise.
- HALLUCINATION_BLACKLIST phrases (e.g. "thank you", "thanks for watching") are dropped, plus a co-occurrence check that drops Russian subtitles-credit hallucinations when both "субтитры" and "dimatorzok" appear.
- The "Редактор субтитров А.Семкин Корректор А.Егорова" credit-line hallucination is handled by stripCreditHallucination (regex-based, case-insensitive, spacing/punctuation-tolerant) which replaces matched fragments with [OOPS] — not silently dropped like HALLUCINATION_BLACKLIST entries.
- stripCreditLines runs before dedupHallucinations in both mergeSingleStream and mergeDualStream, so [OOPS]-replaced segments participate correctly in dedup and join.
- The credit-line detection covers three patterns applied in order: full line (both halves), first half only ("Редактор субтитров" + "Семкин"), second half only ("Корректор" + "Егорова").
- Live transcription applies stripCreditHallucination to each chunk after the isLikelyFiller check, matching batch behavior.
- JOIN_GAP_THRESHOLD = 2.0 seconds — segments closer together than this are joined into one line.
- joinAdjacentSameRole respects the role field — segments are only joined when they share the same role AND are within the gap threshold.
- DEDUP_WINDOW = 30.0 seconds — near-duplicate text within this window is collapsed to one segment.
- NO_SPEECH_PROB_THRESHOLD = 0.6 — segments at or above this whisper.cpp no-speech probability are dropped.
- The no-speech gate drops a segment only when no_speech_prob is high AND the text is blacklisted; in practice it is a no-op because whisper-cli 1.8.4 JSON has no such field (re-verified for AUG-152, upstream master included).
- confidenceScore and confidenceDetail are reset to undefined when a retranscription starts and recomputed on completion, so a failed re-run never shows a stale score (AUG-152), and retranscription deletes transcript.corrected.json / .md when the new transcript is written (AUG-163).
- Auto-deletion runs only after transcript.md is written and the boosted WAVs are removed; its errors are logged and never fail the session (AUG-152).
- Auto-deletion skips -boosted / -partial WAVs and any WAV without a same-basename non-WAV sibling, so a direct .wav upload and server-captured audio-system.wav always survive (AUG-152).
- Auto-deleted files are recorded in session.audioDeletedFiles with auto: true and session.wavAutoDeletedAt is set; audioDeletedAt stays unset, so Redo stays enabled and findAudioFiles picks the remaining source (AUG-152).
- A confidence below the threshold keeps audio.wav and logs "keeping audio.wav"; the threshold is read from user-preferences.json at completion time, not at upload time (AUG-152).
- dedupHallucinations in mergeDualStream compares against the previous kept segment of any role, so an identical [Me] reply after [Them] within 30 s is dropped.
- --max-context 0 on every invocation.
- GPU flag per services/gpuBackend.ts: Metal on Apple Silicon, CUDA on Windows x64 when gpuEngine='cuda', CPU otherwise; automatic CPU fallback on Metal/CUDA; WHISPER_USE_GPU=0|1 pins it.
- Non-GPU whisper failures (bad audio, missing model, cancellation, timeout) are never retried — classification lives in classifyWhisperFailure() and must stay conservative.
- All whisper-cli spawning goes through runWhisper() — never duplicate invocation logic in callers.
- ffmpeg-missing errors use the shared FFMPEG_MISSING_MESSAGE with per-platform install commands.
- Transcription and audio extraction both run as background processes — the API never blocks a request waiting for ffmpeg or whisper-cli to finish (AUG-147).
- Timer metadata (transcriptionStartedAt, duration, estimatedDuration) must be set before whisper starts: for WAV uploads, synchronously in the endpoint; for non-WAV uploads, by prepareAndTranscribe after extraction completes. The Chronometer Ring appears once the session enters "transcribing" (AUG-147).
- Retranscription reuses the session's existing audio file but allows a language override — the session's language field is updated to the chosen language.
- Retranscription defaults to Russian ('ru') when no language is explicitly specified in the request body.
- Retranscription cancels any active transcription for the session before starting a new one.
- Audio boost filter parameters are centralized in AUDIO_BOOST config (server/src/config.ts) — never hardcode filter values in the ffmpeg call.
- Boosted audio files ({basename}-boosted.wav) are deleted only after a successful transcript, never in a finally block, and survive failure or cancel for reuse.
- Single-track boost runs boostAudio on the ensureWav output (runTranscription), so a video source never reaches the loudnorm chain (AUG-144); dual-track boost still runs boostAudio on the source tracks.
- The retranscribe API (POST /api/sessions/:id/retranscribe) accepts an optional boost boolean; when true, ffmpeg availability is validated before proceeding.
- The retranscribe endpoint validates whisper-cli and model presence before setting status to "transcribing" — prevents flip-then-fail loops.
- If the whisper model is mid-download, the retranscribe preflight returns the download percentage in the error message.
- A failed transcription never deletes or modifies the session's audio files; an uploaded video stays in the session folder and the extracted WAV is a derivative next to it.
- Completed sessions are never auto-deleted, regardless of duration; only an explicit DELETE /api/sessions/:id removes a session (AUG-121).
- When a failed session has no audio files on disk, the UI disables the "Transcribe again" button and shows an explanatory message.
- For dual-track sessions with boost enabled, ffmpeg boosts both mic and system tracks independently in parallel, but whisper itself still runs the tracks sequentially.
- The client renders a Chronometer Ring (Tomb Amber SVG progress ring) with MM:SS:mm countdown, elapsed time, and ETA during the transcribing state.
- The Chronometer Ring transitions from amber to red (#e05555) when < 60 seconds remain, and shows pulsing zeroed digits with "Exterminatus Initiated" at 0:00:00.
- When estimatedDuration is not available (no perf-stats.json yet), the client falls back to the original indeterminate shimmer bar.
- performanceTracker stores at most 10 entries, separates single-track from dual-track ratios, separates gpu from cpu ratios, and ignores entries without pipeline 2 — never mix them for estimation.
- Never run two batch whisper-cli processes at once; post-recording work goes through transcribe() and its batch slot.
- Never flip GpuState to CPU on a missing ggml_vulkan banner unless the build is Vulkan.
- Dual-track duration is computed from both tracks, never from the mic WAV alone.
- ETA inputs are the summed track seconds, never the transcript length.
- Keep --max-context 0 and greedy decoding on every invocation, including live chunks.
- The Cancel button calls POST /api/sessions/:id/cancel and works during "uploading" (URL download), "preparing", and "transcribing" phases; the Restart button reuses the retranscribe endpoint with a language selection dropdown.
- URL downloads accept only http and https schemes; all other protocols are rejected by validateUrl in urlDownloader.ts.
- Private, loopback, and link-local addresses (127.x, 10.x, 172.16–31.x, 192.168.x, 169.254.x, ::1, fe80:, fc/fd, ::) are blocked at every URL validation — initial URL and each redirect target.
- URL redirect following is manual (fetch with redirect:'manual'); the cap is 5 redirects; each Location is re-parsed and re-validated against the private-host blocklist.
- HTML responses (text/html, application/xhtml+xml) are rejected with "This link is not a direct media file — download it and upload the file instead."
- URL downloads enforce the same 2 GB cap as file uploads: Content-Length pre-check and a streaming byte counter that aborts on overflow.
- URL download stall timeout: 60 seconds of no data aborts the download; the timer resets on each received chunk.
- Retranscribe on a URL-sourced session reuses the downloaded audio file without re-downloading; findAudioFiles finds audio.{ext}. Only after the audio was deleted on the Archive page does POST /api/sessions/:id/redownload fetch it again (restores audio only; a session with a transcript returns to completed without re-transcribing — AUG-150).
- Deleting audio on the Archive page (DELETE /api/sessions/:id/audio) is refused with 409 while the session is uploading, preparing or transcribing, so a running job never loses its input (AUG-150).
- Orphan recovery covers URL downloads: sessions in "uploading" with sourceUrl and no activeDownloads entry are moved to "failed" on startup.
- The from-url endpoint is placed before parameterized /:id routes in Express to prevent "from-url" matching as a session ID.
- Platform links never reach urlDownloader.ts, and the direct-download path stays unchanged for every other URL. Only hosts listed in PLATFORM_HOSTS (exact or subdomain match) go to yt-dlp; to support another yt-dlp site, add its host there.
- The duration guard runs on probe metadata, before any media is downloaded. The limit is YTDLP_MAX_DURATION_HOURS (default 4 h, config.ytDlpMaxDurationSec). Live streams and upcoming premieres are rejected.
- yt-dlp always runs with --ignore-config and --no-playlist; it gets --ffmpeg-location when config.ffmpegPath is absolute (bundled/env ffmpeg).
- A failed or cancelled yt-dlp download deletes every audio.* file in the session dir, so retranscribe never picks up a partial .part file. The info JSON is deleted after the download attempt.
- Download progress writes to session.json (direct and platform paths) are chained, never fired in parallel, and awaited before the next status update. updateSession is read-modify-write, and overlapping writes on a short video left the status update reading truncated JSON ("Unexpected end of JSON input", found in AUG-149).

## Benchmarks (AUG-125)

- Reference session a49e4b18 (dual-track, mic 971.7 s, system 3257.2 s, 70 min audio total), M3 Pro 12 cores, Metal, whisper.cpp 1.8.4, ggml-large-v3-turbo-q8_0.
- Baseline Metal (beam 5, mic+system in parallel): 169 s wall-clock.
- Greedy + sequential: 163 s.
- Greedy + VAD + sequential, q8_0: 117-127 s (three runs; chosen pipeline).
- Greedy + VAD + sequential, f16 ggml-large-v3-turbo: 137 s, so q8_0 stays the model.
- Greedy + VAD + sequential with --no-flash-attn: 145 s, so flash attention stays on (whisper-cli default).
- Greedy + VAD with the two tracks in parallel: 114 s; sequential was kept to avoid two GPU contexts and CPU thread oversubscription on Windows Vulkan/CPU.
- 4 vs 11 threads on Metal: 118 s vs 117 s, no difference, so threadCount() stays cpu-1.
- Metal speedup of the new pipeline over the baseline is 1.3-1.4x; the ≥3x target is not reached on Metal because the encoder dominates on dense speech.
- CPU baseline (--no-gpu, beam 5, parallel): the 16-min mic track alone took 1584 s; the full session was not run to completion (>1 h).
- CPU new pipeline: mic track 22 s (VAD skips silence); a 300 s dense-speech system slice 48 s (ratio 0.16).
- End-to-end retranscribe of a copy of the reference session: 130 s actual vs 127 s estimatedDuration; max one whisper-cli process; duration 00:54:17; last [Them] text ends at 3257 s.
- Quality spot-check: greedy+VAD keeps equal [Them] word coverage per 5-min bucket (7177 vs 7276 words) and removes baseline hallucinations ("Thank you." every 30 s, an 8x repetition loop on the mic track).

## Root Causes (AUG-125)

- Slow transcription on macOS: runWhisper flipped GpuState to CPU after any GPU run whose stderr lacked the ggml_vulkan device banner, which Metal never prints.
- Every macOS job after the first one in a server run therefore ran with --no-gpu (log line "whisper-cli found no Vulkan device ... runs on CPU").
- Fix: ranOnCpuWithoutVulkanDevice() in gpuBackend.ts applies the banner rule to Vulkan builds only.
- Mic 16:11 vs system 54:17 in session a49e4b18: server capture started 16:00:02Z and the upload came at 16:58Z, so the call really lasted about 54 minutes.
- The mic webm packets are contiguous up to 971.6 s and then stop, while the system track has speech throughout; the mic device track stopped delivering audio mid-call (device switch/disconnect) and Chromium's MediaRecorder stopped advancing without firing stop.
- Fix (client FileUpload.tsx): the mic is recorded through a Web Audio graph (MediaStreamAudioDestinationNode) that keeps producing silence, so the mic file keeps wall-clock length.
- When the mic track fires 'ended', the recorder re-acquires the same mic or the default one, reconnects it to the graph and shows a mic notice.
- If the AudioContext cannot run (autoplay policy in a plain browser tab), recording falls back to the raw mic track.

## Route-Specific Constraints

- Never call a third-party speech-to-text API as a fallback or supplement to whisper.cpp — see project-context/architecture/README.md invariants.
- Timestamp offsets from whisper-cli --output-json-full in this build are milliseconds — convert correctly before formatting [HH:MM:SS] lines.
- On Windows, non-ASCII paths must be converted to 8.3 short paths via toSafePath; toSafePath is a passthrough on macOS.
- Dual-track sessions store audio as audio-mic.{ext} and audio-system.{ext}; single-track sessions store audio as audio.{ext}.
- alignDualSegments shifts the later-starting track forward by |systemOffsetMs| (positive → system segments, negative → mic segments) so the earlier track defines t=0; segments are clamped at 0.
- systemOffsetMs comes only from the server-capture upload path (captureId + micStartedAt); it is absent (treated as 0) for browser dual recordings and file uploads.
- Retranscribe re-applies the stored systemOffsetMs — never recompute it from file durations.
- Never add diagnostic lines (offsets, engine names, timings) to the transcript header; put such data in session.json metadata instead.
- ensureWav derives the output filename from the input basename — never hardcode audio.wav, which would collide in dual-track sessions.
- Boosted filenames use the pattern {basename}-boosted.wav — findAudioFiles must never match these as original audio (verified: startsWith('audio.') / 'audio-mic.' / 'audio-system.' excludes '-boosted' variants).
- On Windows, boostAudio passes only its existing input through toSafePath; the output (-partial.wav) path stays raw because cmd.exe returns a mangled 8.3 name for a file that does not exist yet, which made the rename fail on Cyrillic paths (found in AUG-144). ffmpeg writes non-ASCII paths natively, so ensureWav passes raw paths.
- The server does not reject uploads by extension: browser recordings (.webm/.ogg/.mp4) share the endpoint; the client ACCEPTED_EXTENSIONS list mirrors UPLOAD_EXTENSIONS in server/src/services/mediaFormats.ts, enforced by mediaFormats.test.ts.
- The multer limit stays 2 GB (MAX_UPLOAD_BYTES): enough for a ~1 h 1080p Zoom/Teams export (~1-2 Mbps, ~0.5-0.9 GB/h), not for a ~1 h QuickTime 1080p screen recording (~10-20 Mbps, ~4.5-9 GB/h) (estimate, AUG-144). The limit is enforced twice: client pre-check (no upload attempt) and server multer handler (HTTP 413 JSON). Both constants must stay in sync (AUG-145).
- Do not lower or raise the 2 GB limit without a product decision; local-path import for larger files is a separate feature.
- Never parse titles or file paths from yt-dlp stdout. On Windows the PyInstaller build writes stdout in the ANSI codepage (cp1251) even with PYTHONIOENCODING=utf-8 (verified in AUG-149). Metadata comes from the UTF-8 ytdlp-info.info.json file, and only the extension is printed (AUGEXT).
- yt-dlp only downloads audio. Transcription stays local whisper, and neither the URL nor the audio goes to any transcription service. Downloading from video sites may conflict with their terms of service (e.g. YouTube's); the caveat is documented in README.md.
- Do not patch or rebuild whisper-cli to export no_speech_prob / avg_logprob: Windows CPU and CUDA builds are pinned prebuilt release zips and macOS builds the same tag from source; the confidence score must keep working from token p (AUG-152).
- CONFIDENCE weights (40 / 30 / 30, logprob floor −1.0, coverage floor 0.5) and SEMANTIC weights (40 / 30 / 15 per loop max 30 / 25 above median PPL 600, cap 50) live in server/src/services/confidenceScore.ts; re-tune only against known audio and keep the computation server-side (AUG-152, AUG-163).
- SEMANTIC (confidenceScore.ts), TEXT_STATS (textStats.ts), PERPLEXITY and CORRECTIONS (semanticCheck.ts) constants are frozen with 'do not retune without re-validating'; validation on reference audio (AUG-163, Qwen2.5-3B): clean ru 100 → 93, ru audio decoded as en 91 → 63, synthetic loop 100 → 78, junk mic recording 100 → 78.
- Known false positives (AUG-163): proper names and game/brand terms raise the OOV and perplexity flags on clean speech (≈ −7 points on a clean ru clip); the 3B model's meaning fixes are often wrong (e.g. names 'corrected'), which is why every fix is a suggestion that needs Accept.
- Auto-deletion must never remove a source file (audio.webm/.m4a/.mp4, audio-mic.webm, audio-system.wav, a direct .wav upload); only derived WAVs with a non-WAV sibling qualify (AUG-152).

## Key files

- server/src/services/confidenceScore.ts — computeConfidence, CONFIDENCE and SEMANTIC weights (AUG-152, AUG-163).
- server/src/services/textStats.ts — per-segment text statistics and TEXT_STATS thresholds (AUG-163).
- server/src/services/semanticCheck.ts — runSemanticPass, scorePerplexity, buildCorrectionTargets, suggestCorrections, acceptSuggestion (AUG-163).
- server/src/services/transcriptCorrections.ts — applyCorrections / applyItemsToText and the corrections files (AUG-163).
- server/src/scripts/semanticValidate.ts — before/after score validation on a WAV (AUG-163).
- server/src/services/whisper.ts — runWhisper (single whisper-cli invocation), flags, JSON parsing, avgLogProbFromTokens (AUG-152), ffmpeg helpers.
- server/src/routes/sessions.ts — session API endpoints including upload and retranscribe.
- server/src/services/mediaFormats.ts — accepted upload extensions, video detection, ffprobe audio-stream classification and video error messages.
- server/src/services/transcriptMerger.ts — filtering, dedup, join, and markdown rendering logic; mergeSingleStreamDetailed / mergeDualStreamDetailed report merger drops (AUG-152); also holds alignedDualDuration and describeTrackMismatch.
- server/src/services/gpuBackend.ts — GPU policy, fallback, and the Vulkan-only banner rule.
- client/src/components/FileUpload.tsx — mic Web Audio recording graph with re-acquire on 'ended'; ACCEPTED_EXTENSIONS for the dropzone, picker and formats hint; runs the video no-audio pre-check before upload.
- client/src/services/videoAudioProbe.ts — probeVideoHasAudio (MP4/MOV moov/hdlr parser, true/false/null), isVideoFile, NO_AUDIO_MESSAGE (AUG-146).
- server/src/services/urlDownloader.ts — URL validation, SSRF protection, manual redirect following, Content-Type/extension checks, streaming download with progress and abort (AUG-148).
- server/src/services/ytDlp.ts — PLATFORM_HOSTS / isPlatformUrl, yt-dlp spawn with process tracking, probePlatformVideo, downloadPlatformAudio, classifyYtDlpError (AUG-149).
- client/src/components/TranscriptView.tsx — shows the session.trackWarning notice and URL download progress bar.
- server/src/services/performanceTracker.ts — rolling speed ratio tracking and ETA estimation.

## Child Routes

### Live Transcription
Real-time WebSocket-based transcription during a live call — chunked audio capture, server-side whisper invocation, and a slide-out transcript panel.
Directory Path: project-context/transcription/live-transcription/

### Whisper Setup
Per-platform whisper-cli binaries, the npm run setup script, model auto-download with SHA256 verification and SSE progress, and ffmpeg pre-flight.
Directory Path: project-context/transcription/whisper-setup/

### Phantom Lines Research
AUG-126 research: root causes of phantom mic lines and repeated phrases, filter coverage per path, and ranked fixes.
Directory Path: project-context/transcription/phantom-lines-research/

### Semantic Confidence Research
AUG-161 research behind AUG-163: why confidenceScore was blind to text meaning, local and cloud options with costs; L1/L2 text statistics and L4 perplexity are implemented (AUG-163).
Directory Path: project-context/transcription/semantic-confidence-research/
