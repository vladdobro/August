import React, { useCallback, useEffect, useRef, useState } from 'react';
import SessionList from './components/SessionList';
import FileUpload from './components/FileUpload';
import TranscriptView from './components/TranscriptView';
import ModelDownloadModal from './components/ModelDownloadModal';
import { checkHealth, deleteSession, fetchSessions, fetchTranscript, renameSession, retranscribeSession, cancelTranscription } from './api';
import type { HealthStatus, SessionMetadata } from './types';
import SetupGuide from './components/SetupGuide';
import GroqKeyModal from './components/GroqKeyModal';
import SettingsModal from './components/SettingsModal';
import { getPreferences, patchPreferences, resetPreferences } from './services/preferences';
import type { UserPreferences } from './services/preferences';
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
  const [pendingDelete, setPendingDelete] = useState<{
    session: SessionMetadata;
    timeoutId: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [showGroqKeyModal, setShowGroqKeyModal] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferences>({});
  const [showSettings, setShowSettings] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);

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
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    getPreferences().then(setPreferences).catch(() => {});
  }, []);

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
    try {
      await renameSession(id, title);
      await refreshSessions();
    } catch (err) {
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
      }
    : healthStatus;

  const shouldEnableAgentation = import.meta.env.DEV;
  const agentationEndpoint = import.meta.env.VITE_AGENTATION_ENDPOINT || 'http://127.0.0.1:4747';

  const showFileUpload = !selectedSession && !needsSetup;

  return (
    <>
      <div className="app-layout">
        <SessionList
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          pendingDeleteId={pendingDelete?.session.id ?? null}
          onSelect={handleSelect}
          onDelete={handleDelete}
          onUndoDelete={handleUndoDelete}
          onRename={handleRename}
          onNewSession={() => {
            handleNewSession();
            if (showDiagnostics) { setSetupDismissed(true); setShowDiagnostics(false); }
          }}
          onDiagnostics={() => { setSetupDismissed(false); setShowDiagnostics(true); }}
          onKeysAndTokens={() => setShowGroqKeyModal(true)}
          onSettings={() => setShowSettings(true)}
        />

        <main className="main-content">
          {loadError && <div className="global-error">{loadError}</div>}

          {needsSetup && (
            <>
              {isRecording && (
                <button
                  type="button"
                  className="recording-active-banner"
                  onClick={() => { setSetupDismissed(true); setShowDiagnostics(false); setSelectedSessionId(null); }}
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

          {!needsSetup && selectedSession && (
            <TranscriptView session={selectedSession} transcript={transcript} onRetranscribe={handleRetranscribe} onCancel={handleCancel} ffmpegAvailable={ffmpegAvailable} />
          )}

          {(showFileUpload || isRecording) && (
            <div style={showFileUpload ? undefined : { display: 'none' }}>
              <FileUpload
                onUploaded={handleUploaded}
                onRecordingChange={setIsRecording}
                groqAvailable={healthStatus?.groqAvailable ?? false}
                onGroqKeySaved={refreshHealth}
                preferences={preferences}
                onPreferenceChange={handlePreferenceChange}
                audioDevicesFromApp={audioDevices}
                onOpenSettings={() => setShowSettings(true)}
              />
            </div>
          )}
        </main>

        {selectedSession && !needsSetup && <ThemeToggle />}
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
          onPreferenceChange={handlePreferenceChange}
          onReset={handlePreferencesReset}
          onClose={() => setShowSettings(false)}
        />
      )}
      {shouldEnableAgentation && <Agentation endpoint={agentationEndpoint} />}
    </>
  );
};

export default App;
