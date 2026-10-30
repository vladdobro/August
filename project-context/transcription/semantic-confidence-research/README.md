# Semantic Confidence & Transcript Post-Processing Research (AUG-161)

> Research (AUG-161). Implemented by AUG-163: L1+L2 text statistics (textStats.ts), L4 perplexity on the AUG-162 local model (Qwen2.5 1.5B/3B via llama-server, not the 0.5B proposed here) and confidence-gated local meaning corrections shown as Accept/Reject suggestions (L5 in a guarded form, despite the 'not recommended' verdict below). Thresholds and validation results live in project-context/transcription/README.md. Zero-cost constraint: only local solutions and the Groq free tier are considered; paid APIs and paid tiers are out of scope. Figures marked "reported" come from third-party sources or model cards fetched 2026-10-30 and must be re-verified before a task is created.

## TL;DR

- confidenceScore (server/src/services/confidenceScore.ts, AUG-152) is purely acoustic/decoder-side: it never looks at the words. A fluent-sounding hallucination, a repetition loop, or text decoded in the wrong language can score high.
- The app has no translation step (no `--translate`; nothing in server/src or client/src translates). The task's "after translation the text becomes word salad" is read as: whisper decoding a non-target or mixed language under `--language auto`, or a future translation feature. Semantic scoring of the final text covers both cases.
- Two tracks evaluated, both zero-cost: local (offline) and cloud limited to the Groq LLM free tier through the existing GROQ_API_KEY infrastructure; paid APIs and paid tiers are out of scope.
- Highest value per cost: a zero-model "text statistics" layer (gzip compression ratio, out-of-vocabulary ratio, words-per-second, local token-probability contrasts) added to the existing formula — < 10 MB, < 50 ms, both platforms.
- Best true semantic signal that fits the ~874 MB whisper budget: perplexity from a ~0.5B GGUF model (Qwen2.5-0.5B-Instruct Q4_K_M, 491 MB) run through a llama.cpp release binary spawned exactly like whisper-cli; opt-in download like the CUDA engine.
- Only cloud option: Groq `llama-3.1-8b-instant` on the free tier (reported 30 RPM, 6K TPM, 500K TPD), gated to low-confidence segments only; must stay opt-in behind the existing Groq key because transcript text leaves the machine.
- Local generative correction is not recommended: ≤ 1B models fabricate content, ≥ 1.5B models blow the disk/RAM budget (Phi-3.5-mini Q4_K_M is 2.39 GB).
- The auto-delete-WAV gate (AUG-152) is the only destructive consumer of the score; any semantic term must only lower the score, never raise it, until validated on labelled sessions.
- Ranked shortlist: (1) text-statistics layer, (2) local 0.5B perplexity, (3) Groq confidence-gated correction, (4) multilingual embedding coherence, (5) rule-based segment stitching in the merger.
- Implementation notes (AUG-163): perplexity is read via GBNF-forced continuation on llama-server /v1/completions (no prompt-logprob echo); a relative k × median rule misses a uniformly bad session, so an absolute median-PPL ceiling (600) was added; loops are short on the timeline, so a fixed per-loop penalty was added.
- Also known as: confidence, transcription confidence, confidence score, transcription quality score, confidenceScore, semantic confidence, text coherence score, transcript post-processing, ASR error correction, perplexity scoring, Groq LLM quality check (AUG-161).

## Baseline: what confidenceScore computes and why it is blind to semantics

Formula (from `server/src/services/confidenceScore.ts`):

- base = duration-weighted mean of (1 − no_speech_prob); neutral 1.0 on whisper-cli 1.8.4 because the binary does not export no_speech_prob (`detail.source` is then `'token-logprob'` or `'coverage-only'`).
- penalties:
  - 40 × duration share of segments with avg_logprob < −1.0 (avg_logprob is rebuilt in `transcribe()` as mean ln(p) of non-special tokens from `--output-json-full`);
  - \+ min(30, 100 × dropped / rawSegments), where dropped = segments TranscriptMerger removed as filler / blacklist / exact-normalized repeats;
  - \+ 30 × max(0, (0.5 − coverage) / 0.5).
- Empty transcript → 0. Constants are frozen in `CONFIDENCE` with a "do not retune without re-validating" note.

