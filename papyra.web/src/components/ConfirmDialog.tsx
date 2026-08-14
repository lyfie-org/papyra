import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus';
import './ConfirmDialog.css';

interface Props {
  title: string;
  /** What will happen, and what cannot be undone. */
  body: string;
  /** Names the action, not "OK" — the button should read as the thing it does. */
  confirmLabel: string;
  cancelLabel?: string;
  /** Red treatment for anything unrecoverable. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Papyra's own confirmation, replacing `window.confirm`.
 *
 * The browser dialog cannot be styled, cannot explain itself beyond one string,
 * blocks the whole tab, and renders in a typeface that has nothing to do with the
 * rest of the app. It also gave a delete-to-Trash the same weight as an
 * unrecoverable purge, which trains people to dismiss it without reading.
 *
 * So this is deliberately scarce: reversible actions get a toast instead, and
 * only genuinely destructive ones reach here — where the wording can say exactly
 * what is lost.
 */
export default function ConfirmDialog({
  title, body, confirmLabel, cancelLabel = 'Cancel', destructive, onConfirm, onCancel,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Focus Cancel, not Confirm: a stray Enter should not destroy anything.
  useEffect(() => { confirmRef.current?.focus(); }, []);

  return (
    <div className="confirm" onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div
        ref={ref}
        className="confirm__box"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
      >
        {destructive && <AlertTriangle className="confirm__icon" size={20} aria-hidden="true" />}
        <h2 className="confirm__title" id="confirm-title">{title}</h2>
        <p className="confirm__body" id="confirm-body">{body}</p>
        <div className="confirm__actions">
          <button ref={confirmRef} type="button" className="confirm__btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm__btn confirm__btn--go${destructive ? ' confirm__btn--danger' : ''}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
