import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { UserPreferences } from '../../services/preferences';
import {
  compactPrefs,
  formatClock,
  isDockWidget,
  resolveCompactKind,
  resolveCompactWidget,
  shapeForWidget,
  type CompactKind,
  type CompactWidget,
} from '../../services/compact';
import { compactStore } from '../../services/compactStore';
import { DockSquare, DockStrip } from './DockWidgets';
import { GHOST_CHANNEL, type GhostCommand, type GhostMessage, type GhostState } from './ghostProtocol';

interface CompactLayerProps {
  preferences: UserPreferences;
  onPreferenceChange: (patch: Partial<UserPreferences>) => void;
  onBeforeCollapse: () => void;
  onRevealRecording: () => void;
}

type Phase = 'full' | 'compact' | 'done';

const CompactLayer: React.FC<CompactLayerProps> = (props) => {
  const desktop = window.august;
  const supported = Boolean(desktop?.setCompactMode);
  const snap = useSyncExternalStore(compactStore.subscribe, compactStore.getSnapshot);

  const [phase, setPhase] = useState<Phase>('full');
  const [widget, setWidget] = useState<CompactWidget | null>(null);
  const [kind, setKind] = useState<CompactKind>('indicator');
  const [hint, setHint] = useState(false);

  // Latest values for callbacks that outlive a render (keyboard, IPC, channel, timers).
  const propsRef = useRef(props);
  propsRef.current = props;
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const phaseRef = useRef<Phase>('full');
  const widgetRef = useRef<CompactWidget | null>(null);
  const busyRef = useRef(false);
  const manualFullRef = useRef(false);
  const prevRecordingRef = useRef(false);
  const lastElapsedRef = useRef(0);
  const issuesRef = useRef({ interrupted: false, captureLost: false });
  const channelRef = useRef<BroadcastChannel | null>(null);
  const lastGhostKeyRef = useRef('');
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPhaseBoth = (next: Phase) => { phaseRef.current = next; setPhase(next); };
  const setWidgetBoth = (next: CompactWidget | null) => { widgetRef.current = next; setWidget(next); };

  const applyDockClass = (w: CompactWidget | null) => {
    document.documentElement.classList.toggle('compact-dock', isDockWidget(w));
  };

  const requestShape = useCallback(async (w: CompactWidget): Promise<boolean> => {
    const c = compactPrefs(propsRef.current.preferences);
    try {
      const result = await window.august!.setCompactMode!({
        shape: shapeForWidget(w),
        stripWidth: c.stripWidth,
        alwaysOnTop: c.alwaysOnTop,
      });
      if (!result.ok) {
        console.warn('Compact mode unavailable:', result.error);
        return false;
      }
      return true;
    } catch (err) {
      console.warn('Compact mode failed:', err);
      return false;
    }
  }, []);

  const enter = useCallback(async () => {
    if (!window.august?.setCompactMode || busyRef.current) return;
    if (phaseRef.current === 'compact') return;
    const s = snapRef.current;
    if (!s.recording) return;
    const p = propsRef.current.preferences;
    const nextKind = resolveCompactKind(p, s.live);
    if (!nextKind) return;
    const w = resolveCompactWidget(p, nextKind);
    busyRef.current = true;
    try {
      propsRef.current.onBeforeCollapse();
      // Keeps FileUpload the visible view, so it stays mounted after the recording ends.
      propsRef.current.onRevealRecording();
      const ok = await requestShape(w);
      if (!ok) return;
      manualFullRef.current = false;
      setKind(nextKind);
      setWidgetBoth(w);
      setPhaseBoth('compact');
      applyDockClass(w);
      if (isDockWidget(w) && !compactPrefs(p).hintSeen) setHint(true);
    } finally {
      busyRef.current = false;
    }
  }, [requestShape]);

  const expand = useCallback(async () => {
    if (!window.august?.setCompactMode || phaseRef.current === 'full') return;
    try {
      await window.august.setCompactMode({ shape: 'none' });
    } catch (err) {
      console.warn('Compact mode restore failed:', err);
    }
    applyDockClass(null);
    setPhaseBoth('full');
    setWidgetBoth(null);
    setHint(false);
    if (snapRef.current.recording) {
      manualFullRef.current = true;
      propsRef.current.onRevealRecording();
    }
  }, []);

  const toggle = useCallback(() => {
    if (phaseRef.current === 'compact' || phaseRef.current === 'done') void expand();
    else if (snapRef.current.recording) void enter();
  }, [enter, expand]);

  // Controller for the [ COMPACT ] buttons.
  useEffect(() => {
    if (!supported) return;
    compactStore.setController({ enter: () => { void enter(); }, expand: () => { void expand(); } });
    return () => compactStore.setController(null);
  }, [supported, enter, expand]);

  // Recording start / end transitions (keyed on the recording flag only; the 300ms timer lives in a ref).
  useEffect(() => {
    if (!supported) return;
    const was = prevRecordingRef.current;
    prevRecordingRef.current = snap.recording;
    if (!was && snap.recording) {
      manualFullRef.current = false;
      if (compactPrefs(propsRef.current.preferences).enabled) {
        // A DONE widget from the previous recording is replaced by enter().
        if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
        enterTimerRef.current = setTimeout(() => {
          enterTimerRef.current = null;
          if (!manualFullRef.current && snapRef.current.recording) void enter();
        }, 300);
      }
    } else if (was && !snap.recording) {
      if (enterTimerRef.current) {
        clearTimeout(enterTimerRef.current);
        enterTimerRef.current = null;
      }
      if (phaseRef.current === 'compact') {
        if (compactPrefs(propsRef.current.preferences).expandOn === 'stop') void expand();
        else setPhaseBoth('done');
      }
    }
  }, [supported, snap.recording, enter, expand]);

  // Remember the last running time for the DONE face (the live counter resets to 0 when the recording stops).
  useEffect(() => {
    if (snap.recording) lastElapsedRef.current = snap.elapsedSeconds;
  }, [snap.recording, snap.elapsedSeconds]);

  useEffect(() => () => {
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
  }, []);

  // While compact and recording: Stop Live (or Live starting) can change which widget applies.
  useEffect(() => {
    if (!supported || phase !== 'compact' || !snap.recording) return;
    const nextKind = resolveCompactKind(propsRef.current.preferences, snap.live);
    if (!nextKind) return;
    const w = resolveCompactWidget(propsRef.current.preferences, nextKind);
    setKind(nextKind);
    if (w === widgetRef.current) return;
    void (async () => {
      if (!(await requestShape(w))) return;
      setWidgetBoth(w);
      applyDockClass(w);
    })();
  }, [supported, phase, snap.recording, snap.live, requestShape]);

  // Native notification for failures; main shows it only while the main window is hidden. Never auto-expands.
  useEffect(() => {
    if (!supported) return;
    const interrupted = snap.liveStatus === 'interrupted';
    if (phase !== 'full') {
      if (interrupted && !issuesRef.current.interrupted) window.august?.reportCompactIssue?.('interrupted');
      if (snap.captureLost && !issuesRef.current.captureLost) window.august?.reportCompactIssue?.('capture-lost');
    }
    issuesRef.current = { interrupted, captureLost: snap.captureLost };
  }, [supported, phase, snap.liveStatus, snap.captureLost]);

  // Keyboard.
  useEffect(() => {
    if (!supported) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phaseRef.current !== 'full') {
        e.preventDefault();
        void expand();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyC') {
        if (phaseRef.current !== 'full' || snapRef.current.recording) {
          e.preventDefault();
          toggle();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [supported, expand, toggle]);

  // Events from the main process (tray, notification click, resize of the strip, global toggle).
  useEffect(() => {
    if (!supported) return;
    const off = window.august?.onCompactEvent?.((ev) => {
      if (ev.type === 'expand') void expand();
      else if (ev.type === 'toggle') toggle();
      else if (ev.type === 'strip-width') propsRef.current.onPreferenceChange({ compactStripWidth: ev.width });
    });
    return () => { off?.(); };
  }, [supported, expand, toggle]);

  // Ghost bridge: the ghost window renders from this state and sends commands back.
  const buildGhostState = useCallback((): GhostState | null => {
    const w = widgetRef.current;
    if ((w !== 'ghost-caption' && w !== 'ghost-coin') || phaseRef.current === 'full') return null;
    const s = snapRef.current;
    return {
      widget: w,
      phase: phaseRef.current === 'done' ? 'done' : 'compact',
      recording: s.recording,
      live: s.live,
      lines: s.lines.slice(-3),
      lineCount: s.lines.length,
      showCount: kind === 'indicator' && s.live,
      liveStatus: s.liveStatus,
      captureLost: s.captureLost,
      elapsedSeconds: phaseRef.current === 'done' ? lastElapsedRef.current : s.elapsedSeconds,
      skipStopConfirmation: s.skipStopConfirmation,
    };
  }, [kind]);

  useEffect(() => {
    if (!supported || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(GHOST_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<GhostMessage>) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'hello') {
        const state = buildGhostState();
        if (state) channel.postMessage({ type: 'state', state } satisfies GhostMessage);
      } else if (msg.type === 'command') {
        runGhostCommand(msg.command);
      }
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, buildGhostState]);

  const runGhostCommand = (command: GhostCommand) => {
    const actions = compactStore.actions();
    switch (command) {
      case 'expand': void expand(); break;
      case 'pause': actions?.pauseLive(); break;
      case 'resume': actions?.resumeLive(); break;
      case 'end': actions?.end(); break;
      case 'retry': actions?.retryLive(); break;
      case 'show-transcript': actions?.showLivePanel(); void expand(); break;
    }
  };

  useEffect(() => {
    const channel = channelRef.current;
    if (!channel) return;
    const state = buildGhostState();
    if (!state) {
      lastGhostKeyRef.current = '';
      return;
    }
    const key = JSON.stringify(state);
    if (key === lastGhostKeyRef.current) return;
    lastGhostKeyRef.current = key;
    channel.postMessage({ type: 'state', state } satisfies GhostMessage);
  });

  if (!supported || phase === 'full' || !isDockWidget(widget)) return null;

  const dockClass = widget === 'dock-strip' ? 'strip' : 'square';
  const showCount = kind === 'indicator' && snap.live;
  const actions = compactStore.actions();
  const onExpand = () => { void expand(); };

  return createPortal(
    <div className={`compact-dock compact-dock--${dockClass}`} role="region" aria-label="August compact mode">
      {phase === 'done' ? (
        <button type="button" className="compact-done" onClick={onExpand}>
          <span className="compact-done-title">DONE · {formatClock(lastElapsedRef.current)}</span>
          <span className="compact-done-sub">click to open</span>
        </button>
      ) : widget === 'dock-strip' ? (
        <DockStrip snap={snap} actions={actions} onExpand={onExpand} />
      ) : (
        <DockSquare
          snap={snap}
          actions={actions}
          onExpand={onExpand}
          showCount={showCount}
          onShowTranscript={() => { actions?.showLivePanel(); onExpand(); }}
        />
      )}
      {hint && phase === 'compact' && (
        <div className="compact-hint" role="note">
          <span className="compact-hint-tag">[ HINT ]</span>
          <span className="compact-hint-text">Snap your call into the freed space</span>
          <button
            type="button"
            className="compact-btn compact-btn--accent"
            onClick={() => { setHint(false); props.onPreferenceChange({ compactHintSeen: true }); }}
          >
            [ GOT IT ]
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
};

export default CompactLayer;