| Failure mode | What the text looks like | Why the current score misses it |
|---|---|---|
| Repetition loop | "the report. the report. the report." | Token p stays high because whisper's decoder LM prior favours the repeat; merger only drops exact consecutive duplicates |
| Fluent hallucination | Whisper fills silence with plausible phrases | High p, non-blacklisted phrase; coverage term only reacts if < 50 % of audio is transcribed |
| Wrong-language / transliterated decode under `--language auto` | Russian speech decoded as English-looking tokens or vice versa | Tokens are confident, words are real, meaning is gone |
| Word salad from noisy audio | Unrelated words strung together | May dip avg_logprob below −1.0 on some segments, but a binary per-segment threshold at −1.0 is coarse; segments at −0.9 count as fine |
| Fragmented segments | "so we", "the the budget", "...for Q3" | Individually plausible, unreadable together; nothing measures inter-segment coherence |

The score has no feature derived from the word sequence itself except the merger's blacklist/filler/repeat drops.

## Problem framing: two outputs, one destructive consumer

- Output A: session-level score 0–100 → shown as badge, compared against autoDeleteWavThreshold (50–95, default 70) to delete converted WAVs. False "high" is the expensive error: the converted WAV is removed (sources are never auto-deleted), so a retranscription must re-extract it and a user may trust a nonsense transcript as final.
- Output B: per-segment flags → targets for post-processing / highlighting in TranscriptView.
- Design rule proposed: semantic terms are penalties only (score = min(acoustic, semantic-adjusted)); never a bonus.
- Both platforms (Windows x64, macOS arm64/x64); any binary follows the whisper/bin/<platform>/ pattern from whisper-setup; Windows non-ASCII paths via toSafePath.

## Local track

Per approach: idea, signal(s), cost (disk / RAM / latency per 60-min meeting ≈ 9–10K words ≈ 12–15K tokens / money), integration complexity (Low/Medium/High + where it would live), quality, verdict.

### L1. Whisper-internal signals already on disk (zero model)

- Per-token p from `--output-json-full` is already parsed. Add:
  - (a) local confidence contrast — a token/segment whose p is far below its neighbours (hallucination fingerprint; cf. Corpataux et al., "Detecting Whisper Hallucinations with Local Confidence Contrasts", PMLR v309, 2026);
  - (b) segment-level token entropy / fraction of tokens with p < 0.5;
  - (c) detected-language consistency across the file when `--language auto` (whisper-cli logs the detected language per 30 s window; if it flips, flag);
  - (d) words-per-second per segment (speech is ~2–3.5 w/s; > 5 or < 0.5 on a long segment is suspicious — thresholds inferred, validate).
- Cost: 0 disk, 0 RAM, < 10 ms. Money 0.
- Integration: Low — confidenceScore.ts + `transcribe()` in whisper.ts (need per-token p array kept per segment, not only the mean).
- Quality: catches loops and spot hallucinations well; does not judge fluent word salad.
- Verdict: do first.

### L2. Text statistics without a model (classical NLP)

- (a) gzip compression ratio of the segment/window text — OpenAI's whisper uses compression_ratio > 2.4 as its repetition-loop detector; Node has zlib built in.
- (b) Out-of-vocabulary ratio against a frequency word list per language (e.g. top-50K word lists for en/ru, ~0.5–1 MB each as plain text; hunspell .dic files are an alternative at 1–5 MB); gibberish and wrong-language decodes spike OOV.
- (c) Stop-word / function-word ratio — natural speech sits roughly 40–60 % function words; word salad and transliterated nonsense fall out of the band (band inferred, validate).
- (d) Type/token ratio collapse for loops.
- (e) n-gram LM perplexity via KenLM — real signal but no maintained Node binding and 50–200 MB per language for a pruned 3-gram; a small in-house word-bigram table (~5–10 MB per language) trained offline is the cheap substitute.
- Cost: < 10 MB disk total, negligible RAM, < 50 ms per meeting. Money 0.
- Integration: Low — new pure-TS module (e.g. textStats.ts) consumed by confidenceScore.ts; word lists shipped as assets.
- Quality: strong on gibberish, loops, wrong language; weak on "real words, wrong order"; needs language-aware lists (Russian morphology inflates OOV — lemma-free top-N lists of inflected forms are fine at 100K+ entries).
- Verdict: do together with L1 as "layer 1".

