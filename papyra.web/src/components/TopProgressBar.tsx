import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useIsFetching } from '@tanstack/react-query';
import { getActivity, subscribeActivity } from '../lib/progress';
import './TopProgressBar.css';

// A first load has to run this long, with nothing else showing it, before the
// line appears. Most loads are done well before; they never see it.
export const SHOW_AFTER_MS = 600;
const FINISH_MS = 180;
const FADE_MS = 240;
// Where the trickle levels off: it never claims to be done.
const TRICKLE_CEILING = 0.9;

/**
 * The thin accent line along the top of the window — a fallback, not a status
 * light. It shows only while a first load (a query with no data yet; never a
 * refetch, a poll or a save) has run for SHOW_AFTER_MS and nothing else on
 * screen says so: no in-page LoadingBar, no busy BusyButton, no ActivityDock
 * card. Changes to notes (pin, tag, reorder, trash, share) never light it; they
 * show on their own button or in place.
 *
 * Animated in a rAF loop that writes straight to the element's style — no React
 * render per frame.
 */
export default function TopProgressBar() {
  const loads = useIsFetching({ predicate: (q) => q.state.data === undefined });
  const activity = useSyncExternalStore(subscribeActivity, getActivity);
  const unshown = loads > 0 && activity.indicators === 0 && activity.labelled.length === 0;

  // Only once it has stayed unshown for a while.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!unshown) return;
    const timer = setTimeout(() => setArmed(true), SHOW_AFTER_MS);
    return () => {
      clearTimeout(timer);
      setArmed(false);
    };
  }, [unshown]);
  const busy = unshown && armed;

  const barRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(busy);
  const loop = useRef<{ raf: number } | null>(null);

  useEffect(() => { busyRef.current = busy; }, [busy]);

  useEffect(() => {
    const el = barRef.current;
    if (!el || !busy || loop.current) return;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const state = { raf: 0 };
    loop.current = state;
    let value = 0.06;
    let last = performance.now();
    let finishFrom: number | null = null;
    let finishStart = 0;
    const finishDur = reduced ? 0 : FINISH_MS;

    const paint = (v: number, opacity: number) => {
      el.style.transform = `scaleX(${v})`;
      el.style.opacity = String(opacity);
    };

    const frame = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;

      if (busyRef.current) {
        finishFrom = null;
        // Creep toward the ceiling, slower the closer it gets.
        value += (TRICKLE_CEILING - value) * (1 - Math.exp(-0.0022 * dt));
        paint(value, 1);
      } else {
        if (finishFrom === null) {
          finishFrom = value;
          finishStart = now;
        }
        const t = finishDur === 0 ? 1 : Math.min(1, (now - finishStart) / finishDur);
        const eased = 1 - (1 - t) ** 3;
        value = finishFrom + (1 - finishFrom) * eased;
        const fade = reduced ? 1 : Math.min(1, Math.max(0, (now - finishStart - finishDur) / FADE_MS));
        paint(value, 1 - fade);
        if (fade >= 1) {
          paint(0, 0);
          loop.current = null;
          return;
        }
      }
      state.raf = requestAnimationFrame(frame);
    };

    paint(value, 1);
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
