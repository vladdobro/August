// Diagnostic for system audio capture (AUG-106, Windows in AUG-111/AUG-112). Prints the parsed
// audio device list, the detected capture method, and the self-test result so
// the output can be pasted into a bug report. Run via `npm run capture:check`
// in server/. Always exits 0 — a failing self-test is a result, not a crash.

import { detectCapabilities, listAvfoundationAudioDevices, listDshowAudioDevices } from '../services/systemCapture.js';
import { getWasapiHelperStatus } from '../services/wasapiHelper.js';
import { checkFfmpegAvailable } from '../services/whisper.js';
import { config } from '../config.js';

async function main(): Promise<void> {
  console.log(`platform: ${process.platform} ${process.arch}`);
  const ffmpeg = await checkFfmpegAvailable();
  console.log(`ffmpeg: ${config.ffmpegPath} [${config.ffmpegSource}] — ${ffmpeg ? 'ok' : 'missing'}`);

  if (process.platform === 'darwin' && ffmpeg) {
    const devices = await listAvfoundationAudioDevices();
    console.log(`avfoundation audio devices (${devices.length}):`);
    for (const d of devices) console.log(`  [${d.index}] ${d.name}`);
  } else if (process.platform === 'win32' && ffmpeg) {
    const devices = await listDshowAudioDevices();
    console.log(`dshow audio devices (${devices.length}):`);
    for (const name of devices) console.log(`  "${name}"`);
    const wasapi = await getWasapiHelperStatus();
    if (wasapi.ok) {
      console.log(`wasapi helper: ok (${wasapi.exePath})`);
      console.log(`wasapi probe: ${JSON.stringify(wasapi.probe)}`);
    } else {
      console.log(`wasapi helper: unavailable — ${wasapi.reason}`);
    }
  } else {
    console.log('audio device list: n/a (macOS or Windows + ffmpeg required)');
  }

  const caps = await detectCapabilities(true);
  console.log(`method: ${caps.method}`);
  console.log(`systemCapture: ${caps.systemCapture}`);
  console.log(`hint: ${caps.hint}`);
  console.log(`selfTest: ${caps.selfTest}`);
  console.log(`selfTestDetail: ${caps.selfTestDetail || '(none)'}`);
}

main()
  .catch((err) => { console.error('capture:check crashed:', err); })
  .finally(() => process.exit(0));
