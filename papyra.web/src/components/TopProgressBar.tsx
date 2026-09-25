import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import { getActivity, subscribeActivity } from '../lib/progress';
import './TopProgressBar.css';

// Shortest a run may look. Work that finishes in microseconds still gets a
// deliberate, confident sweep to 100% — a flicker reads as a glitch, a sweep
// reads as "done".
const MIN_VISIBLE_MS = 500;
const FADE_MS = 240;
// Where the trickle levels off while nothing reports real progress.
const TRICKLE_CEILING = 0.9;

/**
 * The thin accent line along the top of the window. Lit by anything the app is
 * doing that the person could feel: a first load of any query (never background
 * refetches or polls), any mutation, and every task in lib/progress (uploads,
 * imports). Real progress drives it when known; otherwise it trickles.
 *
 * Animated in a rAF loop that writes straight to the element's style — no React
 * render per frame.
 */
export default function TopProgressBar() {
  const loads = useIsFetching({ predicate: (q) => q.state.data === undefined });
  const mutations = useIsMutating();
  const activity = useSyncExternalStore(subscribeActivity, getActivity);
  const busy = loads + mutations + activity.active > 0;

  const barRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(busy);
  const realRef = useRef<number | null>(activity.progress);
  const loop = useRef<{ raf: number; value: number; startedAt: number; finishFrom: number | null } | null>(null);

  useEffect(() => {
    busyRef.current = busy;
    realRef.current = activity.progress;
  }, [busy, activity.progress]);

  useEffect(() => {
    const el = barRef.current;
    if (!el || !busy || loop.current) return;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const state = { raf: 0, value: 0.06, startedAt: performance.now(), finishFrom: null as number | null };
    loop.current = state;
    let last = state.startedAt;
    let finishStart = 0;
    let finishDur = 0;

    const paint = (value: number, opacity: number) => {
      el.style.transform = `scaleX(${value})`;
      el.style.opacity = String(opacity);
    };

    const frame = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;

      if (busyRef.current) {
        state.finishFrom = null;
        const real = realRef.current;
        // Chase real progress quickly; otherwise creep toward the ceiling, slower
        // the closer it gets — the bar never stalls, and never lies about being done.
        const target = real !== null ? Math.max(real, state.value) : TRICKLE_CEILING;
        const rate = real !== null ? 0.012 : 0.0022;
        state.value += (target - state.value) * (1 - Math.exp(-rate * dt));
        paint(state.value, 1);
      } else {
        if (state.finishFrom === null) {
          state.finishFrom = state.value;
          finishStart = now;
          // Stretch the final sweep so the whole run spans at least MIN_VISIBLE_MS.
          finishDur = reduced ? 0 : Math.max(180, MIN_VISIBLE_MS - (now - state.startedAt));
        }
        const t = finishDur === 0 ? 1 : Math.min(1, (now - finishStart) / finishDur);
        const eased = 1 - (1 - t) ** 3;
        state.value = state.finishFrom + (1 - state.finishFrom) * eased;
        const fade = Math.min(1, Math.max(0, (now - finishStart - finishDur) / FADE_MS));
        paint(state.value, 1 - fade);
        if (fade >= 1) {
          paint(0, 0);
          loop.current = null;
          return;
        }
      }
      state.raf = requestAnimationFrame(frame);
    };

    paint(state.value, 1);
    state.raf = requestAnimationFrame(frame);
  }, [busy]);

  useEffect(() => () => {
    if (loop.current) cancelAnimationFrame(loop.current.raf);
    loop.current = null;
  }, []);

  return (
    <div className="top-progress" aria-hidden="true">
      <div ref={barRef} className="top-progress__bar" />
    </div>
  );
}
