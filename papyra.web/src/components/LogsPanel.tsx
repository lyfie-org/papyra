import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, ExternalLink, Trash2, X } from 'lucide-react';
import {
  LOG_RETENTION_OPTIONS, useClearLogs, useLogs, useSetLogRetention,
  type LogEntry, type LogLevel,
} from '../hooks/useLogs';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useConfirm } from '../lib/confirmContext';
import { APP_VERSION_LABEL, GITHUB_URL } from '../lib/appInfo';
import LoadingBar from './LoadingBar';
import './ConfirmDialog.css';
import './LogsPanel.css';

// Settings → Logs (admin). What the instance did and what went wrong, kept for
// as long as the admin chooses. The server scrubs every entry of personal data
// (no names, titles, ids, paths, addresses), so one can be copied straight
// into a public issue.

const FILTERS: { level: LogLevel | null; label: string }[] = [
  { level: null, label: 'All' },
  { level: 'error', label: 'Errors' },
  { level: 'warning', label: 'Warnings' },
  { level: 'info', label: 'Info' },
];

const LEVEL_LABEL: Record<LogLevel, string> = { error: 'Error', warning: 'Warning', info: 'Info' };

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** The text the Copy button puts on the clipboard: ready to paste into an issue. */
function logReportText(entry: LogEntry): string {
  const lines = [
    `Papyra ${LEVEL_LABEL[entry.level].toLowerCase()} (${entry.source})`,
    `Time:   ${entry.timeUtc}`,
    `App:    ${APP_VERSION_LABEL}`,
    '',
    entry.message,
  ];
  if (entry.exception) {
    lines.push('', `${entry.exception.type}: ${entry.exception.message}`);
    if (entry.exception.stack) lines.push(entry.exception.stack);
  }
  return lines.join('\n');
}

export default function LogsPanel() {
  const [level, setLevel] = useState<LogLevel | null>(null);
  const [open, setOpen] = useState<LogEntry | null>(null);
  const logs = useLogs(level);
  const retention = useSetLogRetention();
  const clear = useClearLogs();
  const confirm = useConfirm();

  const entries = logs.data?.pages.flatMap(p => p.entries) ?? [];
  const retentionHours = logs.data?.pages[0]?.retentionHours ?? 168;

  async function clearAll() {
    const ok = await confirm({
      title: 'Clear all logs?',
      body: 'Every entry is deleted. New ones keep arriving.',
      confirmLabel: 'Clear logs',
      destructive: true,
    });
    if (ok) clear.mutate();
  }

  return (
    <div className="settings__panel">
      <h2 id="log-retention" className="settings__subhead">Logs</h2>
      <p className="settings__hint">Errors and activity, with personal details removed.</p>
      <label className="settings__field settings__field--inline">Keep logs for
        <select
          className="settings__select"
          disabled={logs.isLoading || retention.isPending}
          value={retentionHours}
          onChange={e => retention.mutate(Number(e.target.value))}
        >
          {LOG_RETENTION_OPTIONS.map(o => <option key={o.hours} value={o.hours}>{o.label}</option>)}
        </select>
      </label>
      {retention.isError && <p className="settings__error">Couldn’t save the setting.</p>}

      <div className="logs__bar">
        <div className="logs__filters" role="group" aria-label="Show">
          {FILTERS.map(f => (
            <button
              key={f.label}
              type="button"
              className={`logs__filter${level === f.level ? ' is-active' : ''}`}
              aria-pressed={level === f.level}
              onClick={() => setLevel(f.level)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {entries.length > 0 && (
          <button type="button" className="logs__clear" onClick={() => void clearAll()} disabled={clear.isPending}>
            <Trash2 size={14} aria-hidden="true" /> Clear
          </button>
        )}
      </div>

      {logs.isLoading && <LoadingBar label="Loading logs" />}
      {logs.isError && <p className="settings__error">Couldn’t load the logs.</p>}
      {!logs.isLoading && !logs.isError && entries.length === 0 && (
        <p className="logs__empty">{level ? 'Nothing at this level.' : 'Nothing logged yet.'}</p>
      )}

      {entries.length > 0 && (
        <ul className="logs" aria-label="Log entries">
          {entries.map(entry => (
            <li key={entry.id}>
              <button type="button" className="logs__item" onClick={() => setOpen(entry)}>
                <span className={`logs__level logs__level--${entry.level}`}>{LEVEL_LABEL[entry.level]}</span>
                <span className="logs__message">{entry.message}</span>
                <span className="logs__meta">
                  <span className="logs__source">{entry.source}</span>
                  <time dateTime={entry.timeUtc}>{when(entry.timeUtc)}</time>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {logs.hasNextPage && (
        <button
          type="button"
          className="settings__btn settings__btn--ghost logs__more"
          disabled={logs.isFetchingNextPage}
          onClick={() => void logs.fetchNextPage()}
        >
          {logs.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}

      {open && <LogEntryDialog entry={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function LogEntryDialog({ entry, onClose }: { entry: LogEntry; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref);
  const [copied, setCopied] = useState(false);

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

  async function copy() {
    const text = logReportText(entry);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard API (plain HTTP): fall back to a selection copy.
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

  return createPortal(
    <div className="confirm" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        className="confirm__box log-entry"
        role="dialog"
        aria-modal="true"
        aria-labelledby="log-entry-title"
      >
        <div className="log-entry__head">
          <span className={`logs__level logs__level--${entry.level}`}>{LEVEL_LABEL[entry.level]}</span>
          <span className="logs__source">{entry.source}</span>
          <time className="log-entry__time" dateTime={entry.timeUtc}>{when(entry.timeUtc)}</time>
          <button type="button" className="log-entry__close" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <h2 id="log-entry-title" className="log-entry__message">{entry.message}</h2>
        {entry.exception && (
          <>
            <p className="log-entry__exception">
              {entry.exception.type}
              {/* A browser error's message is already the heading. */}
              {entry.exception.message && !entry.message.startsWith(entry.exception.message) ? `: ${entry.exception.message}` : ''}
            </p>
            {entry.exception.stack && <pre className="log-entry__stack">{entry.exception.stack}</pre>}
          </>
        )}
        <p className="log-entry__hint">Copy it into an issue to report it.</p>
        <div className="confirm__actions">
          <a
            className="confirm__btn log-entry__link"
            href={`${GITHUB_URL}/issues/new`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={15} aria-hidden="true" /> Open an issue
          </a>
          <button type="button" className="confirm__btn confirm__btn--go" onClick={() => void copy()}>
            {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
