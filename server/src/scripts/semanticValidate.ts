import { computeConfidence } from '../services/confidenceScore.js';
import { readLlmSettings, llmInstallState } from '../services/llmInstaller.js';
import { withLocalLlm } from '../services/llmServer.js';
import { scorePerplexity } from '../services/semanticCheck.js';
import { mergeSingleStreamDetailed } from '../services/transcriptMerger.js';
import { ensureWav, transcribe } from '../services/whisper.js';
import type { SemanticFlag, TranscriptSegment, TranscriptionLanguage } from '../types.js';

/// AUG-163 dev tool: `npx tsx src/scripts/semanticValidate.ts <wavPath> <language> [--loop-inject]`.
/// Prints the acoustic score, the score with text statistics only and (when the local model is ready) with perplexity.
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const loopInject = args.includes('--loop-inject');
  const [audioPath, languageArg] = args.filter((a) => !a.startsWith('--'));
  if (!audioPath || !languageArg || !['auto', 'en', 'ru'].includes(languageArg)) {
    console.error('Usage: tsx src/scripts/semanticValidate.ts <wavPath> <auto|en|ru> [--loop-inject]');
    return;
  }
  const language = languageArg as TranscriptionLanguage;

  const wav = await ensureWav(audioPath);
  const segments: TranscriptSegment[] = await transcribe(wav, language);
  if (loopInject && segments.length > 2) {
    const mid = 1 + Math.floor(Math.random() * (segments.length - 2));
    const text = segments[mid].text;
    segments[mid] = { ...segments[mid], text: Array.from({ length: 6 }, () => text).join(' ') };
    console.log(`[loop-inject] segment ${mid} repeated 6x`);
  }
  const merged = mergeSingleStreamDetailed(segments);
  const audioDurationSec = segments.length > 0 ? segments[segments.length - 1].end : 0;
  const base = { tracks: [segments], dropped: merged.dropped, audioDurationSec, language };

  const textOnly = computeConfidence(base);
  console.log(`acoustic score: ${textOnly.detail.acousticScore}`);
  console.log(`with text stats: ${textOnly.score} (penalty ${textOnly.detail.semantic?.penalty})`);

  let final = textOnly;
  const settings = await readLlmSettings();
  if (settings.enabled && (await llmInstallState(settings.model)) === 'ready') {
    final = await withLocalLlm(async (client, modelId) => {
      const ppl = await scorePerplexity(client, base.tracks, modelId);
      return computeConfidence({ ...base, perplexity: ppl });
    });
    console.log(`with perplexity: ${final.score} (penalty ${final.detail.semantic?.penalty}, ${JSON.stringify(final.detail.semantic?.perplexity)})`);
  } else {
    console.log('local model not ready: perplexity skipped');
  }

  const counts: Partial<Record<SemanticFlag, number>> = {};
  const flagged = final.detail.semantic?.segments ?? [];
  for (const s of flagged) for (const f of s.flags) counts[f] = (counts[f] ?? 0) + 1;
  console.log('flag counts:', counts);
  const worst = [...flagged].sort((a, b) => b.flags.length - a.flags.length || (b.perplexity ?? 0) - (a.perplexity ?? 0)).slice(0, 5);
  for (const s of worst) {
    const text = (segments[s.index]?.text ?? '').slice(0, 80);
    console.log(`  [${s.start}-${s.end}] ${s.flags.join(',')} ppl=${s.perplexity ?? '-'} "${text}"`);
  }
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(0); });
