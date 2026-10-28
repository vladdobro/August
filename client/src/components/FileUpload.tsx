import React, { useCallback, useEffect, useRef, useState } from 'react';
import { uploadAudio, uploadDualAudio, uploadDualAudioWithCapture, startServerCapture, stopServerCapture, transcribeFromUrl, type UploadProgress } from '../api';
import type { CaptureCapabilities, ServerCapture, TranscriptionLanguage } from '../types';
import { useTheme } from '../theme';
import RecordingModePicker, { type RecordingMode } from './RecordingModePicker';
import LanguagePicker from './LanguagePicker';
import MicPicker from './MicPicker';
import LiveTranscriptPanel, { type LiveLine, type LiveStatus } from './LiveTranscriptPanel';
import { LiveTranscriptionClient, type LiveEngine } from '../services/liveTranscriptionClient';
import { saveRecordingProgress, getRecoveredRecording, clearRecoveredRecording, type RecoveredRecording } from '../services/recordingRecovery';
import { DEFAULT_PREFERENCES, resolveSystemAudioSource, type UserPreferences } from '../services/preferences';
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
  onOpenSettings?: () => void;
  // Desktop shell: a timestamp per global-hotkey/tray toggle request; consumed once via onDesktopToggleHandled.
  desktopToggleRequest?: number | null;
  onDesktopToggleHandled?: () => void;
}

function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

