// AUG-215: plays a saved session's audio from an action item's moment (TranscriptView only).
// Times are "ms from recording start" = position in the single file or in the mic track. A dual-track session plays
// both files at once: the system track's position is the mic position minus systemOffsetMs.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSessionAudioInfo, sessionAudioUrl } from '../api';
import type { SessionAudioInfo, SessionAudioTrack } from '../types';

export interface AudioPlayback {
  itemId: string;
  currentSec: number;
  durationSec: number | null;
  failed: boolean;
}

const DRIFT_SEC = 0.3;
const WAIT_MS = 15000;

/// Resolves when the element can seek. A MediaRecorder WebM carries no duration and cannot seek until the browser
/// has worked the length out — jumping to the far end makes it do that.
function prepare(el: HTMLAudioElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: number | undefined;
    const cleanup = () => {
      window.clearTimeout(timer);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onDuration);
      el.removeEventListener('error', onError);
    };
    const onError = () => { cleanup(); reject(new Error('audio')); };
    const onDuration = () => { if (Number.isFinite(el.duration)) { cleanup(); resolve(); } };
    const onMeta = () => {
      if (Number.isFinite(el.duration)) { cleanup(); resolve(); return; }
      el.addEventListener('durationchange', onDuration);
      timer = window.setTimeout(() => { cleanup(); resolve(); }, WAIT_MS);
      el.currentTime = 1e101;
    };
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('error', onError);
    el.src = src;
    el.load();
  });
}

function seek(el: HTMLAudioElement, sec: number): Promise<void> {
  return new Promise((resolve) => {
    const max = Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.25) : Math.max(0, sec);
    const target = Math.min(Math.max(0, sec), max);
    if (Math.abs(el.currentTime - target) < 0.01) { resolve(); return; }
    const done = () => { window.clearTimeout(timer); el.removeEventListener('seeked', done); resolve(); };
    const timer = window.setTimeout(done, WAIT_MS);
    el.addEventListener('seeked', done);
    el.currentTime = target;
  });
}

function release(el: HTMLAudioElement): void {
  el.pause();
  el.removeAttribute('src');
  el.load(); // drops the connection, so the file is free to be deleted
}

/// `refreshKey` changes whenever the session's audio files change (deleted, auto-deleted, re-downloaded).
export function useSessionAudioPlayer(sessionId: string, enabled: boolean, refreshKey: string) {
  const [info, setInfo] = useState<SessionAudioInfo | null>(null);
  const [playback, setPlayback] = useState<AudioPlayback | null>(null);
  const [reload, setReload] = useState(0);
  const disposeRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    disposeRef.current?.();
    disposeRef.current = null;
    setPlayback(null);
  }, []);

  useEffect(() => {
    setInfo(null);
    if (!enabled) return;
    let alive = true;
    fetchSessionAudioInfo(sessionId)
      .then((i) => { if (alive) setInfo(i); })
      .catch(() => { if (alive) setInfo(null); });
    return () => { alive = false; };
  }, [sessionId, enabled, refreshKey, reload]);

  // Another session, or the audio files changed: whatever plays is stale. Also runs on unmount.
  useEffect(() => stop, [sessionId, enabled, refreshKey, stop]);

  const playFrom = useCallback((itemId: string, atMs: number) => {
    if (!info || info.tracks.length === 0) return;
    disposeRef.current?.();
    const stamp = Date.now();
    const shiftOf = (t: SessionAudioTrack) => (t === 'system' ? info.systemOffsetMs / 1000 : 0);
    const [mainTrack, sideTrack] = info.tracks;
    const mainShift = shiftOf(mainTrack);
    const sideShift = sideTrack ? shiftOf(sideTrack) : 0;
    const main = new Audio();
    main.preload = 'auto';
    let side: HTMLAudioElement | null = sideTrack ? new Audio() : null;
    if (side) side.preload = 'auto';
    let disposed = false;
    let started = false;

    const sideWant = () => main.currentTime + mainShift - sideShift;
    const syncSide = () => {
      if (!side || !started) return;
      const want = sideWant();
      const len = Number.isFinite(side.duration) ? side.duration : Infinity;
      if (main.paused || want < 0 || want >= len) { if (!side.paused) side.pause(); return; }
      if (Math.abs(side.currentTime - want) > DRIFT_SEC) side.currentTime = want;
      if (side.paused) void side.play().catch(() => {});
    };
    const onTime = () => {
      if (disposed) return;
      syncSide();
      const durationSec = Number.isFinite(main.duration) ? main.duration + mainShift : null;
      setPlayback((p) => (p && !p.failed ? { ...p, currentSec: main.currentTime + mainShift, durationSec } : p));
    };
    const fail = () => {
      if (disposed) return;
      main.pause();
      side?.pause();
      setPlayback((p) => (p ? { ...p, failed: true } : p));
      setReload((n) => n + 1); // the files may be gone: ask the server again, the Play buttons follow
    };
    const onEnded = () => { if (!disposed) stop(); };

    disposeRef.current = () => {
      disposed = true;
      main.removeEventListener('timeupdate', onTime);
      main.removeEventListener('ended', onEnded);
      main.removeEventListener('error', fail);
      release(main);
      if (side) release(side);
    };
    setPlayback({ itemId, currentSec: atMs / 1000, durationSec: null, failed: false });

    // A side track that cannot be read is dropped; the main one still plays.
    const sideReady = side && sideTrack
      ? prepare(side, sessionAudioUrl(sessionId, sideTrack, stamp)).catch(() => { if (side) release(side); side = null; })
      : Promise.resolve();
    Promise.all([prepare(main, sessionAudioUrl(sessionId, mainTrack, stamp)), sideReady])
      .then(() => (disposed ? undefined : seek(main, atMs / 1000 - mainShift)))
      .then(() => (disposed || !side || sideWant() < 0 ? undefined : seek(side, sideWant())))
      .then(() => {
        if (disposed) return undefined;
        main.addEventListener('timeupdate', onTime);
        main.addEventListener('ended', onEnded);
        main.addEventListener('error', fail);
        started = true;
        return main.play();
      })
      .then(onTime)
      .catch(fail);
  }, [info, sessionId, stop]);

  return { available: !!info && info.tracks.length > 0, playback, playFrom, stop };
}