### L3. Sentence-embedding coherence

- Model: all-MiniLM-L6-v2 (English) int8 ONNX = 23 MB (Xenova/all-MiniLM-L6-v2 onnx/model_int8.onnx); multilingual needed for Russian: paraphrase-multilingual-MiniLM-L12-v2 or multilingual-e5-small, ~118M params, int8 ≈ 110–130 MB (estimated from parameter count, verify).
- Signal: cosine similarity of each segment to its neighbours and to the session centroid; nonsense segments are outliers; also flags off-topic hallucinated fillers.
- Runtime: @huggingface/transformers (transformers.js) on onnxruntime-node; CPU latency per short segment ≈ 5–20 ms (inferred; browser WASM benchmarks for the unquantized model are 380–530 ms at seq-len 512, native CPU with int8 and short inputs is far faster — measure).
- Cost: 23–130 MB disk, 200–300 MB RAM while loaded, a few seconds per meeting. Money 0.
- Integration: Medium — native onnxruntime-node binary per platform must be unpacked from asar in the Electron build; one more npm dependency chain in server/.
- Quality: medium — topic drift (small talk) ≠ nonsense → false positives; good secondary signal, weak primary.
- Verdict: optional, after L1/L2 and L4.

### L4. Small causal LM perplexity (true semantic score)

Candidate models (size reported from HF model cards 2026-10-30):

| Model | Quant | Size | Languages | Fit |
|---|---|---|---|---|
| SmolLM2-360M-Instruct | Q4_K_M | 271 MB | English-centric | too weak for Russian |
| Gemma 3 270M-it | Q8_0 | ≈ 290–300 MB (reported, verify) | multilingual-ish | plausible lower bound |
| Qwen2.5-0.5B-Instruct | Q4_K_M / Q8_0 | 491 MB / 676 MB | strong multilingual incl. ru | recommended |
| Qwen3-0.6B | Q8_0 | 639 MB | multilingual | alternative |
| TinyLlama 1.1B | Q4_K_M | ≈ 670 MB | English-centric | rejected (weak ru, no better than Qwen 0.5B) |
| Phi-3.5-mini 3.8B | Q4_K_M / Q8_0 | 2.39 GB / 4.06 GB | en-first | rejected: over budget |

- Signal: per-segment perplexity (or mean token logprob) under the LM, scored with a short context prefix (previous 1–2 segments) so fragmented-but-coherent speech is not punished; use relative outliers (segment PPL vs. session median, per language) rather than absolute thresholds because PPL scales differ between en and ru and between domains.
- Runtime options:
  - (i) spawn a llama.cpp release binary (`llama-perplexity` or `llama-cli --logits`/`--perplexity`; releases ship win-x64 CPU/CUDA zips and macOS arm64 Metal zips) exactly like whisper-cli via a `runLlama()` twin of `runWhisper()` — same setup.ts pinned-zip + SHA256 download, same whisper/bin/<platform>/ folder, same toSafePath handling, same GPU story (CUDA optional download / Metal auto);
  - (ii) node-llama-cpp npm (N-API, prebuilt Metal/CUDA/Vulkan modules, auto-selects compute layer) — simpler API, but another native dependency per platform in the Electron bundle.
  - Prefer (i) for consistency with the existing binary pipeline.
- Cost: 491 MB disk (opt-in download, like the ~457 MB CUDA engine), ≈ 700 MB–1 GB RAM while scoring, CPU prompt-processing throughput for a 0.5B Q4 model is in the hundreds to low thousands of tokens/s on a modern laptop (inferred, measure) → a 60-min meeting (12–15K tokens) scores in ≈ 10–60 s on CPU, a few seconds on Metal/CUDA; runs after transcription inside the same batch slot. Money 0.
- Integration: Medium — new binary + model download in setup.ts, `runLlama()` in a new service, a semantic term in confidenceScore.ts, settings toggle "Semantic quality check (downloads 491 MB)".
- Quality: catches gibberish, word salad, wrong-language, loops; blind to "fluent but factually wrong" (not needed). Fabrication risk: none (scoring only).
- Verdict: the recommended real semantic signal; opt-in because of size.

