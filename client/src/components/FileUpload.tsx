import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sendActionItemsToPraxis, uploadAudio, uploadDualAudio, uploadDualAudioWithCapture, fetchCaptureCapabilities, startServerCapture, stopServerCapture, transcribeFromUrl, type UploadProgress } from '../api';
import type { ActionItem, CaptureCapabilities, MuteInterval, Participants, ServerCapture, TranscriptionLanguage } from '../types';
import { useTheme } from '../theme';
import RecordingModePicker, { type RecordingMode } from './RecordingModePicker';
import LanguagePicker from './LanguagePicker';
import MicPicker from './MicPicker';
import ActionItemsPanel from './ActionItemsPanel';
import PraxisModal from './PraxisModal';
import LiveColumns from './live/LiveColumns';
import { isMacPlatform } from './live/platform';
import { assistantStore, useCopilotHintCount, type AssistantTransport } from '../services/assistantStore';
import { liveColumnsStore } from '../services/liveColumnsStore';
import LiveTranscriptPanel, { type LiveLine, type LiveStatus } from './LiveTranscriptPanel';
import { LiveTranscriptionClient, type LiveActionItemsState, type LiveEngine } from '../services/liveTranscriptionClient';
import { saveRecordingProgress, getRecoveredRecording, clearRecoveredRecording, type RecoveredRecording } from '../services/recordingRecovery';
import { DEFAULT_PREFERENCES, resolveSystemAudioSource, type UserPreferences } from '../services/preferences';
import { shouldAutoEnableLive } from '../services/compact';
import { compactStore } from '../services/compactStore';
import { writeClipboard } from '../services/clipboard';
import { useHoldToStop } from './HoldToStopButton';
import { isVideoFile, probeVideoHasAudio, NO_AUDIO_MESSAGE } from '../services/videoAudioProbe';

// Mirrors UPLOAD_EXTENSIONS in server/src/services/mediaFormats.ts (video: audio track extracted server-side, AUG-144).
const ACCEPTED_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.mp4', '.mov'];
// Must match the multer fileSize limit in server/src/routes/sessions.ts
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const AUDIO_BARS_COUNT = 12;

const BAR_BASE_HEIGHT = [14, 8, 12, 6, 15, 10, 7, 13, 6, 11, 9, 14];

interface FileUploadProps {
  onUploaded: () => void;
  onRecordingChange?: (recording: boolean) => void;
  groqAvailable?: boolean;
  onGroqKeySaved?: () => void;
  preferences?: UserPreferences;
  onPreferenceChange?: (patch: Partial<UserPreferences>) => void;
  audioDevicesFromApp?: MediaDeviceInfo[];
  captureCapabilities?: CaptureCapabilities | null;
  // A failed self-test is re-checked before a recording; the fresh result is reported back so Settings shows it too.
  onCaptureCapabilitiesChange?: (caps: CaptureCapabilities) => void;
  onOpenSettings?: (tab?: 'assistants') => void;
  // Desktop shell: a timestamp per global-hotkey/tray toggle request; consumed once via onDesktopToggleHandled.
  desktopToggleRequest?: number | null;
  onDesktopToggleHandled?: () => void;
}

function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

const liveLinesToText = (lines: LiveLine[]) => lines.map((l) => l.kind === 'gap' ? l.text : `${l.speaker}: ${l.text}`).join('\n');

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

