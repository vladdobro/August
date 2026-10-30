import React, { useCallback, useEffect, useRef, useState } from 'react';
import SessionList from './components/SessionList';
import FileUpload from './components/FileUpload';
import TranscriptView from './components/TranscriptView';
import ModelDownloadModal from './components/ModelDownloadModal';
import ArchivePage from './components/ArchivePage';
import { checkHealth, deleteSession, fetchCaptureCapabilities, fetchSessions, fetchTranscript, redownloadSessionAudio, renameSession, retranscribeSession, cancelTranscription } from './api';
import type { CaptureCapabilities, HealthStatus, SessionMetadata } from './types';
import SetupGuide from './components/SetupGuide';
import GroqKeyModal from './components/GroqKeyModal';
import SettingsModal from './components/SettingsModal';
import { getPreferences, patchPreferences, resetPreferences } from './services/preferences';
import type { UserPreferences } from './services/preferences';
import OverlayLayer, { type OverlayId } from './components/OverlayLayer';
import ControlsPanel from './components/ControlsPanel';
import CompactLayer from './components/compact/CompactLayer';
import { ThemeToggle } from './theme';
import { Agentation } from 'agentation';

const POLL_INTERVAL_MS = 5000;

const App: React.FC = () => {
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ffmpegAvailable, setFfmpegAvailable] = useState(false);
  const selectedSessionIdRef = useRef<string | null>(null);
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    session: SessionMetadata;
    timeoutId: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [showGroqKeyModal, setShowGroqKeyModal] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferences>({});
  const [showSettings, setShowSettings] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [captureCapabilities, setCaptureCapabilities] = useState<CaptureCapabilities | null>(null);
  // Desktop shell (Electron) only: a pending "toggle recording" request from the global hotkey or tray.
  const [desktopToggleRequest, setDesktopToggleRequest] = useState<number | null>(null);

  const [openOverlay, setOpenOverlay] = useState<OverlayId | null>(null);
  const closeOverlay = useCallback(() => setOpenOverlay(null), []);
  const toggleOverlay = useCallback((id: OverlayId) => setOpenOverlay(prev => (prev === id ? null : id)), []);

  selectedSessionIdRef.current = selectedSessionId;

  const refreshSessions = useCallback(async () => {
    try {
      const list = await fetchSessions();
      setSessions(list);
      setLoadError(null);
      return list;
    } catch (err) {
      setLoadError((err as Error).message || 'Failed to load sessions');
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
    const interval = setInterval(() => {
      void refreshSessions();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshSessions]);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await checkHealth();
      setHealthStatus(h);
      setFfmpegAvailable(h.ffmpegAvailable);
    } catch {
      setFfmpegAvailable(false);
    }
    try {
      setCaptureCapabilities(await fetchCaptureCapabilities());
    } catch {
      setCaptureCapabilities({ systemCapture: false, method: 'none', platform: 'unknown', hint: 'Capability probe failed — server unreachable', selfTest: 'skipped', selfTestDetail: 'capability probe failed' });
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    getPreferences().then(setPreferences).catch(() => {});
  }, []);

  // Desktop shell bridge (window.august, see client/src/desktop.d.ts). No-ops in the browser build.
  useEffect(() => {
    window.august?.setRecordingState(isRecording);
  }, [isRecording]);

  useEffect(() => {
    const desktop = window.august;
    if (!desktop) return;
    const offOpen = desktop.onOpenSession((id) => {
      setSelectedSessionId(id);
      setShowDiagnostics(false);
      setShowArchive(false);
      setSetupDismissed(true);
    });
    const offToggle = desktop.onToggleRecording(() => {
      // FileUpload only mounts on the "new session" view, so leave any open session/setup guide first.
      setSelectedSessionId(null);
      setShowDiagnostics(false);
      setShowArchive(false);
      setSetupDismissed(true);
      setDesktopToggleRequest(Date.now());
    });
    return () => {
      offOpen();
      offToggle();
    };
  }, []);

  // Layout overlays: Ctrl/Cmd+1 sessions, Ctrl/Cmd+2 controls, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
        const target: OverlayId | null = e.code === 'Digit1' || e.key === '1' ? 'sessions'
          : e.code === 'Digit2' || e.key === '2' ? 'controls' : null;
        if (target) {
          e.preventDefault();
          toggleOverlay(target);
          return;
        }
      }
      if (e.key === 'Escape') setOpenOverlay(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleOverlay]);

  useEffect(() => {
    const enumerate = async () => {
      try {
        const initial = await navigator.mediaDevices.enumerateDevices();
        const hasLabels = initial.some(d => d.kind === 'audioinput' && d.label);
        if (!hasLabels) {
          const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          tempStream.getTracks().forEach(t => t.stop());
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        setAudioDevices(devices.filter(d => d.kind === 'audioinput'));
      } catch {}
    };
    void enumerate();
    navigator.mediaDevices.addEventListener('devicechange', enumerate);
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerate);
  }, []);

  const handlePreferenceChange = useCallback(async (patch: Partial<UserPreferences>) => {
    try {
      const merged = await patchPreferences(patch);
      setPreferences(merged);
    } catch {}
  }, []);

  const handlePreferencesReset = useCallback(async () => {
    try {
      await resetPreferences();
      setPreferences({});
    } catch {}
  }, []);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null;

  useEffect(() => {
    if (!selectedSession) {
      setTranscript('');
      return;
    }
    if (selectedSession.status !== 'completed') {
      setTranscript('');
      return;
    }
    let cancelled = false;
    fetchTranscript(selectedSession.id)
      .then((text) => {
        if (!cancelled) setTranscript(text);
      })
      .catch(() => {
        if (!cancelled) setTranscript('');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSession?.id, selectedSession?.status]);

  const handleSelect = (id: string) => {
    setSelectedSessionId(id);
    setShowArchive(false);
  };

  const handleNewSession = () => {
    setSelectedSessionId(null);
  };

  const handleDelete = (id: string) => {
    if (pendingDelete) {
      clearTimeout(pendingDelete.timeoutId);
      setSessions(prev => prev.filter(s => s.id !== pendingDelete.session.id));
      deleteSession(pendingDelete.session.id).catch(() => {});
      setPendingDelete(null);
    }

    const session = sessions.find(s => s.id === id);
    if (!session) return;

    if (selectedSessionIdRef.current === id) {
      setSelectedSessionId(null);
    }

    const timeoutId = setTimeout(() => {
      setSessions(prev => prev.filter(s => s.id !== id));
      deleteSession(id).catch(err => {
        setLoadError((err as Error).message || 'Failed to delete session');
      });
      setPendingDelete(null);
    }, 5000);

    setPendingDelete({ session, timeoutId });
  };

  const handleUndoDelete = () => {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timeoutId);
    setPendingDelete(null);
  };

  const handleRename = async (id: string, title: string) => {
    setSessions(prev => prev.map(s => (s.id === id ? { ...s, title } : s)));
    try {
      await renameSession(id, title);
      await refreshSessions();
    } catch (err) {
      await refreshSessions();
      setLoadError((err as Error).message || 'Failed to rename session');
    }
  };

  const handleUploaded = async () => {
    const list = await refreshSessions();
    if (list && list.length > 0) {
      setSelectedSessionId(list[0].id);
    }
  };

  const handleRetranscribe = async (language?: string, boost?: boolean) => {
    if (!selectedSessionId) return;
    try {
      await retranscribeSession(selectedSessionId, language, boost);
      await refreshSessions();
    } catch (err) {
      setLoadError((err as Error).message || 'Failed to restart transcription');
    }
  };

  const handleRedownload = async () => {
    if (!selectedSessionId) return;
    try {
      await redownloadSessionAudio(selectedSessionId);
      await refreshSessions();
    } catch (err) {
      setLoadError((err as Error).message || 'Failed to re-download audio');
    }
  };

  const handleArchiveChanged = async (deletedIds: string[]) => {
    if (selectedSessionIdRef.current && deletedIds.includes(selectedSessionIdRef.current)) {
      setSelectedSessionId(null);
    }
    await refreshSessions();
  };

  const handleCancel = async () => {
    if (!selectedSessionId) return;
    try {
      await cancelTranscription(selectedSessionId);
      await refreshSessions();
    } catch (err) {
      setLoadError((err as Error).message || 'Failed to cancel transcription');
    }
  };

  const searchParams = new URLSearchParams(window.location.search);
  const forceDiag = searchParams.has('diagnostics');
  const mockParam = searchParams.get('mock');
  const needsSetup = healthStatus !== null
    && (forceDiag || showDiagnostics || !healthStatus.whisperAvailable || !healthStatus.modelAvailable || !healthStatus.ffmpegAvailable)
    && !setupDismissed;

  const diagHealth: HealthStatus | null = healthStatus && forceDiag && mockParam
    ? {
        ...healthStatus,
        whisperAvailable: !mockParam.includes('whisper'),
        modelAvailable: !mockParam.includes('model'),
        ffmpegAvailable: !mockParam.includes('ffmpeg'),
        gpuBackend: mockParam.includes('cpu') ? 'cpu' : healthStatus.gpuBackend,
      }
    : healthStatus;

  const shouldEnableAgentation = import.meta.env.DEV;
  const agentationEndpoint = import.meta.env.VITE_AGENTATION_ENDPOINT || 'http://127.0.0.1:4747';

  const showFileUpload = !selectedSession && !needsSetup && !showArchive;

  const openNewSession = () => {
    handleNewSession();
    setShowArchive(false);
    if (showDiagnostics) { setSetupDismissed(true); setShowDiagnostics(false); }
    setOpenOverlay(null);
  };
  const openDiagnostics = () => {
    setSetupDismissed(false); setShowDiagnostics(true); setShowArchive(false);
    setOpenOverlay(null);
  };
  const openArchive = () => {
    setShowArchive(true); setShowDiagnostics(false); setSetupDismissed(true);
    setOpenOverlay(null);
  };
  const openKeys = () => {
    setShowGroqKeyModal(true);
    setOpenOverlay(null);
  };
  const openSettings = () => {
    setShowSettings(true);
    setOpenOverlay(null);
  };

  return (
    <>
      <div className={`app-layout${openOverlay ? ' app-layout--overlay-open' : ''}`}>
        <main className="main-content">
          {loadError && <div className="global-error">{loadError}</div>}

          {needsSetup && !showArchive && (
            <>
              {isRecording && (
                <button
                  type="button"
                  className="recording-active-banner"
                  onClick={() => { setSetupDismissed(true); setShowDiagnostics(false); setShowArchive(false); setSelectedSessionId(null); }}
                >
                  <span className="recording-dot" aria-hidden="true" />
                  Recording in progress — click to return
                </button>
              )}
              <SetupGuide
                health={diagHealth!}
                onRefresh={refreshHealth}
                onDismiss={() => { setSetupDismissed(true); setShowDiagnostics(false); }}
              />
            </>
          )}

          {showArchive && (
            <ArchivePage
              onBack={() => setShowArchive(false)}
              onChanged={handleArchiveChanged}
              isRecording={isRecording}
              onReturnToRecording={() => { setShowArchive(false); setSelectedSessionId(null); }}
            />
          )}

          {!needsSetup && !showArchive && selectedSession && (
            <TranscriptView session={selectedSession} transcript={transcript} onRetranscribe={handleRetranscribe} onCancel={handleCancel} ffmpegAvailable={ffmpegAvailable} praxisProjects={preferences.praxisProjects ?? []} praxisDefaultPromptCustom={Boolean(preferences.praxisDefaultPrompt?.trim())} onRename={(title) => handleRename(selectedSession.id, title)} onRedownload={handleRedownload} />
          )}

          {(showFileUpload || isRecording) && (
            <div className="file-upload-host" style={showFileUpload ? undefined : { display: 'none' }}>
              <FileUpload
                onUploaded={handleUploaded}
                onRecordingChange={setIsRecording}
                groqAvailable={healthStatus?.groqAvailable ?? false}
                onGroqKeySaved={refreshHealth}
                preferences={preferences}
                onPreferenceChange={handlePreferenceChange}
                audioDevicesFromApp={audioDevices}
                captureCapabilities={captureCapabilities}
                onOpenSettings={() => setShowSettings(true)}
                desktopToggleRequest={desktopToggleRequest}
                onDesktopToggleHandled={() => setDesktopToggleRequest(null)}
              />
            </div>
          )}
        </main>

        {((selectedSession && !needsSetup) || showArchive) && <ThemeToggle />}

        <OverlayLayer
          open={openOverlay}
          onOpen={setOpenOverlay}
          onToggle={toggleOverlay}
          onClose={closeOverlay}
          sessions={
            <SessionList
              sessions={sessions}
              selectedSessionId={selectedSessionId}
              pendingDeleteId={pendingDelete?.session.id ?? null}
              onSelect={(id) => { handleSelect(id); setOpenOverlay(null); }}
              onDelete={handleDelete}
              onUndoDelete={handleUndoDelete}
              onRename={handleRename}
              onNewSession={openNewSession}
              gpuBackend={healthStatus?.gpuBackend}
              isTranscribing={sessions.some(s => s.status === 'transcribing' || s.status === 'preparing')}
            />
          }
          controls={
            <ControlsPanel
              active={showArchive ? 'archive' : needsSetup ? 'diagnostics' : showFileUpload ? 'upload' : null}
              onUpload={openNewSession}
              onSettings={openSettings}
              onArchive={openArchive}
              onKeys={openKeys}
              onDiagnostics={openDiagnostics}
            />
          }
        />
      </div>
      <ModelDownloadModal />
      {showGroqKeyModal && (
        <GroqKeyModal
          groqAvailable={healthStatus?.groqAvailable ?? false}
          onClose={() => setShowGroqKeyModal(false)}
          onSaved={refreshHealth}
        />
      )}
      {showSettings && (
        <SettingsModal
          preferences={preferences}
          audioDevices={audioDevices}
          captureCapabilities={captureCapabilities}
          onPreferenceChange={handlePreferenceChange}
          onReset={handlePreferencesReset}
          onClose={() => setShowSettings(false)}
          gpuBackend={healthStatus?.gpuBackend}
          gpuEngine={healthStatus?.gpuEngine}
          nvidiaGpu={healthStatus?.nvidiaGpu}
          cudaStatus={healthStatus?.cudaStatus}
          onHealthRefresh={() => checkHealth().then(setHealthStatus).catch(() => {})}
          isTranscribing={sessions.some(s => s.status === 'transcribing' || s.status === 'preparing')}
        />
      )}
      {shouldEnableAgentation && <Agentation endpoint={agentationEndpoint} />}
      <CompactLayer
        preferences={preferences}
        onPreferenceChange={handlePreferenceChange}
        onBeforeCollapse={() => { setOpenOverlay(null); setShowSettings(false); setShowGroqKeyModal(false); }}
        onRevealRecording={() => { setSelectedSessionId(null); setShowDiagnostics(false); setShowArchive(false); setSetupDismissed(true); }}
      />
    </>
  );
};

export default App;
