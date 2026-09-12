import React, { useEffect, useState } from 'react';
import { fetchSetupStatus, SETUP_PROGRESS_URL } from '../api';
import type { ModelSetupStatus } from '../types';

function fmtGB(bytes: number): string {
  return (bytes / 1e9).toFixed(2);
}

const ModelDownloadModal: React.FC = () => {
  const [status, setStatus] = useState<ModelSetupStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;

    fetchSetupStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        if (s.state === 'downloading') {
          es = new EventSource(SETUP_PROGRESS_URL);
          es.onmessage = (event) => {
            try {
              const parsed = JSON.parse(event.data) as ModelSetupStatus;
              setStatus(parsed);
              if (parsed.state !== 'downloading') {
                es?.close();
              }
            } catch {
              // ignore malformed event
            }
          };
        }
      })
      .catch(() => {
        // render nothing on failure
      });

    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);

  // 'missing' without an error is the server's pre-check state (before ensureWhisperModel reports).
  if (!status || status.state === 'present' || (status.state === 'missing' && !status.error) || dismissed) return null;

  return (
    <div className="model-download-backdrop" role="presentation">
      <div className="model-download-modal" role="dialog" aria-modal="true" aria-labelledby="model-download-title">
        {status.state === 'downloading' ? (
          <>
            <h2 className="model-download-title" id="model-download-title">Downloading whisper model</h2>
            <p className="model-download-subtitle">One-time setup — transcription unlocks when it finishes.</p>
            <div
              className="model-download-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={status.percent}
            >
              <div className="model-download-fill" style={{ width: `${status.percent}%` }} />
            </div>
            <div className="model-download-meta">
              <span>{status.percent.toFixed(1)}%</span>
              <span>
                {status.verifying
                  ? 'Verifying checksum…'
                  : `${fmtGB(status.bytesDownloaded)} / ${fmtGB(status.totalBytes)} GB`}
              </span>
            </div>
          </>
        ) : (
          <>
            <h2 className="model-download-title" id="model-download-title">Whisper model unavailable</h2>
            <p className="model-download-error">{status.error}</p>
            <button type="button" className="model-download-dismiss" onClick={() => setDismissed(true)}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default ModelDownloadModal;
