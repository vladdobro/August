# Research: phantom lines and repeated phrases in dual-track transcripts (AUG-126)

> Date: 2026-10-05 · Status: research only — no production code changed · Platforms: macOS + Windows
> Follow-up: fixes 1, 2 and 6 implemented in AUG-127 — see project-context/transcription/live-transcription/README.md.

## TL;DR

- The sample came from the LIVE panel (Groq engine, macOS, headphones) — confirmed by the user. Live text is never persisted; saved transcript.md always comes from the batch path.
- Phantom [Me] lines ("Okay.", "Blessings.", "*thinks*"): live mic windows pass the whole-window RMS gate because of a short transient (click/breath) in an otherwise near-silent 4 s window; live has no VAD and no no-speech check, so whisper hallucinates short high-prior phrases; the blacklist does not contain them.
- Repeated [Them] fragments ("the report. the report."): the live chunker carries 1 s of overlap into the next 4 s window, both windows are decoded, and the text is appended with no overlap dedup. Not caused by TranscriptMerger (not on the live path) and not mainly by whisper looping.
- Speaker bleed is ruled out for the headphone sample; it does exist in another session (speakers or loud headphones) and causes a mic-side repetition loop.
- Top fixes: Silero VAD / frame-based speech gate for live chunks, overlap dedup per speaker, Groq verbose_json no-speech gate.

## Pipeline map

| Path | Chunking | whisper flags | VAD | Speech gate | Filters | Dedup |
|---|---|---|---|---|---|---|
| Batch post-recording + retranscribe (`server/src/routes/sessions.ts` runDualTranscription → `transcribe()` in `server/src/services/whisper.ts` → alignDualSegments → mergeDualStream in `server/src/services/transcriptMerger.ts`) | Whole track, mic then system sequentially in one batch slot | `--max-context 0 --beam-size 1 --best-of 1 --vad --vad-model ggml-silero-v5.1.2.bin --output-json-full` (+ `--no-gpu` on CPU) | Silero, default params (threshold 0.5, min speech 250 ms, min silence 100 ms, pad 30 ms) | none | FILLER_ONLY_TEXTS, HALLUCINATION_BLACKLIST, credit-line strip, no-speech gate | Exact normalized whole-segment repeat vs previous kept segment within 30 s |
| Live local (`server/src/services/liveTranscription.ts` transcribeChunk → runWhisper without `vad`) | 4 s windows, 1 s overlap (ChunkAccumulator in `client/src/services/liveTranscriptionClient.ts` for browser mic/system, `server/src/services/liveChunking.ts` for server-captured system) | Same flags minus `--vad` | none | Whole-window RMS > 0.006 | isLikelyFiller (FILLER + blacklist on the whole chunk text) + credit strip | none |
| Live Groq (`server/src/services/groqTranscription.ts`, model whisper-large-v3, `response_format=text`) | Same chunking | n/a (API) | none | Same RMS gate | Same as live local | none. On rate limit (20 req/min) each overflow chunk falls back to local whisper (no VAD) |

- Mic capture: getUserMedia `{audio: true}` / deviceId only, so Chromium defaults apply (echo cancellation, noise suppression, AGC on). Chromium AEC cancels only audio Chromium itself plays, not Zoom/Teams output (inferred from Chromium behavior, not measured).
- whisper-cli 1.8.4 JSON per segment has only `timestamps, offsets, text, tokens` (verified) — no `no_speech_prob`, so the merger's no-speech gate is a no-op; token-level `p` IS available.
- Rate budget: 3 s hop per track = 20 windows/min/track. In the measured slice 92% of system windows and 5% of mic windows pass the gate → ~19–20 req/min, at the Groq limit, so a "Groq" live session is in practice a Groq + local mix.

## Evidence

### Method

