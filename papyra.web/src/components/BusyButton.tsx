import { useEffect, useState, type ButtonHTMLAttributes, type CSSProperties, type MouseEvent, type ReactNode, type Ref } from 'react';
import { Loader2 } from 'lucide-react';
import { useBusy } from '../hooks/useBusy';
import './BusyButton.css';

/** A run shorter than this never shows the spinner — a flash reads as a glitch. */
const SHOW_AFTER_MS = 120;
/** Once shown, the spinner stays at least this long. */
const MIN_VISIBLE_MS = 400;

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  /** Busy from outside (a mutation, a form's useBusy). */
  busy?: boolean;
  /** What the button says while busy ("Creating…"); defaults to its usual label. */
  busyLabel?: ReactNode;
  /** Real progress 0..1 for the bar along its bottom edge; omitted → it sweeps. */
  progress?: number | null;
  /** May return a promise: the button is busy until it settles. */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => unknown;
  ref?: Ref<HTMLButtonElement>;
};

/** `busy`, but only once it has lasted SHOW_AFTER_MS, and for at least MIN_VISIBLE_MS. */
function useShownBusy(busy: boolean): boolean {
  const [shown, setShown] = useState(false);
  const [since, setSince] = useState(0);
  useEffect(() => {
    if (busy && !shown) {
      const id = setTimeout(() => { setShown(true); setSince(Date.now()); }, SHOW_AFTER_MS);
      return () => clearTimeout(id);
    }
    if (!busy && shown) {
      const id = setTimeout(() => setShown(false), Math.max(0, MIN_VISIBLE_MS - (Date.now() - since)));
      return () => clearTimeout(id);
    }
  }, [busy, shown, since]);
  return shown;
}

/**
 * A button for an action that takes a moment. While it runs the button says so
 * — a spinner in place of its icon, its busy label, and a bar along its bottom
 * edge — and ignores clicks (it stays focusable, so focus isn't dropped).
 * Busy either from `busy`, or by itself while an `onClick` promise is pending.
 */
export default function BusyButton({
  busy: busyProp = false, busyLabel, progress = null, onClick, className, children, ref, disabled, ...rest
}: Props) {
  const [own, run] = useBusy();
  const busy = busyProp || own;
  const shown = useShownBusy(busy);

  return (
    <button
      ref={ref}
      {...rest}
      className={`${className ?? ''} busy-btn${shown ? ' is-busy' : ''}`.trim()}
      // Busy wins over disabled: it stays focusable and readable, and says why.
      disabled={busy ? undefined : disabled}
      aria-busy={busy || undefined}
      aria-disabled={busy || rest['aria-disabled'] || undefined}
      onClick={(event) => {
        if (busy) { event.preventDefault(); return; }
        const result = onClick?.(event);
        if (result instanceof Promise) void run(() => result);
      }}
    >
      {shown && <Loader2 className="busy-btn__spin" size={15} aria-hidden="true" />}
      {shown && busyLabel !== undefined ? busyLabel : children}
      {shown && (
        <span
          className={`busy-btn__bar${progress === null ? '' : ' busy-btn__bar--known'}`}
          style={progress === null ? undefined : { '--busy-frac': progress } as CSSProperties}
          aria-hidden="true"
        />
      )}
    </button>
  );
}