const FileUpload: React.FC<FileUploadProps> = ({ onUploaded, onRecordingChange, groqAvailable, onGroqKeySaved, preferences, onPreferenceChange, audioDevicesFromApp, captureCapabilities, onOpenSettings, desktopToggleRequest, onDesktopToggleHandled }) => {
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
  const [recoveredRecording, setRecoveredRecording] = useState<RecoveredRecording | null>(null);
  const [showDefaultsInfo, setShowDefaultsInfo] = useState(false);
  const liveClientRef = useRef<LiveTranscriptionClient | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const soundRecorderRef = useRef<MediaRecorder | null>(null);
  const soundChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const soundStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordCtxRef = useRef<AudioContext | null>(null);
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

  const startLiveTranscription = useCallback(
    (micStream: MediaStream | null, systemStream: MediaStream | null, engine: LiveEngine = 'local', captureId: string | null = null) => {
      setLiveLines([]);
      setLiveError(null);
      setLiveWarning(null);
      setLiveMicUnavailable(false);
      setLiveStatus('connecting');
      setLiveActive(true);

      const client = new LiveTranscriptionClient({
        onTranscript: (speaker, text) => {
          setLiveLines((prev) => {
            const last = prev.length > 0 ? prev[prev.length - 1] : null;
            if (last && last.speaker === speaker) {
              const updated = [...prev];
              updated[updated.length - 1] = { speaker, text: `${last.text} ${text}` };
              return updated;
            }
            return [...prev, { speaker, text }];
          });
        },
        onStatusChange: setLiveStatus,
        onError: setLiveError,
        onWarning: setLiveWarning,
        onMicUnavailable: () => setLiveMicUnavailable(true),
      });
      liveClientRef.current = client;
      client.start(micStream, systemStream, language, engine, captureId);
    },
    [language],
  );

  const startRecording = useCallback(async (liveMode: boolean = false, engine: LiveEngine = 'local') => {
    setError(null);
    setCaptureNotice(null);
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
      const useServerCapture = captureSystemAudio && resolvedSystemSource === 'system';
      if (captureSystemAudio && preferences?.systemAudioSource === 'system' && resolvedSystemSource === 'browser') {
        setCaptureNotice(`Direct system capture is unavailable — using the browser screen picker. ${captureCapabilities?.hint ?? ''}`.trim());
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
      if (micSource && recordDest) micSource.connect(recordDest);
      const recordStream = recordDest ? recordDest.stream : micStream;

      let levelStream: MediaStream = recordStream;

      const dualState = { mic: null as Blob | null, system: null as Blob | null, uploading: false };

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
          await uploadDualAudio(micFile, sysFile, language, setUploadProgress);
          onUploaded();
        } catch (err) {
          setError((err as Error).message || 'Upload failed');
        } finally {
          setIsUploading(false);
          setUploadProgress(null);
        }
      };

      const uploadWithServerCapture = async (micBlob: Blob, capture: ServerCapture) => {
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
            await uploadDualAudioWithCapture(micFile, capture.captureId, micStartedAtRef.current, language, setUploadProgress);
          } else {
            await uploadAudio(micFile, language, setUploadProgress);
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
          micSource.connect(recordDest);
          streamRef.current = next;
          watchMicTrack(next);
          setMicNotice('Microphone was disconnected — recording continues with the current microphone.');
        } catch {
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
          await uploadWithServerCapture(blob, serverCapture);
        } else if (captureSystemAudio) {
          dualState.mic = blob;
          void tryDualUpload();
        } else {
          const extension = blob.type.includes('wav') ? 'wav' : 'webm';
          const file = new File([blob], `recording-${ts}.${extension}`, {
            type: blob.type,
          });

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
        }
      };

      mediaRecorderRef.current = micRecorder;

      if (useServerCapture) {
        try {
          serverCapture = await startServerCapture({ live: liveMode });
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

      if (liveMode) {
        startLiveTranscription(recordStream, liveSystemStream, engine, serverCapture?.captureId ?? null);
      }
    } catch (err) {
      recordCtxRef.current?.close().catch(() => {});
      recordCtxRef.current = null;
      setError(
        'Could not access audio device: ' + ((err as Error).message || 'unknown error'),
      );
    }
  }, [language, onUploaded, selectedMicId, captureSystemAudio, startLiveTranscription, resolvedSystemSource, preferences?.systemAudioSource, captureCapabilities?.hint]);

  const stopRecording = useCallback(() => {
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
    };
  }, []);

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

  const handleRecordButtonClick = useCallback(() => {
    if (isRecording) {
      longPressFiredRef.current = false;
      stopRecording();
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
    const text = liveLines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
  }, [liveLines]);
  const handleLiveHide = useCallback(() => {
    setLiveHidden(true);
  }, []);

  const handleLiveStop = useCallback(() => {
    liveClientRef.current?.stop();
    liveClientRef.current = null;
    setLiveActive(false);
    setLiveHidden(false);
    setLiveLines([]);
    setLiveError(null);
    setLiveWarning(null);
    setLiveMicUnavailable(false);
  }, []);

  const handleLiveClearAll = useCallback(() => {
    setLiveLines([]);
  }, []);

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

  return (
    <div className={`circuit-layout${isRecording ? ' circuit-recording' : ''}${liveActive && !liveHidden ? ' live-open' : ''}`}>
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
          className="circuit-node circuit-node--corner circuit-node--top-right"
          aria-label="Microphone selection"
          onClick={() => !isUploading && !isRecording && setShowMicPicker(true)}
          disabled={isUploading || isRecording}
        >
          <span className="circuit-node-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="11" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><line x1="12" y1="19" x2="12" y2="22" /></svg>
          </span>
          <span className="circuit-node-label">Mic</span>
        </button>
        {showMicPicker && (
          <MicPicker
            devices={audioDevices}
            selectedId={selectedMicId}
            onSelect={(id) => { setSelectedMicId(id); setShowMicPicker(false); onPreferenceChange?.({ micDeviceId: id || 'default' }); }}
            onClose={() => setShowMicPicker(false)}
          />
        )}

        <button type="button" className={`circuit-node circuit-node--center${longPressing ? ' circuit-node--long-pressing' : ''}`} onClick={handleRecordButtonClick} onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} onPointerLeave={handlePointerUp} onPointerCancel={handlePointerUp} disabled={isUploading} aria-label={isRecording ? 'Stop recording' : 'Start recording'}>
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
          <span className="circuit-node-text">{isRecording ? 'STOP' : 'REC'}</span>
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
          {liveActive && (
            <button type="button" className={`recording-live-badge${liveHidden ? '' : ' recording-live-badge--dim'}`} onClick={() => setLiveHidden(prev => !prev)} aria-label={liveHidden ? 'Show live transcript' : 'Hide live transcript'}>
              <span className="recording-live-dot" aria-hidden="true" />
              LIVE
            </button>
          )}
        </div>
      )}

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
          onClose={handleLiveHide}
          onStop={handleLiveStop}
          onClearAll={handleLiveClearAll}
          elapsed={formatTime(elapsedSeconds)}
          onEndRecording={stopRecording}
        />
      )}
    </div>
  );
};

export default FileUpload;
