/// Raw-PCM sample-format sniffing (AUG-107). audiotee writes raw PCM to
/// stdout, and its README is vague about whether that is 32-bit float or
/// 16-bit int (it depends on whether a sample-rate conversion happened and
/// may differ between builds). Feeding ffmpeg the wrong `-f` yields a WAV of
/// white noise and a garbage [Them] transcript with no error anywhere, so
/// the capture path sniffs a short chunk of the helper's output first.
///
/// Rule: interpret the same bytes as int16 LE and as float32 LE and score
/// each view. Real audio has a low zero-crossing rate (speech at 16 kHz is
/// roughly 0.05–0.3); the wrong interpretation looks like white noise (rate
/// near 0.5). Guards applied before the rate comparison: a float32 view with
/// any NaN/Infinity, with peaks far outside [-1, 1], or with no measurable
/// signal (denormals only) is rejected in favour of s16le. A silent or too
/// short buffer falls back to s16le and is reported as not confident.
///
/// Pure functions over a Buffer — no native dependencies, unit-testable on
/// any platform.

export type PcmSampleFormat = 's16le' | 'f32le';
export type SampleFormatSource = 'override' | 'detected' | 'fallback';

export interface SampleFormatGuess {
  format: PcmSampleFormat;
  /// false when the buffer carried no usable signal (too short or silent) and
  /// the format is a default rather than a measurement.
  confident: boolean;
  reason: string;
  zeroCrossingRate: { s16le: number; f32le: number };
}

export interface ResolvedSampleFormat {
  /// ffmpeg `-f` demuxer name for the raw stream (s16le / f32le, or whatever the override says).
  sampleFormat: string;
  sampleFormatSource: SampleFormatSource;
  detail: string;
}

/// ~200 ms of 16 kHz mono s16le (100 ms if the stream is float) — enough for a stable zero-crossing estimate.
export const SAMPLE_FORMAT_PROBE_BYTES = 6400;
const MIN_PROBE_BYTES = 256;
/// Real float audio lives in [-1, 1]; allow mild clipping from an unlimited system mix.
const FLOAT_PEAK_MAX = 1.5;
/// Below this the float32 view is denormal noise produced by small int16 words, not audio.
const FLOAT_PEAK_MIN = 1e-5;

interface ViewStats {
  zcr: number;
  peak: number;
  finite: boolean;
}

function scoreView(read: (index: number) => number, count: number): ViewStats {
  let crossings = 0;
  let peak = 0;
  let finite = true;
  let prev = 0;
  for (let i = 0; i < count; i++) {
    const v = read(i);
    if (!Number.isFinite(v)) { finite = false; continue; }
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
    if (v !== 0) {
      if (prev !== 0 && (v < 0) !== (prev < 0)) crossings++;
      prev = v;
    }
  }
  return { zcr: count > 1 ? crossings / (count - 1) : 0, peak, finite };
}

export function detectPcmSampleFormat(buf: Buffer): SampleFormatGuess {
  // Truncate to a multiple of 4 so both views cover the same bytes.
  const usable = buf.length - (buf.length % 4);
  if (usable < MIN_PROBE_BYTES) {
    return { format: 's16le', confident: false, reason: `insufficient data (${buf.length} bytes)`, zeroCrossingRate: { s16le: 0, f32le: 0 } };
  }
  const s16 = scoreView((i) => buf.readInt16LE(i * 2) / 32768, usable / 2);
  const f32 = scoreView((i) => buf.readFloatLE(i * 4), usable / 4);
  const zeroCrossingRate = { s16le: s16.zcr, f32le: f32.zcr };

  if (s16.peak === 0) {
    return { format: 's16le', confident: false, reason: 'silent buffer', zeroCrossingRate };
  }
  if (!f32.finite) {
    return { format: 's16le', confident: true, reason: 'float32 view contains NaN/Infinity', zeroCrossingRate };
  }
  if (f32.peak > FLOAT_PEAK_MAX) {
    return { format: 's16le', confident: true, reason: `float32 peak ${f32.peak.toExponential(2)} is outside [-1, 1]`, zeroCrossingRate };
  }
  if (f32.peak < FLOAT_PEAK_MIN) {
    return { format: 's16le', confident: true, reason: 'float32 view has no signal (denormals only)', zeroCrossingRate };
  }
  if (f32.zcr < s16.zcr) {
    return { format: 'f32le', confident: true, reason: `float32 zero-crossing rate ${f32.zcr.toFixed(3)} < int16 ${s16.zcr.toFixed(3)}`, zeroCrossingRate };
  }
  return { format: 's16le', confident: true, reason: `int16 zero-crossing rate ${s16.zcr.toFixed(3)} <= float32 ${f32.zcr.toFixed(3)}`, zeroCrossingRate };
}

/// `override` (AUDIOTEE_SAMPLE_FORMAT) skips the probe entirely and is echoed
/// back verbatim. Otherwise `readSample` must return a short chunk of the
/// helper's raw stdout; a throwing probe or an unusable sample falls back to
/// s16le and says why in `detail`.
export async function resolveAudioteeSampleFormat(
  override: string | null,
  readSample: () => Promise<Buffer>,
): Promise<ResolvedSampleFormat> {
  if (override) {
    return { sampleFormat: override, sampleFormatSource: 'override', detail: `AUDIOTEE_SAMPLE_FORMAT=${override}` };
  }
  let sample: Buffer;
  try {
    sample = await readSample();
  } catch (err) {
    return { sampleFormat: 's16le', sampleFormatSource: 'fallback', detail: `probe failed: ${(err as Error)?.message ?? String(err)}` };
  }
  const guess = detectPcmSampleFormat(sample);
  return { sampleFormat: guess.format, sampleFormatSource: guess.confident ? 'detected' : 'fallback', detail: guess.reason };
}
