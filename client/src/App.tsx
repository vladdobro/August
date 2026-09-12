import React, { useCallback, useEffect, useRef, useState } from 'react';
import SessionList from './components/SessionList';
import FileUpload from './components/FileUpload';
import TranscriptView from './components/TranscriptView';
import ModelDownloadModal from './components/ModelDownloadModal';
import { checkHealth, deleteSession, fetchSessions, fetchTranscript, renameSession, retranscribeSession, cancelTranscription } from './api';
import type { SessionMetadata } from './types';
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
  const [pendingDelete, setPendingDelete] = useState<{
    session: SessionMetadata;
    timeoutId: ReturnType<typeof setTimeout>;
  } | null>(null);

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

  useEffect(() => {
    checkHealth()
      .then((h) => setFfmpegAvailable(h.ffmpegAvailable))
      .catch(() => setFfmpegAvailable(false));
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

  const shouldEnableAgentation = import.meta.env.DEV;
  const agentationEndpoint = import.meta.env.VITE_AGENTATION_ENDPOINT || 'http://127.0.0.1:4747';

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
          onNewSession={handleNewSession}
        />

        <main className="main-content">
          {loadError && <div className="global-error">{loadError}</div>}

          {selectedSession ? (
            <TranscriptView session={selectedSession} transcript={transcript} onRetranscribe={handleRetranscribe} onCancel={handleCancel} ffmpegAvailable={ffmpegAvailable} />
          ) : (
            <FileUpload onUploaded={handleUploaded} />
          )}
        </main>

        {selectedSession && <ThemeToggle />}
      </div>
      <ModelDownloadModal />
      {shouldEnableAgentation && <Agentation endpoint={agentationEndpoint} />}
    </>
  );
};

export default App;
