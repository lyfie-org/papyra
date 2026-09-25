import type { CSSProperties } from 'react';
import './LoadingBar.css';

/**
 * In-place stand-in for content that's on its way: a slim track that fills.
 * Given `value` (0..1) it shows real progress; without one it eases toward ~90%
 * on its own, so a wait never looks frozen. The label is for screen readers —
 * the bar itself is the message.
 */
export default function LoadingBar({ label, value, className }: {
  label: string;
  value?: number | null;
  className?: string;
}) {
  const known = typeof value === 'number';
  const pct = known ? Math.round(Math.min(1, Math.max(0, value)) * 100) : undefined;
  return (
    <div
      className={`loading-bar${className ? ` ${className}` : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? 100 : undefined}
      aria-valuenow={pct}
      aria-busy="true"
    >
      <div
        className={`loading-bar__fill${known ? ' loading-bar__fill--known' : ''}`}
        style={known ? ({ '--frac': (pct as number) / 100 } as CSSProperties) : undefined}
      />
    </div>
  );
}