- Session e1ebe18a (dual-track, 3 h 16 min, en, systemOffsetMs −386, mic 11789.5 s / system 11790.2 s) copied to a scratchpad; M3 Pro, Metal, whisper.cpp 1.8.4, ggml-large-v3-turbo-q8_0.
- (1) Batch flags replayed on both tracks (mic 135 raw segments; system 1120 raw segments, 279 s wall) and merged with the production mergeDualStream via tsx.
- (2) Live replay: a Python port of ChunkAccumulator (4 s / 1 s / RMS 0.006) over mic 1300–1900 s and system 1300–1420 s, each passing window decoded with the live-local flags, then again with `--vad` and with `--suppress-nst`.
- (3) Per-segment mic RMS, aligned system RMS and mic-vs-system 10 ms-envelope correlation (±300 ms lag) as a bleed score.
- Groq was not called (local-only constraint); local large-v3-turbo is the proxy, so "Blessings."/"*thinks*" were not reproduced literally.

### Phantom mic lines

- Mic slice 1300–1900 s (user mostly silent, others talking): 199 windows, 10 pass the gate (5%). Mic 100 ms frame RMS percentiles p10/p50/p90/p99 = 0.00003 / 0.00006 / 0.00039 / 0.065 (near-digital silence between words, inferred to be Chromium noise suppression).
- Passing windows: median frame RMS 0.0041 vs median loudest frame 0.13 → one short transient lifts the whole-window RMS over 0.006.

| Window t (s) | Window RMS | Live-local output | With --vad | With --suppress-nst |
|---|---|---|---|---|
| 1312 | 0.046 | "Okay." | (empty) | "Okay." |
| 1330 | 0.0062 | "Okay." | (empty) | "Okay." |
| 1315 | 0.034 | "Thank you." (blacklisted) | "Yes." | "Thank you." |
| 1864–1879 (real speech) | 0.04–0.09 | kept | kept | kept |

- VAD removed both phantom "Okay." windows and kept all real speech.
- `--suppress-nst` has no effect.
- No bleed (envelope correlation median 0.08 over all 135 batch mic segments).

### Repeated fragments

- System slice: 33 adjacent decoded window pairs, 16 (48%) start with an exact repeat of the previous window's last 1–5 words; most of the rest are fuzzy repeats.
- Examples (consecutive windows):
  - "…I mean, you come in with the" → "you come in with the well-architected review,"
  - "…you could definitely ask" → "definitely ask what should be in here…"
  - "…all that stuff." → "that stuff and we can help them…"
  - "…That's definitely the key." → "that's definitely the case." (fuzzy)
  - "…blah, blah, blah." → "blah blah blah so develop policies based on your" → "based on your organization requirements."
- Mic shows the same: "Hey, Timur, it looks like we can" → "it's like we can finish our conversation".
- Batch is not affected: the merger only runs on batch output, which has no chunk overlap.

### Other findings (batch)

- Bleed exists in this session: mic segments at 7315–7346 s have envelope correlation 0.65–0.91 with the system track at mic RMS 0.06–0.10; whisper looped there ("He said yes." ×5). Not the headphone sample's cause.
- VAD timestamp stretching: 18 of 135 mic segments last > 30 s (max 3370 s, "It's pretty good idea, yeah." 3333→6703 s) — whisper.cpp maps segment ends across skipped silence. In this run it did not wrongly join lines because [Them] lines interleave, but end times are unreliable.
- dedupHallucinations in mergeDualStream compares against the previous kept segment of ANY role, so a real [Me] "Okay." right after an identical [Them] "Okay." within 30 s is dropped.
- Batch [Me] still keeps sound annotations such as "*Chuckles*" (seen in session a49e4b18).

## Filter coverage and gaps

| Check | Batch | Live local | Live Groq |
|---|---|---|---|
| Silero VAD | yes | no | no |
| Speech gate | n/a | whole-window RMS 0.006 | same |
| FILLER_ONLY_TEXTS + blacklist | per segment | whole chunk text | whole chunk text |
| Credit-line strip | yes | yes | yes |
| No-speech probability | no-op (field absent) | none | none (response_format=text drops it) |
| Consecutive-repeat dedup | yes (30 s, cross-role) | no | no |
| Overlap dedup | n/a | no | no |

