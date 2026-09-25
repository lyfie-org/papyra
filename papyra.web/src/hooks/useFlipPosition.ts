import { useLayoutEffect, useRef, type RefObject } from 'react';
import { GAP } from '../lib/noteGridLayout';

const DURATION = 320;
// How long after a width change a height re-flow still counts as that resize.
const RESIZE_SETTLE_MS = 200;
// --ease: quick start, soft landing. Kept as numbers too, so an in-flight card's
// position can be computed rather than read back from the DOM (a style read per
// card per frame is exactly the kind of cost that makes resizing stutter).
const BEZIER = [0.22, 1, 0.36, 1] as const;
const EASING = `cubic-bezier(${BEZIER.join(', ')})`;

/** Progress (0..1 of time) → eased progress, for cubic-bezier(x1, y1, x2, y2). */
export function ease(p: number, [x1, y1, x2, y2]: readonly [number, number, number, number] = BEZIER): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const bx = (t: number) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t ** 2 * (1 - t) + t ** 3;
  const by = (t: number) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t ** 2 * (1 - t) + t ** 3;
  const dx = (t: number) => 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t ** 2;
  // Newton on x(t) = p, with a bisection fallback where the slope flattens.
  let t = p;
  for (let i = 0; i < 6; i++) {
    const err = bx(t) - p;
    if (Math.abs(err) < 1e-4) return by(t);
    const d = dx(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = p;
  for (let i = 0; i < 20; i++) {
    if (bx(t) < p) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  return by(t);
}

const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

interface Flight {
  a: Animation;
  fromX: number; fromY: number;
  toX: number; toY: number;
  startedAt: number;
  duration: number;
}

/**
 * Moves an absolutely-placed grid cell to (x, y) the way a physical card would:
 * by animating from where it *visibly* is, never from where it last rested.
 *
 * The element's inline transform is always the destination (set by the caller's
 * render); this layers a Web Animation from the old spot on top. It replaces a
 * CSS `transition: transform`, which is what made window resizing jitter: a live
 * resize changes the column width every frame, so the transition restarted every
 * frame, cards trailed their slots, and — since width isn't transitioned —
 * snapped wider while still sliding, overlapping their neighbours.
 *
 * Rules:
 * - Same column count, only the column width drifted (a resize between
 *   breakpoints): snap — the grid tracks the window edge exactly, as text does.
 *   A card already mid-flight keeps flying, retargeted to its new slot for the
 *   time it had left, so the glide never stalls or restarts.
 * - Column count changed, cards reordered, a neighbour grew or went away:
 *   glide from the current visible position.
 * - `frozen` (the card is riding the pointer mid-drag): no animation at all.
 */
export function useFlipPosition(
  ref: RefObject<HTMLElement | null>,
  x: number,
  y: number,
  { cols, colW, frozen = false, resizedAt }: {
    cols: number; colW: number; frozen?: boolean;
    /** When the grid's width last changed (performance.now()); shared by all cells. */
    resizedAt?: RefObject<number>;
  },
) {
  const last = useRef<{ x: number; y: number; cols: number; colW: number } | null>(null);
  const flight = useRef<Flight | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const prev = last.current;
    last.current = { x, y, cols, colW };
    if (!el || !prev || (prev.x === x && prev.y === y)) return;

    const now = performance.now();
    const f = flight.current && flight.current.a.playState === 'running' ? flight.current : null;
    if (frozen || reducedMotion() || typeof el.animate !== 'function') {
      f?.a.cancel();
      flight.current = null;
      return;
    }

    // A width change re-wraps text, so heights (and y) settle a render later —
    // that follow-up is part of the same drift, not a layout change to animate.
    // A card the re-pack moves to another column still glides, though: a
    // teleport across the grid is exactly the jolt this is here to remove.
    const column = (px: number, w: number) => Math.round(px / (w + GAP));
    const drifting = prev.cols === cols
      && column(prev.x, prev.colW) === column(x, colW)
      && (prev.colW !== colW || (resizedAt !== undefined && now - resizedAt.current < RESIZE_SETTLE_MS));
    if (drifting && !f) return; // snap: follow the window edge exactly

    // Start from what's on screen: mid-flight, that's the animated position.
    let fromX = prev.x;
    let fromY = prev.y;
    let duration = DURATION;
    const startedAt = now;
    if (f) {
      const k = ease(Math.min(1, (now - f.startedAt) / f.duration));
      fromX = f.fromX + (f.toX - f.fromX) * k;
      fromY = f.fromY + (f.toY - f.fromY) * k;
      f.a.cancel();
      if (drifting) {
        // Keep the original landing time — a live resize must never extend a
        // glide, or cards would trail the window for as long as it moves.
        const remaining = f.duration - (now - f.startedAt);
        if (remaining < 24) { flight.current = null; return; }
        duration = remaining;
      }
    }

    const a = el.animate(
      [
        { transform: `translate3d(${fromX}px, ${fromY}px, 0)` },
        { transform: `translate3d(${x}px, ${y}px, 0)` },
      ],
      { duration, easing: EASING },
    );
    const next: Flight = { a, fromX, fromY, toX: x, toY: y, startedAt, duration };
    flight.current = next;
    a.onfinish = () => { if (flight.current === next) flight.current = null; };
  }, [ref, x, y, cols, colW, frozen, resizedAt]);

  // A card that unmounts mid-flight takes its animation with it.
  useLayoutEffect(() => () => { flight.current?.a.cancel(); }, []);
}
