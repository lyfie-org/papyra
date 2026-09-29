import { useState } from 'react';
import { AlertTriangle, Check, ChevronRight, Copy } from 'lucide-react';
import { errorReportText, type ErrorInfo } from '../lib/errorReport';
import './ErrorPanel.css';

export interface ErrorAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

/**
 * The one way Papyra shows a failure it can't recover from: what happened in a
 * sentence, the server's reference to quote, and — folded away — the trace
 * someone can copy and send to whoever runs the server.
 *
 * `page` fills the screen (a crash, a 404); `inline` sits in the desk or a
 * note; `dialog` is the body of the server-error details dialog.
 */
export default function ErrorPanel({ info, actions = [], variant = 'page', code, icon = true }: {
  info: ErrorInfo;
  actions?: ErrorAction[];
  variant?: 'page' | 'inline' | 'dialog';
  /** The eyebrow, e.g. "404". Defaults to the status, when there is one. */
  code?: string;
  icon?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const hasTrace = !!(info.stack || info.componentStack);
  const reportable = hasTrace || !!info.errorId;
  const eyebrow = code ?? (info.status ? `Error ${info.status}` : 'Error');

  async function copy() {
    const text = errorReportText(info);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard API (plain HTTP, permissions): fall back to a selection copy.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } finally { area.remove(); }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className={`error-panel error-panel--${variant}`} role={variant === 'dialog' ? undefined : 'alert'}>
      <div className="error-panel__head">
        {icon && <span className="error-panel__icon" aria-hidden="true"><AlertTriangle size={18} /></span>}
        <p className="error-panel__eyebrow">{eyebrow}</p>
      </div>
      <h1 className="error-panel__title">{info.title}</h1>
      <p className="error-panel__message">{info.message}</p>

      {info.errorId && (
        <p className="error-panel__ref">
          Reference <code>{info.errorId}</code>
        </p>
      )}

      {hasTrace && (
        <details className="error-panel__trace">
          <summary>
            <ChevronRight size={14} className="error-panel__chevron" aria-hidden="true" /> Technical details
          </summary>
          {info.request && (
            <p className="error-panel__request">{info.request}{info.status ? ` → ${info.status}` : ''}</p>
          )}
          {info.stack && <pre>{info.stack}</pre>}
          {info.componentStack && <pre className="error-panel__components">{info.componentStack}</pre>}
        </details>
      )}

      <div className="error-panel__actions">
        {actions.map(a => (
          <button
            key={a.label}
            type="button"
            className={`error-panel__btn${a.primary ? ' error-panel__btn--primary' : ''}`}
            onClick={a.onClick}
          >
            {a.label}
          </button>
        ))}
        {reportable && (
          <button type="button" className="error-panel__btn" onClick={() => void copy()}>
            {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy error details'}
          </button>
        )}
      </div>
      {reportable && (
        <p className="error-panel__hint">If this keeps happening, send the copied details to whoever runs this Papyra.</p>
      )}
    </section>
  );
}