- "okay", "so", "bless", "blessings" and asterisk sound events ("*thinks*", "*crash*", "*Chuckles*") are in no list.
- Filters match only the whole normalized text, so "Okay. Okay." passes.
- Live has no state between chunks.

## Proposed fixes (ranked by impact / effort)

| # | Fix | Impact | Effort | Target files | macOS / Windows |
|---|---|---|---|---|---|
| 1 | Run Silero VAD on live-local chunks (`vad: true` in transcribeChunk); skip the chunk when VAD finds no speech | High (removed 2/2 phantoms in repro) | Low | `server/src/services/liveTranscription.ts` | Same on both: VAD model bundled next to whisper-cli on darwin-arm64 and win-x64; ~1 MB model, small per-chunk cost on Metal/Vulkan/CPU |
| 2 | Frame-based speech gate instead of whole-window RMS: require ≥ ~300 ms of 20–30 ms frames above threshold before sending; applies to Groq too | High | Low | `client/src/services/liveTranscriptionClient.ts` + `server/src/services/liveChunking.ts` (keep both ports identical) + `liveChunking.test.ts` | Platform-neutral JS; also cuts Groq requests |
| 3 | Overlap dedup per speaker: preferred — use token timestamps (local JSON tokens / Groq verbose_json words) and drop words that start inside the first 1 s when the previous window was emitted; fallback — fuzzy suffix/prefix word overlap (≤ 8 words, normalized, 1 mismatch allowed) | High | Medium | `server/src/services/liveTranscription.ts` (per-connection Map<Speaker, lastText>) | Platform-neutral |
| 4 | Groq: request `response_format=verbose_json` and drop segments with no_speech_prob > 0.6 (and/or avg_logprob < −1) — field availability per Groq docs, verify before implementing (inferred) | High for Groq | Low | `server/src/services/groqTranscription.ts` | Network path only; same on both |
| 5 | Shared low-confidence rule: drop sound-event text matching `^\*[^*]+\*$` and ≤ 2-word mic utterances whose mean token p < ~0.5 (local JSON) | Medium | Low | `server/src/services/transcriptMerger.ts` (+ reuse in live) | Platform-neutral; thresholds must be validated on reference audio (merger constants are a SplitVox port) |
| 6 | Groq rate budget: check that fixes 1–2 keep live traffic under 20 req/min; otherwise larger windows for Groq | Medium | Low | `server/src/services/liveTranscription.ts`, `groqTranscription.ts` | Same |
| 7 | Batch: clamp VAD-stretched segment ends from token timestamps; make consecutive-repeat dedup role-aware in mergeDualStream | Low–Medium | Medium | `server/src/services/whisper.ts`, `transcriptMerger.ts` | Same; re-validate on reference session a49e4b18 |
| 8 | Mic/system bleed suppression: drop a [Me] segment when its envelope correlates > 0.8 with the time-aligned system track and a [Them] segment overlaps | Low for headphone users, Medium for speaker users | Medium–High | new helper near `transcriptMerger.ts` (batch) | System track source differs (macOS audiotee / Windows WASAPI helper) but the comparison runs on the 16 kHz WAVs, so the logic is shared |

Not recommended: `--suppress-nst` (no effect in repro), raising the RMS threshold alone (real quiet speech near 0.006–0.01 would be lost).

## Recommended follow-up tasks (not created)

1. Live: Silero VAD + frame-based speech gate for live chunks (fixes 1, 2, 6).
2. Live: per-speaker overlap dedup using token timestamps (fix 3).
3. Groq: verbose_json no-speech gate (fix 4).
4. Shared filter: sound-event + low-confidence short-utterance rule, validated on reference audio (fix 5).
5. Batch: VAD end-time clamp + role-aware dedup (fix 7).
6. Optional: bleed suppression heuristic (fix 8).

## Open questions

- Groq large-v3 was not run (local-only constraint); its hallucination set ("Blessings.", "*thinks*") is inferred from the sample, not reproduced.
- Live system source for the sample (browser tap vs server capture) is unknown; both use the same 4 s / 1 s chunker, so the conclusion holds either way.