### L5. Local generative correction (rewrite low-confidence segments)

- Models: Qwen2.5-1.5B-Instruct Q4_K_M ≈ 1.1 GB, Gemma 3 1B ≈ 0.8 GB, Qwen2.5-3B ≈ 2 GB. 0.5B-class models are unreliable editors.
- Cost: 0.8–2 GB disk, 1.5–3 GB RAM, CPU generation ≈ 10–30 tok/s for 1.5B → rewriting even 10 % of a meeting (≈ 1.5K tokens out) takes 1–3 min on CPU. Money 0.
- Integration: Medium–High (same runLlama plumbing plus a diff/suggestion UI).
- Quality/risk: literature warns direct LLM rewriting fabricates content (Yu et al., "Fewer Hallucinations, More Verification: A Three-Stage LLM-Based Framework for ASR Error Correction", arXiv 2505.24347, 2025); Naderi et al. (Interspeech 2024, arXiv 2407.21414) restrict correction to low-confidence spans to avoid damaging correct text.
- Verdict: not recommended now; if correction is wanted, do it in the cloud (C1) with confidence gating and show it as a suggestion, not a silent rewrite.

### L6. Rule-based contextual stitching (readability, no model)

- Extend `TranscriptMerger.joinAdjacentSameRole`: join when the previous line lacks terminal punctuation and the next starts lowercase and the gap is < ~1.5 s (threshold inferred; merger constants are a SplitVox port — validate on reference audio before changing); drop ≤ 2-word utterances with mean token p < 0.5 (phantom-lines fix 5); per-speaker overlap dedup with token timestamps (phantom-lines fix 3).
- Cost 0. Integration Low (transcriptMerger.ts + tests). Quality: readability only.
- Verdict: cheap, independent of the confidence work.

## Cloud track

### C1. Groq LLM inference (reuse existing key and client pattern)

- Production text models on Groq as of 2026-10-30 (console.groq.com/docs/models): llama-3.1-8b-instant, llama-3.3-70b-versatile, openai/gpt-oss-20b, openai/gpt-oss-120b (all 131K context). Preview models are unsuitable (may be discontinued at short notice).
- Scope: free tier only. Paid tiers and per-token billing are out of scope for this research; the design must degrade gracefully (skip the check) when a free-tier limit is hit, never upgrade silently.
- Free-tier limits for llama-3.1-8b-instant (reported, verify at console.groq.com/settings/limits): 30 RPM, 14,400 RPD, 6,000 TPM, 500K TPD. These are separate from the whisper-large-v3 limits (20 RPM) that groqTranscription.ts enforces with its own RateLimiter.
- Two uses:
  - (a) scoring — send batches of ~20–30 numbered segments, ask for a JSON array of coherence 0–10 plus a boolean "nonsense";
  - (b) correction — only segments flagged low by the local score, prompt "fix ASR errors; do not add, remove or reorder information; return the input unchanged if unsure", temperature 0, show result as a suggestion diff.
- Token budget per 60-min meeting on 8b (free tier, money 0): scoring ≈ 15K in + 1K out; gated correction (10–20 % of segments) ≈ 3K in + 3K out; full-transcript correction ≈ 15K in + 15K out. Against the reported 500K TPD this is roughly 15–30 meetings per day. Latency: Groq decodes hundreds to 1000+ tok/s; one batched call ≈ 1–3 s. The 6K TPM cap spreads a full meeting over 3+ minutes — acceptable as a background job after transcription.
- Privacy: the whole transcript text leaves the machine (live Groq already sends audio chunks, so the precedent exists, but post-recording data has so far stayed strictly local — see rule "Groq only as opt-in live engine"). Decision 2026-10-30: context-router.md's PROJECT SPECIFIC RULE now reads "everything is local unless the user decides otherwise"; opt-in cloud features need a consent screen naming the recipient and the user's own API credential. Must be a separate opt-in toggle ("Send transcript text to Groq for quality check"), visible only when GROQ_API_KEY is set, default off; check Groq's data-retention/no-training terms before shipping. Enterprise or confidential meetings keep it off.
- Integration: Low — new service (e.g. groqTextQuality.ts) calling https://api.groq.com/openai/v1/chat/completions with the same Authorization header, error classes and a second RateLimiter instance; hook after computeConfidence in the sessions route; optional per-segment flags persisted in session.json.
- Quality: 8B instruct is good at "is this coherent" and at light ASR cleanup in en/ru; fabrication risk is real for rewrites → gating + unchanged-if-unsure rule.

