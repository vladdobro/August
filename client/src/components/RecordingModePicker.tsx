import React, { useEffect, useRef, useState } from 'react';
import type { LiveEngine } from '../services/liveTranscriptionClient';
import { saveGroqKey } from '../api';

export type RecordingMode = 'default' | 'live';

interface RecordingModePickerProps {
  onSelect: (mode: RecordingMode, engine?: LiveEngine) => void;
  onClose: () => void;
  groqAvailable?: boolean;
  onGroqKeySaved?: () => void;
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const sweep = endAngle - startAngle;
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

const RING_R = 72;
const GAP = 12;

const GROQ_CONSOLE_URL = 'https://console.groq.com/keys';

const RecordingModePicker: React.FC<RecordingModePickerProps> = ({ onSelect, onClose, groqAvailable, onGroqKeySaved }) => {
  const [step, setStep] = useState<'mode' | 'engine' | 'setup'>('mode');
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (step === 'setup') {
          setStep('engine');
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose, step]);

  useEffect(() => {
    if (step === 'setup') {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [step]);

  const leftArc = describeArc(0, 0, RING_R, 180 + GAP / 2, 360 - GAP / 2);
  const rightArc = describeArc(0, 0, RING_R, GAP / 2, 180 - GAP / 2);

  const leftLabelPos = polarToCartesian(0, 0, RING_R + 34, 270);
  const rightLabelPos = polarToCartesian(0, 0, RING_R + 34, 90);

  const handleGroqClick = () => {
    if (groqAvailable) {
      onSelect('live', 'groq');
    } else {
      setStep('setup');
    }
  };

  const handleSaveKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveGroqKey(trimmed);
      onGroqKeySaved?.();
      onSelect('live', 'groq');
    } catch (err) {
      setSaveError((err as Error).message || 'Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="mode-picker-backdrop" onClick={() => step === 'setup' ? setStep('engine') : onClose()} />

      {step === 'setup' ? (
        <div className="groq-setup-card">
          <div className="groq-setup-header">
            <span className="groq-setup-icon">&#9889;</span>
            <span>Set up Groq API</span>
          </div>
          <ol className="groq-setup-steps">
            <li>
              Open{' '}
              <a href={GROQ_CONSOLE_URL} target="_blank" rel="noopener noreferrer" className="groq-setup-link">
                console.groq.com/keys
              </a>
            </li>
            <li>Create a free account if needed</li>
            <li>Generate an API key and paste it below</li>
          </ol>
          <div className="groq-setup-input-row">
            <input
              ref={inputRef}
              type="password"
              className="groq-setup-input"
              placeholder="gsk_..."
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveKey(); }}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {saveError && <div className="groq-setup-error">{saveError}</div>}
          <div className="groq-setup-note">Free tier: 20 requests / minute</div>
          <div className="groq-setup-actions">
            <button type="button" className="groq-setup-btn" onClick={() => setStep('engine')} disabled={saving}>
              Back
            </button>
            <button
              type="button"
              className="groq-setup-btn groq-setup-btn--primary"
              onClick={() => void handleSaveKey()}
              disabled={saving || !keyInput.trim()}
            >
              {saving ? 'Saving...' : 'Save & Start'}
            </button>
          </div>
        </div>
      ) : (
        <svg
          className="mode-ring-svg"
          viewBox="-130 -130 260 260"
          aria-label={step === 'mode' ? 'Select recording mode' : 'Select transcription engine'}
          role="menu"
        >
          {step === 'mode' ? (
            <>
              <path
                d={leftArc}
                className="mode-ring-arc mode-ring-arc--default"
                onClick={(e) => { e.stopPropagation(); onSelect('default'); }}
                role="menuitem"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect('default'); } }}
              />
              <text
                x={leftLabelPos.x}
                y={leftLabelPos.y}
                className="mode-ring-label"
                textAnchor="middle"
                dominantBaseline="middle"
                pointerEvents="none"
              >
                DEFAULT
              </text>

              <path
                d={rightArc}
                className="mode-ring-arc mode-ring-arc--live"
                onClick={(e) => { e.stopPropagation(); setStep('engine'); }}
                role="menuitem"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStep('engine'); } }}
              />
              <text
                x={rightLabelPos.x}
                y={rightLabelPos.y}
                className="mode-ring-label mode-ring-label--live"
                textAnchor="middle"
                dominantBaseline="middle"
                pointerEvents="none"
              >
                LIVE
              </text>
            </>
          ) : (
            <>
              <path
                d={leftArc}
                className="mode-ring-arc mode-ring-arc--default"
                onClick={(e) => { e.stopPropagation(); onSelect('live', 'local'); }}
                role="menuitem"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect('live', 'local'); } }}
              />
              <text
                x={leftLabelPos.x}
                y={leftLabelPos.y}
                className="mode-ring-label"
                textAnchor="middle"
                dominantBaseline="middle"
                pointerEvents="none"
              >
                LOCAL
              </text>

              <path
                d={rightArc}
                className={`mode-ring-arc mode-ring-arc--groq${!groqAvailable ? ' mode-ring-arc--needs-setup' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleGroqClick(); }}
                role="menuitem"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleGroqClick(); } }}
              />
              <text
                x={rightLabelPos.x}
                y={rightLabelPos.y}
                className={`mode-ring-label mode-ring-label--groq${!groqAvailable ? ' mode-ring-label--dim' : ''}`}
                textAnchor="middle"
                dominantBaseline="middle"
                pointerEvents="none"
              >
                GROQ
              </text>
              {!groqAvailable && (
                <text
                  x={rightLabelPos.x}
                  y={rightLabelPos.y + 13}
                  className="mode-ring-sublabel"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  pointerEvents="none"
                >
                  setup required
                </text>
              )}
            </>
          )}
        </svg>
      )}
    </>
  );
};

export default RecordingModePicker;
