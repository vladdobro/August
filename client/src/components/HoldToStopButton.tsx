import React, { useCallback, useEffect, useRef, useState } from 'react';

export const HOLD_TO_STOP_MS = 1500;
const HINT_MS = 1500;

interface UseHoldToStopOptions {
  onComplete: () => void;
  disabled?: boolean;
  durationMs?: number; // default HOLD_TO_STOP_MS
}

type HoldHandlers<T extends HTMLElement> = Pick<
  React.HTMLAttributes<T>,
  'onPointerDown' | 'onPointerUp' | 'onPointerLeave' | 'onPointerCancel' | 'onBlur' | 'onKeyDown' | 'onKeyUp' | 'onClick' | 'onContextMenu'
>;

// AUG-182: shared hold-to-stop mechanic. Progress is written straight to a CSS variable
// (no React state per frame); releasing, leaving, blurring or disabling cancels.
// A hold cancelled before completion shows a short "hold" hint (hintVisible).
export function useHoldToStop<T extends HTMLElement>(opts: UseHoldToStopOptions): {
  ref: React.RefObject<T>;
  hintVisible: boolean;
  handlers: HoldHandlers<T>;
} {
  const { onComplete, disabled, durationMs = HOLD_TO_STOP_MS } = opts;
  const ref = useRef<T>(null);
  const rafRef = useRef<number | null>(null);
  const t0Ref = useRef(0);
  const activeRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const blurHandlerRef = useRef<(() => void) | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hintVisible, setHintVisible] = useState(false);

  const clearHintTimer = () => {
    if (hintTimerRef.current !== null) {
      clearTimeout(hintTimerRef.current);
      hintTimerRef.current = null;
    }
  };

  const setProgress = (p: number) => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--hold-p', String(p));
    el.classList.toggle('hold-btn--past', p > 0.5);
  };

  const reset = useCallback(() => {
    activeRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const el = ref.current;
    if (el) {
      el.style.setProperty('--hold-p', '0');
      el.classList.remove('hold-btn--past');
    }
    if (blurHandlerRef.current) {
      window.removeEventListener('blur', blurHandlerRef.current);
      blurHandlerRef.current = null;
    }
  }, []);

  // User-level cancel (release / leave / blur): shows the hint if a hold was in progress.
  const cancel = useCallback(() => {
    const wasActive = activeRef.current;
    reset();
    if (wasActive) {
      setHintVisible(true);
      if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current);
      hintTimerRef.current = setTimeout(() => {
        hintTimerRef.current = null;
        setHintVisible(false);
      }, HINT_MS);
    }
  }, [reset]);

  const step = useCallback((now: number) => {
    if (!activeRef.current) return;
    const p = Math.min(1, (now - t0Ref.current) / durationMs);
    setProgress(p);
    if (p >= 1) {
      reset();
      onCompleteRef.current();
    } else {
      rafRef.current = requestAnimationFrame(step);
    }
  }, [durationMs, reset]);

  const start = useCallback(() => {
    if (activeRef.current || disabled) return;
    if (hintTimerRef.current !== null) {
      clearTimeout(hintTimerRef.current);
      hintTimerRef.current = null;
    }
    setHintVisible(false);
    activeRef.current = true;
    t0Ref.current = performance.now();
    blurHandlerRef.current = () => cancel();
    window.addEventListener('blur', blurHandlerRef.current);
    rafRef.current = requestAnimationFrame(step);
  }, [disabled, cancel, step]);

  useEffect(() => {
    if (disabled) reset();
  }, [disabled, reset]);

  useEffect(() => () => {
    reset();
    clearHintTimer();
  }, [reset]);

  const isHoldKey = (key: string) => key === ' ' || key === 'Enter';

  const handlers: HoldHandlers<T> = {
    onPointerDown: (e) => { if (e.button === 0) start(); },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onBlur: cancel,
    onKeyDown: (e) => {
      if (isHoldKey(e.key)) {
        e.preventDefault();
        if (!e.repeat) start();
      }
    },
    onKeyUp: (e) => {
      if (isHoldKey(e.key)) {
        e.preventDefault();
        cancel();
      }
    },
    onClick: (e) => e.preventDefault(),
    onContextMenu: (e) => e.preventDefault(),
  };

  return { ref: ref as React.RefObject<T>, hintVisible, handlers };
}

interface HoldToStopButtonProps {
  onComplete: () => void;
  disabled?: boolean;
  className?: string; // visual classes of the host view (live-panel-btn… / compact-btn…)
  title?: string;
  ariaLabel?: string;
  durationMs?: number; // default 1500
  hint?: React.ReactNode; // shown briefly after an early release (default 'Hold')
  children: React.ReactNode;
}

const HoldToStopButton: React.FC<HoldToStopButtonProps> = ({
  onComplete, disabled, className, title, ariaLabel, durationMs, hint = 'Hold', children,
}) => {
  const { ref, hintVisible, handlers } = useHoldToStop<HTMLButtonElement>({ onComplete, disabled, durationMs });
  return (
    <button
      ref={ref}
      type="button"
      className={`hold-btn${hintVisible ? ' hold-btn--hint' : ''} ${className ?? ''}`}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      {...handlers}
    >
      <span className="hold-btn-fill" aria-hidden="true" />
      <span className="hold-btn-label">{children}</span>
      {hintVisible && <span className="hold-btn-hint" aria-hidden="true">{hint}</span>}
    </button>
  );
};

export default HoldToStopButton;