### C2. Groq whisper verbose_json on the live path (not semantic, fills the acoustic gap)

- Already proposed as phantom-lines fix 4; gives avg_logprob/no_speech_prob per segment for live Groq text. Zero extra cost (same request).

## Cost and complexity matrix (all approaches)

| Approach | Local/Cloud | Disk | RAM | Latency / 60-min meeting | Money / meeting | Integration | Catches (gibberish / loops / wrong-lang / word salad / fragments) | Fabrication risk | Privacy |
|---|---|---|---|---|---|---|---|---|---|
| L1 whisper-internal signals | Local | 0 | 0 | < 10 ms | 0 | Low | loops, spot hallucinations, wrong-lang (language flips); not word salad | — | Fully local |
| L2 text statistics | Local | < 10 MB | negligible | < 50 ms | 0 | Low | gibberish, loops, wrong-lang; weak on word salad and fragments | — | Fully local |
| L3 embedding coherence | Local | 23–130 MB | 200–300 MB | a few s | 0 | Medium | outlier/off-topic segments; weak on fragments (topic drift false positives) | — | Fully local |
| L4 0.5B perplexity | Local | 491 MB (opt-in) | ≈ 0.7–1 GB | ≈ 10–60 s CPU, a few s GPU | 0 | Medium | gibberish, word salad, wrong-lang, loops; fragments only with context prefix | None (scoring only) | Fully local |
| L5 local generative correction | Local | 0.8–2 GB | 1.5–3 GB | 1–3 min per 10 % rewritten (CPU) | 0 | Medium–High | corrects gibberish/word salad | High | Fully local |
| L6 rule-based stitching | Local | 0 | 0 | negligible | 0 | Low | fragments (readability only) | — | Fully local |
| C1-score (Groq 8B, free tier) | Cloud | 0 | 0 | ≈ 1–3 s per call (3+ min on free-tier TPM cap) | 0 (free tier) | Low | gibberish, word salad, wrong-lang, loops, fragments | — | Transcript text leaves machine; opt-in |
| C1-correct (Groq 8B, gated, free tier) | Cloud | 0 | 0 | ≈ 1–3 s per call | 0 (free tier) | Low | corrects gibberish, word salad, wrong-lang, fragments | Medium (gating + unchanged-if-unsure) | Transcript text leaves machine; opt-in |

## Ranked shortlist (3–5 realistic approaches)

1. L1+L2 "layer 1" text statistics + whisper-internal contrasts — local, free, < 10 MB, Low complexity, fixes loops/gibberish/wrong-language blindness; does not judge fluent word salad.
2. L4 local 0.5B perplexity via llama.cpp binary + Qwen2.5-0.5B-Instruct Q4_K_M (491 MB, opt-in) — local, free, Medium complexity, real semantic signal, reuses the whisper-cli binary pattern on both platforms.
3. C1 Groq confidence-gated correction + scoring with llama-3.1-8b-instant — cloud, free tier only (money 0, daily token cap), Low complexity, best correction quality, privacy opt-in; fabrication controlled by gating and unchanged-if-unsure.
4. L3 multilingual embedding coherence (≈ 120 MB int8 via transformers.js) — local, free, Medium complexity (native ONNX runtime in Electron), secondary signal only.
5. L6 rule-based stitching in TranscriptMerger — local, free, Low complexity, readability not correctness.

Honorable mentions / rejected: L5 local generative correction (budget + fabrication), TinyLlama (weak multilingual), Phi-3-mini (2.4 GB), paid hosted LM APIs and Groq paid tiers (out of scope: zero-cost constraint), KenLM (no Node binding, 50–200 MB per language).

## Trade-off matrix (local vs cloud)

