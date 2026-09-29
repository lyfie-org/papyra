import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '../lib/toastContext';
import { onServerError, type ErrorInfo } from '../lib/errorReport';
import { useDialogFocus } from '../hooks/useDialogFocus';
import ErrorPanel from './ErrorPanel';
import './ErrorPanel.css';

/**
 * Any request the server failed with a 500, from anywhere in the app: a toast
 * that says so, with "Details" opening the reference and trace to copy. The
 * call site still shows its own message ("Couldn't save"); this adds what the
 * admin needs to find the cause. Repeats of one burst collapse into one toast.
 */
export default function ServerErrorNotices() {
  const { toast } = useToast();
  const [open, setOpen] = useState<ErrorInfo | null>(null);
  const lastAt = useRef(0);

  useEffect(() => onServerError((info) => {
    const now = Date.now();
    if (now - lastAt.current < 4000) return;
    lastAt.current = now;
    toast(`The server hit an error (ref ${info.errorId}).`, { label: 'Details', onClick: () => setOpen(info) });
  }), [toast]);

  return open ? <ServerErrorDialog info={open} onClose={() => setOpen(null)} /> : null;
}

function ServerErrorDialog({ info, onClose }: { info: ErrorInfo; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="error-dialog" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="error-dialog__box" role="dialog" aria-modal="true" aria-label="Server error details">
        <ErrorPanel info={info} variant="dialog" actions={[{ label: 'Close', onClick: onClose, primary: true }]} />
      </div>
    </div>,
    document.body,
  );
}