const FileUpload: React.FC<FileUploadProps> = ({ onUploaded, onRecordingChange, groqAvailable, onGroqKeySaved, preferences, onPreferenceChange, audioDevicesFromApp, captureCapabilities, onCaptureCapabilitiesChange, onOpenSettings, desktopToggleRequest, onDesktopToggleHandled }) => {
  const { theme, toggle: toggleTheme } = useTheme();
  const [language, setLanguage] = useState<TranscriptionLanguage>('ru');
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [isLinkSubmitting, setIsLinkSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>('');
  const [captureSystemAudio, setCaptureSystemAudio] = useState(DEFAULT_PREFERENCES.systemAudio);
  const [micNotice, setMicNotice] = useState<string | null>(null);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  const micStartedAtRef = useRef<number>(0);

  // --- Live Transcription (additive layer; does not alter recording/upload above) ---
  const [showModePicker, setShowModePicker] = useState(false);
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [showMicPicker, setShowMicPicker] = useState(false);
  const [liveActive, setLiveActive] = useState(false);
  const [liveHidden, setLiveHidden] = useState(false);
  const [liveLines, setLiveLines] = useState<LiveLine[]>([]);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveWarning, setLiveWarning] = useState<string | null>(null);
  const [liveMicUnavailable, setLiveMicUnavailable] = useState(false);
  // Compact Mode: the mic or shared system-audio track died and could not be recovered.
  const [captureLost, setCaptureLost] = useState(false);
  const [recoveredRecording, setRecoveredRecording] = useState<RecoveredRecording | null>(null);
  const [showDefaultsInfo, setShowDefaultsInfo] = useState(false);
  const liveClientRef = useRef<LiveTranscriptionClient | null>(null);
  // AUG-200: meeting-only socket (recording without Live Text): action items + ASSISTANT, no audio
  const meetingClientRef = useRef<LiveTranscriptionClient | null>(null);
  const [meetingActive, setMeetingActive] = useState(false);
  const controlClient = () => liveClientRef.current ?? meetingClientRef.current;
  // AUG-199: the assistant store talks to whichever live client is current.
  const ctxHintCount = useCopilotHintCount();
  const assistantTransportRef = useRef<AssistantTransport>({
    open: (p) => controlClient()?.assistantOpen(p),
    ask: (p, text, askId) => controlClient()?.assistantAsk(p, text, askId),
    task: (p, askId, messageId) => controlClient()?.assistantTask(p, askId, messageId),
    stop: (p, interrupt) => controlClient()?.assistantStop(p, interrupt),
    addItem: (text, owner, assistant) => controlClient()?.addActionItem(text, owner, assistant),
    copilotOpen: (p) => controlClient()?.copilotOpen(p),
    copilotClose: (p) => controlClient()?.copilotClose(p),
    copilotDismiss: (p, hintId, undo) => controlClient()?.copilotDismiss(p, hintId, undo),
    copilotMode: (mode, model) => controlClient()?.copilotMode(mode, model),
  });
  // AUG-165: action items + participants of the current live recording (persisted server-side by liveKey).
  const [liveActionItems, setLiveActionItems] = useState<ActionItem[]>([]);
  const [liveActionEnabled, setLiveActionEnabled] = useState<boolean | null>(null);
  const [liveActionOffReason, setLiveActionOffReason] = useState<'groq' | 'items' | 'manual' | null>(null);
  const [liveParticipants, setLiveParticipants] = useState<Participants>({ me: '', them: '' });
  const liveParticipantsRef = useRef<Participants>({ me: '', them: '' });
  const liveKeyRef = useRef<string | null>(null);
  const [praxisExport, setPraxisExport] = useState<{ ids: string[]; mode: 'separate' | 'common'; liveKey: string } | null>(null);
  const recordingLiveSourceRef = useRef<{ micStream: MediaStream | null; systemStream: MediaStream | null; captureId: string | null } | null>(null); // AUG-188: what Start Live Text needs, kept for the whole recording
  const liveKeyHolderRef = useRef<{ key: string | null } | null>(null); // AUG-188: the upload reads the key from this holder
  const liveStartArgsRef = useRef<{ micStream: MediaStream | null; systemStream: MediaStream | null; engine: LiveEngine; captureId: string | null } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const soundRecorderRef = useRef<MediaRecorder | null>(null);
  const soundChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const soundStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordCtxRef = useRef<AudioContext | null>(null);
  // AUG-181: mic mute during recording
  const [micMuted, setMicMuted] = useState(false);
  const micMutedRef = useRef(false);
  const muteGainRef = useRef<GainNode | null>(null);
  const rawMicAnalyserRef = useRef<AnalyserNode | null>(null);
  const muteIntervalsRef = useRef<MuteInterval[]>([]);
  const muteStartRef = useRef<number | null>(null);
  const [mutedSpeechHint, setMutedSpeechHint] = useState(false);
  const hintTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [audioLevels, setAudioLevels] = useState<number[]>(new Array(AUDIO_BARS_COUNT).fill(0));
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const [longPressing, setLongPressing] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      if (!isAcceptedFile(file)) {
        setError(`Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}`);
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        const sizeGB = (file.size / (1024 * 1024 * 1024)).toFixed(1);
        setError(`File is too large (${sizeGB} GB). Maximum is 2 GB.`);
        return;
      }
      // Local pre-check (AUG-146): block only a confirmed audio-less video; null (undecided) uploads as before.
      if (isVideoFile(file) && (await probeVideoHasAudio(file)) === false) {
        setError(NO_AUDIO_MESSAGE);
        return;
      }
      setIsUploading(true);
      setUploadProgress(null);
      try {
        await uploadAudio(file, language, setUploadProgress);
        onUploaded();
      } catch (err) {
        setError((err as Error).message || 'Upload failed');
      } finally {
        setIsUploading(false);
        setUploadProgress(null);
      }
    },
    [language, onUploaded],
  );

  const handleLinkSubmit = useCallback(async () => {
    const trimmed = linkUrl.trim();
    if (!trimmed) return;
    setError(null);
    try {
      new URL(trimmed);
    } catch {
      setError('Invalid URL');
      return;
    }
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      setError('Only http and https links are supported');
      return;
    }
    setIsLinkSubmitting(true);
    try {
      await transcribeFromUrl(trimmed, language);
      setLinkUrl('');
      onUploaded();
    } catch (err) {
      setError((err as Error).message || 'Failed to start transcription from link');
    } finally {
      setIsLinkSubmitting(false);
    }
  }, [linkUrl, language, onUploaded]);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => setIsDragging(false);

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    e.target.value = '';
  };

  useEffect(() => {
    let cancelled = false;

    const enumerate = async () => {
      try {
        const initial = await navigator.mediaDevices.enumerateDevices();
        const hasLabels = initial.some((d) => d.kind === 'audioinput' && d.label);

        if (!hasLabels) {
          const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          tempStream.getTracks().forEach((t) => t.stop());
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) {
          setAudioDevices(devices.filter((d) => d.kind === 'audioinput'));
        }
      } catch {
        // permission denied or no devices
      }
    };

    void enumerate();

    const onDeviceChange = () => void enumerate();
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    };
  }, []);

  // Fall back to the device list enumerated at the App level if the local
  // enumeration above hasn't produced anything yet (e.g. permissions race).
  useEffect(() => {
    if (audioDevicesFromApp && audioDevicesFromApp.length > 0 && audioDevices.length === 0) {
      setAudioDevices(audioDevicesFromApp);
    }
  }, [audioDevicesFromApp, audioDevices.length]);

  useEffect(() => {
    if (preferences?.language) {
      setLanguage(preferences.language as TranscriptionLanguage);
    }
  }, [preferences?.language]);

  useEffect(() => {
    if (preferences?.micDeviceId && preferences.micDeviceId !== 'default') {
      setSelectedMicId(preferences.micDeviceId);
    }
  }, [preferences?.micDeviceId]);

  useEffect(() => {
    if (preferences?.systemAudio !== undefined) {
      setCaptureSystemAudio(preferences.systemAudio);
    }
  }, [preferences?.systemAudio]);

  const resolvedSystemSource = resolveSystemAudioSource(preferences?.systemAudioSource, captureCapabilities);

  useEffect(() => {
    if (preferences?.micDeviceId && preferences.micDeviceId !== 'default' && audioDevices.length > 0) {
      const found = audioDevices.some((d) => d.deviceId === preferences.micDeviceId);
      if (!found) {
        setSelectedMicId('');
        setMicNotice('Preferred mic not found — using system default');
      } else {
        setMicNotice(null);
      }
    }
  }, [preferences?.micDeviceId, audioDevices]);

  // AUG-200: one handler for the Live and the meeting-only socket.
  const applyActionItems = useCallback((st: LiveActionItemsState) => {
    setLiveActionItems(st.items);
    setLiveActionEnabled(st.enabled);
    setLiveActionOffReason(st.enabled ? null : st.manual ? 'manual' : st.groqText ? 'items' : 'groq');
    setLiveParticipants(st.participants);
    liveParticipantsRef.current = st.participants;
  }, []);

  const stopMeetingSocket = useCallback(() => {
    meetingClientRef.current?.stop();
    meetingClientRef.current = null;
    setMeetingActive(false);
  }, []);

  const startMeetingSocket = useCallback(() => {
    const key = liveKeyRef.current;
    if (!key || meetingClientRef.current || liveClientRef.current) return;
    const client = new LiveTranscriptionClient({
      onTranscript: () => {},
      onActionItems: applyActionItems,
      onAssistant: (frame) => assistantStore.applyFrame(frame),
      onSocketOpen: () => assistantStore.resync(),
      onStatusChange: () => {},
      onError: () => {},
      onWarning: () => {},
      onMicUnavailable: () => {},
    });
    meetingClientRef.current = client;
    assistantStore.bind(assistantTransportRef.current);
    assistantStore.setLive(true, false);
    void assistantStore.refreshStatus();
    client.startMeeting(key, liveParticipantsRef.current);
    setMeetingActive(true);
  }, [applyActionItems]);

  const startLiveTranscription = useCallback(
    (micStream: MediaStream | null, systemStream: MediaStream | null, engine: LiveEngine = 'local', captureId: string | null = null, keepLines = false) => {
      stopMeetingSocket(); // AUG-200: the Live socket takes over the same liveKey
      if (!keepLines) { setLiveLines([]); setLiveActionEnabled(null); setLiveActionOffReason(null); } // items arrive from the server on subscribe
      setLiveError(null);
      setLiveWarning(null);
      setLiveMicUnavailable(false);
      setLiveStatus('connecting');
      setLiveActive(true);

      const client = new LiveTranscriptionClient({
        onTranscript: (speaker, text, id) => {
          setLiveLines((prev) => {
            const part = { id, text };
            const last = prev.length > 0 ? prev[prev.length - 1] : null;
            if (last && last.speaker === speaker && !last.kind) {
              const updated = [...prev];
              updated[updated.length - 1] = { speaker, text: `${last.text} ${text}`, parts: [...(last.parts ?? [{ text: last.text }]), part] };
              return updated;
            }
            return [...prev, { speaker, text, parts: [part] }];
          });
        },
        // AUG-164: online text correction replaces a settled chunk in place (memory only — never saved).
        onCorrection: (id, text) => {
          setLiveLines((prev) => {
            const idx = prev.findIndex((l) => l.parts?.some((p) => p.id === id));
            if (idx < 0) return prev;
            const parts = prev[idx].parts!.map((p) => (p.id === id ? { ...p, text, correctedAt: Date.now(), original: p.original ?? p.text } : p));
            const updated = [...prev];
            updated[idx] = { ...prev[idx], parts, text: parts.map((p) => p.text).join(' ') };
            return updated;
          });
        },
        onActionItems: applyActionItems,
        // AUG-199: assistant frames feed the store; the tabs are (re)opened once the socket is ready.
        onAssistant: (frame) => assistantStore.applyFrame(frame),
        onCopilot: (frame) => assistantStore.applyCopilotFrame(frame),
        onSocketOpen: () => assistantStore.resync(),
        onStatusChange: setLiveStatus,
        onError: setLiveError,
        onWarning: setLiveWarning,
        onMicUnavailable: () => setLiveMicUnavailable(true),
      });
      liveClientRef.current = client;
      assistantStore.bind(assistantTransportRef.current);
      assistantStore.setLive(true, true);
      void assistantStore.refreshStatus();
      client.start(micStream, systemStream, language, engine, captureId, liveKeyRef.current, liveParticipantsRef.current);
    },
    [language, stopMeetingSocket, applyActionItems],
  );

  const startRecording = useCallback(async (liveMode: boolean = false, engine: LiveEngine = 'local') => {
    setError(null);
    setCaptureNotice(null);
    setCaptureLost(false);
    micMutedRef.current = false;
    setMicMuted(false);
    muteIntervalsRef.current = [];
    muteStartRef.current = null;
    setMutedSpeechHint(false);
    // Compact Mode "Always live transcript": a Default recording gets Live too (desktop only; saved recordingMode untouched).
    const autoLive = !liveMode && shouldAutoEnableLive(preferences ?? {}, Boolean(window.august));
    const useLive = liveMode || autoLive;
    const liveEngine: LiveEngine = autoLive ? (preferences?.liveEngine === 'groq' && groqAvailable ? 'groq' : 'local') : engine;
    // AUG-165: one key per live recording; the upload carries it so the server moves the collected action items into the session.
    // AUG-200: every recording has a key: Default recordings keep manual / assistant items too.
    const recordingLiveKey = crypto.randomUUID();
    liveKeyRef.current = recordingLiveKey;
    // A Default recording that starts Live later gets its key here, so the upload still attaches its action items.
    const liveKeyHolder = { key: recordingLiveKey };
    liveKeyHolderRef.current = liveKeyHolder;
    liveParticipantsRef.current = { me: '', them: '' };
    setLiveParticipants({ me: '', them: '' });
    setLiveActionItems([]);
    try {
      void clearRecoveredRecording();
      setRecoveredRecording(null);
      const micConstraints: MediaTrackConstraints | boolean = selectedMicId
        ? { deviceId: { exact: selectedMicId } }
        : true;

      const micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints });
      streamRef.current = micStream;
      let liveSystemStream: MediaStream | null = null;

      // AUG-105: decide how the system track is captured for this recording.
      // AUG-113: live mode no longer forces the picker — the server tees its
      // capture into the live pipeline, so the same decision applies to both modes.
      let serverCapture: ServerCapture | null = null;
      // The self-test runs once at app start and can fail transiently under load (cold device, dev build): re-check a
      // failed result now instead of falling back to the screen picker for the whole app session.
      let caps = captureCapabilities;
      if (captureSystemAudio && preferences?.systemAudioSource !== 'browser' && caps?.systemCapture && caps.selfTest === 'failed') {
        try {
          caps = await fetchCaptureCapabilities(true);
          onCaptureCapabilitiesChange?.(caps);
        } catch {
          // keep the cached result
        }
      }
      const systemSource = resolveSystemAudioSource(preferences?.systemAudioSource, caps);
      const useServerCapture = captureSystemAudio && systemSource === 'system';
      if (captureSystemAudio && preferences?.systemAudioSource === 'system' && systemSource === 'browser') {
        setCaptureNotice(`Direct system capture is unavailable — using the browser screen picker. ${caps?.hint ?? ''}`.trim());
      }

      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/wav')
          ? 'audio/wav'
          : '';

      const ts = Date.now();

      // AUG-125: record the mic through a Web Audio graph, not the raw device track. The destination node keeps
      // producing samples (silence) when the device goes quiet or ends (Bluetooth / default-device switch, another app
      // taking the input), so the mic file keeps wall-clock length and ends with the system track. On the raw track
      // Chromium's MediaRecorder simply stops advancing — a 54-min call ended up with a 16-min mic track.
      let recordCtx: AudioContext | null = new AudioContext();
      await recordCtx.resume().catch(() => {});
      if (recordCtx.state !== 'running') {
        void recordCtx.close().catch(() => {});
        recordCtx = null; // e.g. autoplay policy in a plain browser tab: fall back to the raw track
      }
      recordCtxRef.current = recordCtx;
      const recordDest = recordCtx ? recordCtx.createMediaStreamDestination() : null;
      let micSource = recordCtx ? recordCtx.createMediaStreamSource(micStream) : null;
      // AUG-181: mic mute is a gain node between the mic and the recorder (never MediaRecorder.pause / track.stop: both shorten
      // the mic file and desync [Me] from [Them]). The raw-mic analyser sits before it for the "You're muted" hint.
      const muteGain = recordCtx ? recordCtx.createGain() : null;
      const rawMicAnalyser = recordCtx ? recordCtx.createAnalyser() : null;
      if (rawMicAnalyser) rawMicAnalyser.fftSize = 2048;
      if (micSource && recordDest && muteGain) {
        micSource.connect(muteGain);
        muteGain.connect(recordDest);
        if (rawMicAnalyser) micSource.connect(rawMicAnalyser);
      }
      muteGainRef.current = muteGain;
      rawMicAnalyserRef.current = rawMicAnalyser;
      const recordStream = recordDest ? recordDest.stream : micStream;

      let levelStream: MediaStream = recordStream;

      const dualState = { mic: null as Blob | null, system: null as Blob | null, uploading: false, mutes: [] as MuteInterval[] };

      const tryDualUpload = async () => {
        if (!dualState.mic || !dualState.system || dualState.uploading) return;
        dualState.uploading = true;

        const micBlob = dualState.mic;
        const sysBlob = dualState.system;
        const micExt = micBlob.type.includes('wav') ? 'wav' : 'webm';
        const sysExt = sysBlob.type.includes('wav') ? 'wav' : 'webm';
        const micFile = new File([micBlob], `recording-${ts}-mic.${micExt}`, { type: micBlob.type });
        const sysFile = new File([sysBlob], `recording-${ts}-system.${sysExt}`, { type: sysBlob.type });

        setIsUploading(true);
        setUploadProgress(null);
        try {
          await uploadDualAudio(micFile, sysFile, language, setUploadProgress, liveKeyHolder.key, dualState.mutes);
          onUploaded();
        } catch (err) {
          setError((err as Error).message || 'Upload failed');
        } finally {
          setIsUploading(false);
          setUploadProgress(null);
        }
      };

      const uploadWithServerCapture = async (micBlob: Blob, capture: ServerCapture, mutes: MuteInterval[]) => {
        const micExt = micBlob.type.includes('wav') ? 'wav' : 'webm';
        const micFile = new File([micBlob], `recording-${ts}-mic.${micExt}`, { type: micBlob.type });

        setIsUploading(true);
        setUploadProgress(null);
        try {
          let captureStopped = true;
          try {
            await stopServerCapture(capture.captureId);
          } catch (err) {
            captureStopped = false;
            setCaptureNotice(`System audio track was lost (${(err as Error).message}) — saving the microphone track only.`);
          }
          if (captureStopped) {
            await uploadDualAudioWithCapture(micFile, capture.captureId, micStartedAtRef.current, language, setUploadProgress, liveKeyHolder.key, mutes);
          } else {
            await uploadAudio(micFile, language, setUploadProgress, liveKeyHolder.key, mutes);
          }
          onUploaded();
        } catch (err) {
          setError((err as Error).message || 'Upload failed');
        } finally {
          setIsUploading(false);
          setUploadProgress(null);
        }
      };

      recordedChunksRef.current = [];
      const micRecorder = mimeType
        ? new MediaRecorder(recordStream, { mimeType })
        : new MediaRecorder(recordStream);

      // A vanished device ends its track; re-acquire the same mic (or the default one) and plug it into the graph so the
      // rest of the call is still recorded.
      const recorderStopped = () => micRecorder.state === 'inactive';
      const reattachMic = async () => {
        if (!recordCtx || !recordDest || recorderStopped()) return;
        try {
          let next: MediaStream;
          try {
            next = await navigator.mediaDevices.getUserMedia({ audio: micConstraints });
          } catch {
            next = await navigator.mediaDevices.getUserMedia({ audio: true });
          }
          if (recorderStopped()) {
            next.getTracks().forEach((t) => t.stop());
            return;
          }
          micSource?.disconnect();
          micSource = recordCtx.createMediaStreamSource(next);
          if (muteGain) micSource.connect(muteGain); // gain value is untouched: a muted state survives the device switch
          else micSource.connect(recordDest);
          if (rawMicAnalyser) micSource.connect(rawMicAnalyser);
          streamRef.current = next;
          if (!muteGain) next.getAudioTracks().forEach((t) => { t.enabled = !micMutedRef.current; });
          watchMicTrack(next);
          setCaptureLost(false);
          setMicNotice('Microphone was disconnected — recording continues with the current microphone.');
        } catch {
          setCaptureLost(true);
          setMicNotice('Microphone was disconnected — your side is silent until a microphone is available again.');
        }
      };
      const watchMicTrack = (stream: MediaStream) => {
        stream.getAudioTracks()[0]?.addEventListener('ended', () => { void reattachMic(); }, { once: true });
      };
      if (recordCtx) watchMicTrack(micStream);

      micRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
          void saveRecordingProgress(
            recordedChunksRef.current,
            captureSystemAudio && !serverCapture ? soundChunksRef.current : null,
            micRecorder.mimeType || 'audio/webm',
            language,
            captureSystemAudio && !serverCapture,
          );
        }
      };

      micRecorder.onstop = async () => {
        const mutes = muteIntervalsRef.current.slice();
        const activeMicStream = streamRef.current ?? micStream;
        activeMicStream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        if (recordCtxRef.current) {
          void recordCtxRef.current.close().catch(() => {});
          recordCtxRef.current = null;
        }

        const blob = new Blob(recordedChunksRef.current, {
          type: micRecorder.mimeType || 'audio/webm',
        });

        if (blob.size === 0) {
          setError('Recording produced no audio data — please try again');
          return;
        }

        if (captureSystemAudio && serverCapture) {
          await uploadWithServerCapture(blob, serverCapture, mutes);
        } else if (captureSystemAudio) {
          dualState.mic = blob;
          dualState.mutes = mutes;
          void tryDualUpload();
        } else {
          const extension = blob.type.includes('wav') ? 'wav' : 'webm';
          const file = new File([blob], `recording-${ts}.${extension}`, {
            type: blob.type,
          });

          setIsUploading(true);
          setUploadProgress(null);
          try {
            await uploadAudio(file, language, setUploadProgress, liveKeyHolder.key, mutes);
            onUploaded();
          } catch (err) {
            setError((err as Error).message || 'Upload failed');
          } finally {
            setIsUploading(false);
            setUploadProgress(null);
          }
        }
      };

      mediaRecorderRef.current = micRecorder;

      if (useServerCapture) {
        try {
          // AUG-188: always tee live PCM so Start Live Text can attach in a Default recording; the tee is drained when nothing is attached and the WAV is unchanged.
          serverCapture = await startServerCapture({ live: true });
        } catch (err) {
          setCaptureNotice(`Direct system capture failed to start (${(err as Error).message}) — falling back to the browser screen picker.`);
        }
      }

      if (captureSystemAudio && !serverCapture) {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: true,
        });
        displayStream.getVideoTracks().forEach((t) => t.stop());

        const audioTracks = displayStream.getAudioTracks();
        if (audioTracks.length === 0) {
          displayStream.getTracks().forEach((t) => t.stop());
          throw new Error('No system audio captured — make sure to share a tab or screen with audio enabled');
        }

        soundStreamRef.current = displayStream;
        liveSystemStream = displayStream;
        // "Stop sharing" in the browser picker ends the system track while the mic keeps recording.
        audioTracks[0].addEventListener('ended', () => {
          if (!recorderStopped()) setCaptureLost(true);
        }, { once: true });

        soundChunksRef.current = [];
        const soundRecorder = mimeType
          ? new MediaRecorder(displayStream, { mimeType })
          : new MediaRecorder(displayStream);

        soundRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) soundChunksRef.current.push(event.data);
        };

        soundRecorder.onstop = async () => {
          displayStream.getTracks().forEach((track) => track.stop());
          soundStreamRef.current = null;

          const blob = new Blob(soundChunksRef.current, {
            type: soundRecorder.mimeType || 'audio/webm',
          });

          dualState.system = blob;
          void tryDualUpload();
        };

        soundRecorderRef.current = soundRecorder;
        soundRecorder.start(30000);

        const ctx = new AudioContext();
        audioContextRef.current = ctx;
        const mixMicSource = ctx.createMediaStreamSource(recordStream);
        const soundSource = ctx.createMediaStreamSource(displayStream);
        const dest = ctx.createMediaStreamDestination();
        mixMicSource.connect(dest);
        soundSource.connect(dest);
        levelStream = dest.stream;
      }

      micRecorder.start(30000);
      micStartedAtRef.current = Date.now();

      setElapsedSeconds(0);
      const startTime = Date.now();
      timerIntervalRef.current = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);

      let analyserCtx = audioContextRef.current;
      if (!analyserCtx) {
        analyserCtx = new AudioContext();
        audioContextRef.current = analyserCtx;
      }
      const analyser = analyserCtx.createAnalyser();
      analyser.fftSize = 256;
      const analyserSource = analyserCtx.createMediaStreamSource(levelStream);
      analyserSource.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        const binsPerBar = Math.floor(dataArray.length / AUDIO_BARS_COUNT);
        const levels: number[] = [];
        for (let b = 0; b < AUDIO_BARS_COUNT; b++) {
          let barSum = 0;
          for (let j = 0; j < binsPerBar; j++) {
            barSum += dataArray[b * binsPerBar + j];
          }
          levels.push(barSum / binsPerBar / 255);
        }
        setAudioLevels(levels);
        animationFrameRef.current = requestAnimationFrame(updateLevel);
      };
      animationFrameRef.current = requestAnimationFrame(updateLevel);

      setIsRecording(true);
      onRecordingChange?.(true);

      recordingLiveSourceRef.current = { micStream: recordStream, systemStream: liveSystemStream, captureId: serverCapture?.captureId ?? null };
      if (useLive) {
        liveStartArgsRef.current = { micStream: recordStream, systemStream: liveSystemStream, engine: liveEngine, captureId: serverCapture?.captureId ?? null };
        startLiveTranscription(recordStream, liveSystemStream, liveEngine, serverCapture?.captureId ?? null);
      } else startMeetingSocket();
    } catch (err) {
      recordCtxRef.current?.close().catch(() => {});
      recordCtxRef.current = null;
      setError(
        'Could not access audio device: ' + ((err as Error).message || 'unknown error'),
      );
    }
  }, [language, onUploaded, selectedMicId, captureSystemAudio, startLiveTranscription, startMeetingSocket, preferences?.systemAudioSource, captureCapabilities, onCaptureCapabilitiesChange, preferences?.compactEnabled, preferences?.compactMode, preferences?.liveEngine, groqAvailable]);

  // AUG-181: stable toggle, refs only; ignored when not recording.
  const setMicMute = useCallback((next: boolean) => {
    const rec = mediaRecorderRef.current;
    if (!rec || rec.state !== 'recording' || micMutedRef.current === next) return;
    micMutedRef.current = next;
    const gain = muteGainRef.current;
    const ctx = recordCtxRef.current;
    if (gain && ctx) {
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(next ? 0 : 1, t + 0.015);
    } else {
      // No Web Audio graph (plain browser tab): a disabled track records silence and keeps the file length.
      streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    }
    const at = Math.max(0, Date.now() - micStartedAtRef.current);
    if (next) {
      muteStartRef.current = at;
      if (liveClientRef.current) setLiveLines((prev) => [...prev, { speaker: 'Me', text: '— mic muted —', kind: 'gap' }]);
    } else {
      if (muteStartRef.current !== null) muteIntervalsRef.current.push({ startMs: muteStartRef.current, endMs: at });
      muteStartRef.current = null;
      setMutedSpeechHint(false);
    }
    setMicMuted(next);
  }, []);
  const toggleMicMute = useCallback(() => setMicMute(!micMutedRef.current), [setMicMute]);

  const stopRecording = useCallback(() => {
    if (muteStartRef.current !== null) {
      muteIntervalsRef.current.push({ startMs: muteStartRef.current, endMs: Math.max(0, Date.now() - micStartedAtRef.current) });
      muteStartRef.current = null;
    }
    mediaRecorderRef.current?.stop();
    soundRecorderRef.current?.stop();
    soundRecorderRef.current = null;
    setIsRecording(false);
    onRecordingChange?.(false);
    setShowDefaultsInfo(false);

    if (liveClientRef.current) {
      liveClientRef.current.stop();
      liveClientRef.current = null;
    }
    meetingClientRef.current?.stop();
    meetingClientRef.current = null;
    setMeetingActive(false);
    assistantStore.reset(); // AUG-199: tabs and chats belong to one meeting
    liveKeyRef.current = null; // the recording's onstop closure keeps its own copy for the upload
    liveStartArgsRef.current = null;
    recordingLiveSourceRef.current = null;
    liveKeyHolderRef.current = null;
    setCaptureLost(false);
    micMutedRef.current = false;
    setMicMuted(false);
    setMutedSpeechHint(false);
    muteGainRef.current = null;
    rawMicAnalyserRef.current = null;
    setLiveActive(false);
    setLiveHidden(false);

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    setElapsedSeconds(0);

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    analyserRef.current = null;
    setAudioLevels(new Array(AUDIO_BARS_COUNT).fill(0));
    void clearRecoveredRecording();
  }, []);

  useEffect(() => {
    return () => {
      liveClientRef.current?.stop();
      meetingClientRef.current?.stop();
      assistantStore.setLive(false);
      assistantStore.bind(null);
      liveColumnsStore.setLiveVisible(false);
    };
  }, []);

  // AUG-199: pin-bar toggles for the live columns exist only while the live panel is on screen.
  const panelActive = liveActive || meetingActive; // AUG-200
  const liveVisible = panelActive && !liveHidden;
  useEffect(() => {
    liveColumnsStore.setLiveVisible(liveVisible, liveActive);
  }, [liveVisible, liveActive]);

  // AUG-199: Ctrl/Cmd+3 toggles ASSISTANT, Ctrl/Cmd+4 toggles COPILOT (Cmd on macOS, Ctrl elsewhere); modifiers work inside inputs too.
  useEffect(() => {
    if (!liveVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.shiftKey) return;
      const mod = isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod) return;
      const target = e.code === 'Digit3' || e.key === '3' ? 'as' : e.code === 'Digit4' || e.key === '4' ? 'cp' : null;
      if (!target || (target === 'cp' && !liveActive)) return; // AUG-200: no COPILOT without a transcript
      e.preventDefault();
      liveColumnsStore.toggle(target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [liveVisible, liveActive]);

  useEffect(() => {
    if (!isRecording) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isRecording]);

  useEffect(() => {
    if (!showDefaultsInfo) return;
    const t = setTimeout(() => setShowDefaultsInfo(false), 30000);
    return () => clearTimeout(t);
  }, [showDefaultsInfo]);

  useEffect(() => {
    getRecoveredRecording().then((rec) => {
      if (rec) setRecoveredRecording(rec);
    }).catch(() => {});
  }, []);

  // Quick start with saved defaults — shared by the long-press gesture and the desktop hotkey/tray toggle.
  const quickStartRecording = useCallback(() => {
    const mode = preferences?.recordingMode || 'default';
    const engine = preferences?.liveEngine || 'local';
    void startRecording(mode === 'live', engine);
    setShowDefaultsInfo(true);
  }, [preferences?.recordingMode, preferences?.liveEngine, startRecording]);

  // AUG-182: End Meeting on the circuit center node is hold-to-stop (1.5 s), never a click.
  const endHold = useHoldToStop<HTMLButtonElement>({ onComplete: stopRecording, disabled: !isRecording || isUploading });

  const handleRecordButtonClick = useCallback(() => {
    if (isRecording) {
      longPressFiredRef.current = false;
      return;
    }
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    setShowModePicker(true);
  }, [isRecording, stopRecording]);

  const handlePointerDown = useCallback((_e: React.PointerEvent) => {
    if (isRecording || isUploading) return;
    longPressFiredRef.current = false;
    setLongPressing(true);
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      setLongPressing(false);
      quickStartRecording();
    }, 500);
  }, [isRecording, isUploading, quickStartRecording]);

  const handlePointerUp = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    setLongPressing(false);
  }, []);

  // Desktop shell toggle (global hotkey / tray): stop when recording, otherwise start with saved defaults.
  // The request is acknowledged first so a later remount of FileUpload never replays it.
  useEffect(() => {
    if (desktopToggleRequest == null) return;
    onDesktopToggleHandled?.();
    if (isRecording) {
      stopRecording();
      return;
    }
    if (isUploading) return;
    setShowModePicker(false);
    quickStartRecording();
    // Intentionally keyed on the request only: the other values are read at trigger time.
  }, [desktopToggleRequest]);

  const handleModeSelect = useCallback(
    (mode: RecordingMode, engine?: LiveEngine) => {
      setShowModePicker(false);
      void startRecording(mode === 'live', engine);
    },
    [startRecording],
  );

  const handleLivePause = useCallback(() => liveClientRef.current?.pause(), []);
  const handleLiveResume = useCallback(() => liveClientRef.current?.resume(), []);
  const handleLiveCopyAll = useCallback(() => {
    writeClipboard(liveLinesToText(liveLines)).catch(() => {});
  }, [liveLines]);
  // AUG-182: clear only after the clipboard write resolves; remove the copied line objects by identity so a chunk
  // that arrives (or merges into the last line) during the write is kept, never lost. Rejection -> nothing removed.
  const handleLiveCopyAndClear = useCallback(() => {
    if (liveLines.length === 0) return;
    const copied = new Set(liveLines);
    writeClipboard(liveLinesToText(liveLines)).then(
      () => setLiveLines((prev) => prev.filter((l) => !copied.has(l))),
      () => {},
    );
  }, [liveLines]);
  const handleLiveHide = useCallback(() => {
    setLiveHidden(true);
  }, []);

  const handleLiveStop = useCallback(() => {
    liveClientRef.current?.stop();
    liveClientRef.current = null;
    // AUG-200: the columns stay through a meeting-only socket
    const rec = mediaRecorderRef.current;
    if (rec && rec.state === 'recording') startMeetingSocket();
    else { assistantStore.setLive(false); assistantStore.bind(null); }
    liveStartArgsRef.current = null;
    setLiveActive(false);
    setLiveHidden(false);
    setLiveLines([]);
    setLiveError(null);
    setLiveWarning(null);
    setLiveMicUnavailable(false);
  }, [startMeetingSocket]);

  const handleActionParticipants = useCallback((p: Participants) => {
    liveParticipantsRef.current = p;
    setLiveParticipants(p);
    controlClient()?.setParticipants(p);
  }, []);
  const handleActionEdit = useCallback((id: string, patch: { text?: string; owner?: string }) => controlClient()?.editActionItem(id, patch), []);
  const handleActionDelete = useCallback((id: string) => controlClient()?.deleteActionItem(id), []);
  const handleActionAdd = useCallback((text: string, owner: string) => controlClient()?.addActionItem(text, owner || undefined), []);

  const handleLiveClearAll = useCallback(() => {
    setLiveLines([]);
  }, []);

  // Compact Mode retry: the server detaches the capture tee on WS stop and re-attaches on attach-capture, so this is safe.
  const handleLiveRetry = useCallback(() => {
    const args = liveStartArgsRef.current;
    if (!args || !liveClientRef.current) return;
    liveClientRef.current.stop();
    startLiveTranscription(args.micStream, args.systemStream, args.engine, args.captureId, true);
  }, [startLiveTranscription]);

  // AUG-188: Start Live Text again — after Stop Live Text or in a recording started without Live. Saved engine, empty window;
  // the recording and the server capture keep running (attach-capture re-attaches, same path as Retry).
  const handleLiveRestart = useCallback(() => {
    const src = recordingLiveSourceRef.current;
    const rec = mediaRecorderRef.current;
    if (!src || liveClientRef.current || !rec || rec.state !== 'recording') return;
    const engine: LiveEngine = preferences?.liveEngine === 'groq' && groqAvailable ? 'groq' : 'local';
    if (!liveKeyRef.current) {
      const key = crypto.randomUUID();
      liveKeyRef.current = key;
      if (liveKeyHolderRef.current) liveKeyHolderRef.current.key = key;
      liveParticipantsRef.current = { me: '', them: '' };
      setLiveParticipants({ me: '', them: '' });
    }
    liveStartArgsRef.current = { micStream: src.micStream, systemStream: src.systemStream, engine, captureId: src.captureId };
    startLiveTranscription(src.micStream, src.systemStream, engine, src.captureId);
  }, [preferences?.liveEngine, groqAvailable, startLiveTranscription]);

  // Compact Mode bridge: publish a snapshot for the widgets and register stable actions (latest callbacks via ref).
  useEffect(() => {
    compactStore.publish({
      recording: isRecording,
      live: liveActive,
      lines: liveLines,
      liveStatus: liveActive ? liveStatus : null,
      liveError,
      captureLost,
      elapsedSeconds,
      levels: audioLevels,
      dualTrack: captureSystemAudio,
      skipClearConfirmation: preferences?.skipClearConfirmation ?? false,
      actionItems: liveActionItems,
      participants: liveParticipants,
      actionEnabled: liveActionEnabled,
      actionOffReason: liveActionOffReason,
      meeting: meetingActive,
      micMuted,
      mutedHint: mutedSpeechHint,
    });
  }, [isRecording, liveActive, liveLines, liveStatus, liveError, captureLost, elapsedSeconds, audioLevels, captureSystemAudio, preferences?.skipClearConfirmation, liveActionItems, liveParticipants, liveActionEnabled, liveActionOffReason, meetingActive, micMuted, mutedSpeechHint]);

  const compactActionsRef = useRef({ stopRecording, handleLivePause, handleLiveResume, handleLiveStop, handleLiveRetry, handleLiveRestart, handleLiveCopyAll, handleLiveCopyAndClear, handleLiveClearAll, handleActionAdd, handleActionEdit, handleActionDelete, setMicMute });
  compactActionsRef.current = { stopRecording, handleLivePause, handleLiveResume, handleLiveStop, handleLiveRetry, handleLiveRestart, handleLiveCopyAll, handleLiveCopyAndClear, handleLiveClearAll, handleActionAdd, handleActionEdit, handleActionDelete, setMicMute };
  useEffect(() => {
    compactStore.setActions({
      end: () => compactActionsRef.current.stopRecording(),
      pauseLive: () => compactActionsRef.current.handleLivePause(),
      resumeLive: () => compactActionsRef.current.handleLiveResume(),
      stopLive: () => compactActionsRef.current.handleLiveStop(),
      retryLive: () => compactActionsRef.current.handleLiveRetry(),
      copyAll: () => compactActionsRef.current.handleLiveCopyAll(),
      copyAndClear: () => compactActionsRef.current.handleLiveCopyAndClear(),
      clearLive: () => compactActionsRef.current.handleLiveClearAll(),
      showLivePanel: () => setLiveHidden(false),
      addActionItem: (text, owner) => compactActionsRef.current.handleActionAdd(text, owner),
      editActionItem: (id, patch) => compactActionsRef.current.handleActionEdit(id, patch),
      deleteActionItem: (id) => compactActionsRef.current.handleActionDelete(id),
      setMicMuted: (muted) => compactActionsRef.current.setMicMute(muted),
      startLive: () => compactActionsRef.current.handleLiveRestart(),
      sendToPraxis: (ids) => {
        const liveKey = liveKeyRef.current;
        if (liveKey && ids.length > 0) setPraxisExport({ ids, mode: 'separate', liveKey });
      },
    });
    return () => compactStore.setActions(null);
  }, []);

  // AUG-181: "You're muted" hint - raw mic (before the mute gain) carries speech for ~2 s while muted.
  useEffect(() => {
    if (!isRecording || !micMuted || !rawMicAnalyserRef.current) return;
    const analyser = rawMicAnalyserRef.current;
    const buf = new Float32Array(analyser.fftSize);
    const frame = Math.max(1, Math.round(analyser.context.sampleRate * 0.02));
    let speechMs = 0;
    let silenceMs = 0;
    let shown = false;
    hintTimerRef.current = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      // same frame RMS threshold as the live chunker (liveTranscriptionClient.ts SPEECH_FRAME_RMS_THRESHOLD)
      let speech = false;
      for (let off = 0; off + frame <= buf.length && !speech; off += frame) {
        let sum = 0;
        for (let k = off; k < off + frame; k++) sum += buf[k] * buf[k];
        if (Math.sqrt(sum / frame) > 0.006) speech = true;
      }
      if (speech) { speechMs += 100; silenceMs = 0; } else { silenceMs += 100; }
      if (!shown) {
        if (silenceMs >= 1500) speechMs = 0;
        if (speechMs >= 2000) { shown = true; setMutedSpeechHint(true); }
      } else if (silenceMs >= 5000) {
        shown = false;
        speechMs = 0;
        setMutedSpeechHint(false);
      }
    }, 100);
    return () => {
      if (hintTimerRef.current) { clearInterval(hintTimerRef.current); hintTimerRef.current = null; }
    };
  }, [isRecording, micMuted]);

  // AUG-181: desktop bridge (shortcut toggle + muted state back to the shell)
  useEffect(() => { window.august?.setMicMutedState?.(micMuted); }, [micMuted]);
  useEffect(() => {
    const off = window.august?.onToggleMute?.(() => toggleMicMute());
    return () => { off?.(); };
  }, [toggleMicMute]);

  const canCompact = Boolean(window.august?.setCompactMode) && (preferences?.compactEnabled ?? true);

  const handleRecoveryUpload = useCallback(async () => {
    if (!recoveredRecording) return;
    const { micBlob, systemBlob, mimeType, language: recLang, dualTrack } = recoveredRecording;
    if (micBlob.size === 0) {
      setError('Recovered recording is empty — it cannot be transcribed');
      setRecoveredRecording(null);
      void clearRecoveredRecording();
      return;
    }
    setRecoveredRecording(null);
    setIsUploading(true);
    setUploadProgress(null);
    setError(null);
    try {
      const ext = mimeType.includes('wav') ? 'wav' : 'webm';
      const ts = Date.now();
      if (dualTrack && systemBlob) {
        const micFile = new File([micBlob], `recovered-${ts}-mic.${ext}`, { type: mimeType });
        const sysFile = new File([systemBlob], `recovered-${ts}-system.${ext}`, { type: mimeType });
        await uploadDualAudio(micFile, sysFile, recLang, setUploadProgress);
      } else {
        const micFile = new File([micBlob], `recovered-${ts}.${ext}`, { type: mimeType });
        await uploadAudio(micFile, recLang, setUploadProgress);
      }
      onUploaded();
    } catch (err) {
      setError((err as Error).message || 'Recovery upload failed');
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
    }
    void clearRecoveredRecording();
  }, [recoveredRecording, onUploaded]);

  const handleRecoveryDismiss = useCallback(() => {
    setRecoveredRecording(null);
    void clearRecoveredRecording();
  }, []);

  // AUG-200: one ACTION ITEMS column for the Live and the meeting panel.
  const actionItemsColumn = (
    <ActionItemsPanel
      variant="live"
      embedded
      items={liveActionItems}
      participants={liveParticipants}
      enabled={liveActionEnabled}
      offReason={liveActionOffReason}
      onParticipantsChange={handleActionParticipants}
      onAdd={handleActionAdd}
      onEdit={handleActionEdit}
      onDelete={handleActionDelete}
      onSendToPraxis={(ids, mode) => {
        const liveKey = liveKeyRef.current;
        if (liveKey) setPraxisExport({ ids, mode, liveKey });
      }}
    />
  );

  return (
    <div className={`circuit-layout${isRecording ? ' circuit-recording' : ''}${panelActive && !liveHidden ? ' live-open' : ''}`}>
      <h2 className="circuit-title">New Transcription</h2>

      <div className="circuit-diagram">
        <svg className="circuit-svg" viewBox="0 0 480 384" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <line x1="201" y1="161" x2="111" y2="89" className="circuit-line" />
          <line x1="279" y1="161" x2="369" y2="89" className="circuit-line" />
          <line x1="201" y1="223" x2="111" y2="295" className="circuit-line" />
          <line x1="279" y1="223" x2="369" y2="295" className="circuit-line" />
          {isRecording && (
            <>
              <circle cx="240" cy="192" r="55" className="circuit-pulse-ring circuit-pulse-ring--1" />
              <circle cx="240" cy="192" r="55" className="circuit-pulse-ring circuit-pulse-ring--2" />
              <circle cx="240" cy="192" r="55" className="circuit-pulse-ring circuit-pulse-ring--3" />
            </>
          )}
        </svg>

        <button
          type="button"
          className="circuit-node circuit-node--corner circuit-node--top-left"
          aria-label="Language selection"
          onClick={() => !isUploading && !isRecording && setShowLangPicker(true)}
          disabled={isUploading || isRecording}
        >
          <span className="circuit-node-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
          </span>
          <span className="circuit-node-label">{language === 'auto' ? 'Auto' : language.toUpperCase()}</span>
        </button>
        {showLangPicker && (
          <LanguagePicker
            current={language}
            onSelect={(lang) => { setLanguage(lang); setShowLangPicker(false); onPreferenceChange?.({ language: lang }); }}
            onClose={() => setShowLangPicker(false)}
          />
        )}

        <button
          type="button"
          className={`circuit-node circuit-node--corner circuit-node--top-right${isRecording && micMuted ? ' circuit-node--muted' : ''}`}
          aria-label={isRecording ? (micMuted ? 'Unmute microphone' : 'Mute microphone') : 'Microphone selection'}
          aria-pressed={isRecording ? micMuted : undefined}
          title={isRecording ? "Mute in August's recording" : undefined}
          onClick={() => { if (isRecording) toggleMicMute(); else if (!isUploading) setShowMicPicker(true); }}
          disabled={isUploading}
        >
          <span className="circuit-node-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="11" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><line x1="12" y1="19" x2="12" y2="22" />{isRecording && micMuted && <line x1="3" y1="3" x2="21" y2="21" />}</svg>
          </span>
          <span className="circuit-node-label">{micMuted && isRecording ? 'Muted' : 'Mic'}</span>
        </button>
        {showMicPicker && (
          <MicPicker
            devices={audioDevices}
            selectedId={selectedMicId}
            onSelect={(id) => { setSelectedMicId(id); setShowMicPicker(false); onPreferenceChange?.({ micDeviceId: id || 'default' }); }}
            onClose={() => setShowMicPicker(false)}
          />
        )}

        <button type="button" ref={endHold.ref} className={`circuit-node circuit-node--center${longPressing ? ' circuit-node--long-pressing' : ''}`} {...(isRecording ? endHold.handlers : { onClick: handleRecordButtonClick, onPointerDown: handlePointerDown, onPointerUp: handlePointerUp, onPointerLeave: handlePointerUp, onPointerCancel: handlePointerUp })} disabled={isUploading} aria-label={isRecording ? 'End Meeting (hold 1.5 seconds)' : 'Start recording'} title={isRecording ? 'Hold 1.5 s to end the meeting' : undefined}>
          {isRecording && (
            <svg className="hold-stop-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" /></svg>
          )}
          {longPressing && (
            <svg className="long-press-ring" viewBox="0 0 100 100" aria-hidden="true">
              <defs>
                <filter id="long-press-glow">
                  <feGaussianBlur stdDeviation="2" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <circle className="long-press-ring-outer" cx="50" cy="50" r="46" />
              <circle className="long-press-ring-inner" cx="50" cy="50" r="36" />
            </svg>
          )}
          <span className="circuit-node-ring" aria-hidden="true" />
          <span className="circuit-node-glyph" aria-hidden="true">{isRecording ? <span className="circuit-stop-icon" /> : '●'}</span>
          <span className="circuit-node-text">{isRecording ? (endHold.hintVisible ? 'HOLD' : 'END') : 'REC'}</span>
        </button>

        {isRecording && (
          <div className="circuit-audio-bars" aria-hidden="true">
            {audioLevels.map((level, i) => (
              <div key={i} className="circuit-audio-bar-wrap" style={{ transform: `rotate(${i * 30}deg)` }}>
                <div className="circuit-audio-bar" style={{ height: `${BAR_BASE_HEIGHT[i] + level * 18}px` }} />
              </div>
            ))}
          </div>
        )}

        <label className={`circuit-node circuit-node--corner circuit-node--bottom-left${captureSystemAudio ? ' circuit-node--active' : ''}`} title={resolvedSystemSource === 'system' ? 'Captures system audio directly on the local server' : 'Captures system audio via screen sharing'}>
          <span className="circuit-node-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 10v3a1 1 0 0 0 1 1h3l4 4V5L6 9H3a1 1 0 0 0-1 1z" />
              {captureSystemAudio ? (
                <><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></>
              ) : (
                <line x1="23" y1="9" x2="17" y2="15" />
              )}
            </svg>
          </span>
          <span className="circuit-node-label">{captureSystemAudio ? 'On' : 'Off'}</span>
          <input type="checkbox" className="circuit-node-checkbox" checked={captureSystemAudio} onChange={(e) => { setCaptureSystemAudio(e.target.checked); onPreferenceChange?.({ systemAudio: e.target.checked }); }} disabled={isUploading || isRecording} aria-label="Capture system audio" />
        </label>

        <button type="button" className="circuit-node circuit-node--corner circuit-node--bottom-right" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          <span className="circuit-node-icon" aria-hidden="true">
            {theme === 'dark' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
            )}
          </span>
          <span className="circuit-node-label">{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>

        {showModePicker && (
          <RecordingModePicker onSelect={handleModeSelect} onClose={() => setShowModePicker(false)} groqAvailable={groqAvailable} onGroqKeySaved={onGroqKeySaved} />
        )}
      </div>

      {micNotice && (
        <div className="mic-notice">
          <span>{micNotice}</span>
          <button type="button" className="mic-notice-dismiss" onClick={() => setMicNotice(null)}>×</button>
        </div>
      )}
      {captureNotice && (
        <div className="mic-notice">
          <span>{captureNotice}</span>
          <button type="button" className="mic-notice-dismiss" onClick={() => setCaptureNotice(null)}>×</button>
        </div>
      )}

      {isRecording && (
        <div className="circuit-recording-info">
          <span className="recording-dot" aria-hidden="true" />
          <span className="recording-timer">{formatTime(elapsedSeconds)}</span>
          {captureSystemAudio && <span className="recording-tracks">2 tracks</span>}
          {micMuted && <span className="recording-mute-tag" title="Mute in August's recording">MIC OFF — your side is not recorded</span>}
          {canCompact && (
            <button type="button" className="recording-compact-btn" onClick={() => compactStore.requestCompact()} title="Shrink August to a widget (Ctrl/Cmd+Shift+C)">[ ⤡ COMPACT ]</button>
          )}
          {!liveActive && (
            <button type="button" className="recording-compact-btn recording-start-live-btn" onClick={handleLiveRestart} title="Start live text again. Recording continues.">[ ▶&#xFE0E; START LIVE TEXT ]</button>
          )}
          {meetingActive && liveHidden && (
            <button type="button" className="recording-compact-btn" onClick={() => setLiveHidden(false)} title="Show action items and the assistant">[ ACTION ITEMS{liveActionItems.length > 0 ? ` · ${liveActionItems.length}` : ''} ]</button>
          )}
          {liveActive && (
            <button type="button" className={`recording-live-badge${liveHidden ? '' : ' recording-live-badge--dim'}`} onClick={() => setLiveHidden(prev => !prev)} aria-label={liveHidden ? 'Show live transcript' : 'Hide live transcript'}>
              <span className="recording-live-dot" aria-hidden="true" />
              LIVE
            </button>
          )}
        </div>
      )}

      {isRecording && mutedSpeechHint && <div className="mic-notice mic-notice--muted" role="status">You're muted in August</div>}

      {showDefaultsInfo && isRecording && (
        <div className="recording-defaults-banner">
          <span className="defaults-banner-text">
            Recording with default options
          </span>
          <div className="defaults-banner-actions">
            <button type="button" className="defaults-btn defaults-btn--settings" onClick={() => onOpenSettings?.()}>Set defaults</button>
            <button type="button" className="defaults-btn defaults-btn--dismiss" onClick={() => setShowDefaultsInfo(false)}>&times;</button>
          </div>
        </div>
      )}

      {recoveredRecording && !isRecording && !isUploading && (
        <div className="recording-recovery-banner">
          <span className="recovery-banner-text">
            Recovered {formatBytes(recoveredRecording.micBlob.size + (recoveredRecording.systemBlob?.size || 0))} from interrupted session
          </span>
          <div className="recovery-banner-actions">
            <button type="button" className="recovery-btn recovery-btn--upload" onClick={handleRecoveryUpload}>Upload</button>
            <button type="button" className="recovery-btn recovery-btn--dismiss" onClick={handleRecoveryDismiss}>Dismiss</button>
          </div>
        </div>
      )}

      <div
        className={`circuit-dropzone${isDragging ? ' dragging' : ''}${isUploading ? ' uploading' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => !isUploading && fileInputRef.current?.click()}
      >
        {isUploading ? (
          <div className="upload-progress">
            {uploadProgress && uploadProgress.loaded < uploadProgress.total ? (
              <>
                <div className="upload-progress-bar-track">
                  <div className="upload-progress-bar-fill" style={{ width: `${Math.round((uploadProgress.loaded / uploadProgress.total) * 100)}%` }} />
                </div>
                <p className="upload-progress-text">
                  {Math.round((uploadProgress.loaded / uploadProgress.total) * 100)}%
                  {' — '}
                  {formatBytes(uploadProgress.loaded)} / {formatBytes(uploadProgress.total)}
                </p>
              </>
            ) : (
              <>
                <div className="spinner" />
                <p>Starting transcription&hellip;</p>
              </>
            )}
          </div>
        ) : (
          <>
            <p className="dropzone-title">Drag &amp; drop an audio or video file here</p>
            <p className="dropzone-subtitle">or click to browse</p>
            <p className="dropzone-formats">{ACCEPTED_EXTENSIONS.join(', ')}</p>
          </>
        )}
        <input ref={fileInputRef} type="file" accept={ACCEPTED_EXTENSIONS.join(',')} onChange={onFileInputChange} hidden />
      </div>

      <div className="circuit-link-section">
        <span className="circuit-link-label">or paste a link — media file, YouTube or Vimeo</span>
        <div className="circuit-link-row">
          <input
            type="url"
            className="circuit-link-input"
            placeholder="https://youtube.com/watch?v=… or https://example.com/recording.mp4"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleLinkSubmit(); }}
            disabled={isUploading || isRecording || isLinkSubmitting}
          />
          <button
            type="button"
            className="circuit-link-btn"
            onClick={() => void handleLinkSubmit()}
            disabled={isUploading || isRecording || isLinkSubmitting || !linkUrl.trim()}
          >
            {isLinkSubmitting ? '...' : 'Transcribe'}
          </button>
        </div>
      </div>

      {error && <div className="upload-error">{error}</div>}

      {liveActive && !liveHidden && (
        <LiveTranscriptPanel
          lines={liveLines}
          status={liveStatus}
          error={liveError}
          warning={liveWarning}
          micUnavailable={liveMicUnavailable}
          onPause={handleLivePause}
          onResume={handleLiveResume}
          onCopyAll={handleLiveCopyAll}
          onCopyAndClear={handleLiveCopyAndClear}
          skipClearConfirmation={preferences?.skipClearConfirmation ?? false}
          onClose={handleLiveHide}
          onStop={handleLiveStop}
          onClearAll={handleLiveClearAll}
          elapsed={formatTime(elapsedSeconds)}
          onEndRecording={stopRecording}
          onCompact={canCompact ? () => compactStore.requestCompact() : undefined}
          micMuted={micMuted}
          onToggleMute={toggleMicMute}
          mutedHint={mutedSpeechHint}
          ctxCount={ctxHintCount}
          onCtx={() => liveColumnsStore.show('cp')}
          columns={
            <LiveColumns
              actionCount={liveActionItems.length}
              projects={preferences?.praxisProjects ?? []}
              recentPaths={preferences?.praxisRecentPaths ?? []}
              onOpenSettings={(tab) => onOpenSettings?.(tab)}
              actionItems={actionItemsColumn}
            />
          }
        />
      )}
      {/* AUG-200: recording without Live Text: action items + ASSISTANT only */}
      {meetingActive && !liveActive && !liveHidden && (
        <LiveTranscriptPanel
          mode="meeting"
          onStartLive={handleLiveRestart}
          lines={[]}
          status="stopped"
          error={null}
          warning={null}
          micUnavailable={false}
          onPause={() => {}}
          onResume={() => {}}
          onCopyAll={() => {}}
          onCopyAndClear={() => {}}
          skipClearConfirmation
          onClose={handleLiveHide}
          onStop={() => {}}
          onClearAll={() => {}}
          elapsed={formatTime(elapsedSeconds)}
          onEndRecording={stopRecording}
          onCompact={canCompact ? () => compactStore.requestCompact() : undefined}
          micMuted={micMuted}
          onToggleMute={toggleMicMute}
          mutedHint={mutedSpeechHint}
          columns={
            <LiveColumns
              copilot={false}
              actionCount={liveActionItems.length}
              projects={preferences?.praxisProjects ?? []}
              recentPaths={preferences?.praxisRecentPaths ?? []}
              onOpenSettings={(tab) => onOpenSettings?.(tab)}
              actionItems={actionItemsColumn}
            />
          }
        />
      )}
      {praxisExport && (
        <PraxisModal
          sessionId=""
          sessionTitle="Live recording"
          projects={preferences?.praxisProjects ?? []}
          defaultPromptCustom={Boolean(preferences?.praxisDefaultPrompt?.trim())}
          recentPaths={preferences?.praxisRecentPaths ?? []}
          onPreferenceChange={onPreferenceChange}
          onClose={() => setPraxisExport(null)}
          actionItems={{
            mode: praxisExport.mode,
            count: praxisExport.ids.length,
            alreadySent: liveActionItems
              .filter((i) => praxisExport.ids.includes(i.id) && i.praxis)
              .map((i) => i.praxis!.taskId),
            onSubmit: async (projectPath, force) => {
              // AUG-166: live text exists only in memory; separate cards attach it as context
              const r = await sendActionItemsToPraxis({
                projectPath, mode: praxisExport.mode, itemIds: praxisExport.ids, liveKey: praxisExport.liveKey, force,
                transcript: liveLines.map((l) => l.kind === 'gap' ? l.text : `${l.speaker}: ${l.text}`).join('\n'),
              });
              setLiveActionItems(r.file.items);
              return { taskIds: r.tasks.map((t) => t.taskId) };
            },
          }}
        />
      )}
    </div>
  );
};

export default FileUpload;