| Dimension | Local layer 1 (L1+L2) | Local 0.5B PPL (L4) | Groq 8B free tier (C1) |
|---|---|---|---|
| Marginal cost | 0 | 0 | 0 within the free tier (reported 30 RPM / 6K TPM / 500K TPD) |
| Disk | < 10 MB | 491 MB + llama.cpp binary | 0 |
| Works offline | Yes | Yes | No |
| Privacy | Fully local | Fully local | Transcript text sent to Groq; opt-in |
| Catches word salad | No | Yes | Yes |
| Can correct text | No | No (scoring only) | Yes (suggestions, gated) |
| Complexity | Low | Medium | Low |
| Platform risk (Windows CUDA / macOS Metal / 8.3 paths) | None (pure TS) | Yes: second native binary per platform, CUDA/Metal story, toSafePath for model/binary paths | None (network only) |

## Validation plan (before any threshold is shipped)

- Build a labelled set: ≥ 20 sessions (en + ru, clean and noisy, at least 3 known-bad: loop, wrong-language, silence hallucination); human 0–10 coherence per segment.
- Report Spearman correlation of each signal with the labels and the false-high rate at the auto-delete threshold (70); the semantic term must only lower the score.
- Measure real CPU/GPU latency for L4 on the Windows CUDA box and an Apple Silicon Mac; measure Groq free-tier wall time for one meeting.

## Recommended follow-up tasks (not created)

1. Layer 1: text statistics + token-contrast terms in confidenceScore (L1+L2), with the labelled-set validation.
2. Opt-in local semantic scorer: llama.cpp binary + Qwen2.5-0.5B GGUF download in setup.ts, `runLlama()`, perplexity term (L4).
3. Opt-in Groq transcript quality check + gated correction suggestions (C1), separate privacy toggle.
4. Merger stitching + low-confidence short-utterance rule (L6, phantom-lines fixes 3/5).
5. Optional: embedding coherence (L3).

## Open questions

- Does the user actually mean whisper's wrong-language decode, or a planned translation feature? (determines whether scoring runs on source or translated text)
- Is sending transcript text to Groq acceptable at all for post-recording sessions, given the "post-recording stays local" rule?
- Which languages must the word lists / LM cover beyond en and ru?
- Should the semantic term be allowed to block auto-delete independently (AND gate) rather than only subtract from the score?

## Components

- confidenceScore (module): part of the August server; computes the acoustic 0–100 transcription confidence that every approach here would extend with a semantic penalty term.
- TranscriptMerger (module): part of the August server; its filler / blacklist / repeat drops are the only text-derived signal the current score has, and L6 extends its joining rules.
- groqTranscription (module): part of the August server; its Authorization header, RateLimiter and error classes are the template for a Groq text-quality service (C1).
- Groq (integration): hosted inference vendor; C1 would call its OpenAI-compatible chat completions endpoint with llama-3.1-8b-instant within the free tier only.
- llama.cpp (technology): GGUF inference runtime whose release binaries (llama-perplexity, llama-cli) L4 would spawn like whisper-cli on win-x64 and darwin-arm64.
- node-llama-cpp (technology): N-API binding to llama.cpp with prebuilt Metal / CUDA / Vulkan modules; the alternative runtime for L4.
- transformers.js (technology): ONNX runtime for Node that L3 would use for int8 sentence-embedding models.
- Qwen2.5-0.5B-Instruct (technology): 491 MB Q4_K_M GGUF model recommended for L4 perplexity scoring.
- confidenceScore depends on TranscriptMerger for the dropped-segment count.
- C1 integrates with Groq and depends on groqTranscription's client pattern.

## Sources

- [Groq models](https://console.groq.com/docs/models)
- [Groq rate limits](https://console.groq.com/docs/rate-limits)
- [Qwen2.5-0.5B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF)
- [Qwen3-0.6B-GGUF](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF)
- [SmolLM2-360M-GGUF (mradermacher)](https://huggingface.co/mradermacher/SmolLM2-360M-GGUF)
- [Phi-3.5-mini-instruct-GGUF (bartowski)](https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF)
- [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
- [node-llama-cpp](https://github.com/withcatai/node-llama-cpp)
- [arXiv 2505.24347](https://arxiv.org/abs/2505.24347)
- [arXiv 2407.21414](https://arxiv.org/abs/2407.21414)
- [Corpataux et al., PMLR v309](https://proceedings.mlr.press/v309/corpataux26a.html)
- [arXiv 2606.23060](https://arxiv.org/abs/2606.23060)
