import { X, CheckCircle, WarningCircle, Info } from '@phosphor-icons/react';
import { useToast, type ToastVariant } from '../context/ToastContext';
import './Toast.css';

const ICONS: Record<ToastVariant, React.ReactNode> = {
  success: <CheckCircle  weight="fill" size={17} aria-hidden="true" />,
  error:   <WarningCircle weight="fill" size={17} aria-hidden="true" />,
  info:    <Info          weight="fill" size={17} aria-hidden="true" />,
};

export default function ToastContainer() {
  const { toasts, dismissToast } = useToast();

  if (!toasts.length) return null;

  return (
    <div className="toast-container" aria-label="Notifications">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`toast toast--${t.variant}`}
          role={t.variant === 'error' ? 'alert' : 'status'}
          aria-live={t.variant === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          <span className="toast__icon">{ICONS[t.variant]}</span>
          <span className="toast__message">{t.message}</span>
          <button
            className="toast__dismiss"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss notification"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
