import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { ToastContext, type ToastAction } from '../lib/toastContext';
import './Toast.css';

interface Toast {
  id: number;
  message: string;
  action?: ToastAction;
}

const LIFETIME_MS = 5000;

/**
 * Transient confirmations of things that already happened.
 *
 * Papyra used to ask `confirm()` before routine, reversible actions — deleting a
 * note that goes to Trash and can be restored. That stops the user to answer a
 * question whose answer is almost always yes, in a browser dialog we cannot
 * style. Doing the thing and saying so afterwards is both faster and calmer, and
 * an action slot leaves room for an undo.
 *
 * Reserved for the reversible. Anything genuinely destructive still asks first —
 * see ConfirmDialog.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts(list => list.filter(t => t.id !== id));
  }, []);

  const toast = useCallback((message: string, action?: ToastAction) => {
    const id = nextId.current++;
    setToasts(list => [...list, { id, message, action }]);
    window.setTimeout(() => dismiss(id), LIFETIME_MS);
  }, [dismiss]);

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* aria-live so the message reaches a screen reader without stealing
          focus — the user's cursor stays where they were working. */}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className="toast">
            <span className="toast__message">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast__action"
                onClick={() => { t.action!.onClick(); dismiss(t.id); }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="toast__close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

