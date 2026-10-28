import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Lock, ShieldCheck, X } from 'lucide-react';
import VaultUnlock from './VaultUnlock';
import CodeField from './CodeField';
import { requestEmailCode } from '../lib/emailCode';
import { useAuth } from '../hooks/useAuth';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useVault } from '../hooks/useVault';
import { vaultFetch } from '../lib/vault';
import { useQuery } from '@tanstack/react-query';
import { mediumDate } from '../lib/journalDay';
import './ExportDialog.css';

import BusyButton from './BusyButton';
/** What is being exported: everything, or the journal on its own as Markdown files or a PDF book. */
export type ExportScope = { kind: 'all' } | { kind: 'journal'; format: 'md' | 'pdf' };

interface JournalSummary { days: number; words: number; first: string | null; last: string | null }

/**
 * Confirm-then-download for "Export all notes" and the journal's own export. The export is every note you
 * own — your vault included, in its own `vault/` folder — so it asks for what
 * guards the account (a code) and what guards the vault (PIN or biometric).
 * The server answers with a one-time ticket; the download is a plain link, so
 * the browser saves the file itself. An email goes to the account afterwards.
 */
export default function ExportDialog({ onClose, scope = { kind: 'all' } }: { onClose: () => void; scope?: ExportScope }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref);
  const { status, open } = useVault();
  const needsVault = !!status.data?.pinSet;
  const { user } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const journal = scope.kind === 'journal' ? scope : null;
  // What a journal export would hold, so nobody confirms a download of nothing.
  const summary = useQuery<JournalSummary>({
    queryKey: ['journal', 'export-summary'],
    enabled: !!journal,
    staleTime: 0,
    queryFn: async () => {
      const res = await fetch('/api/export/journal/summary');
      if (!res.ok) throw new Error('summary');
      return res.json();
    },
  });
  const nothing = !!journal && summary.isSuccess && summary.data.days === 0;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await vaultFetch('/api/export/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ticket) { setError(data?.error ?? 'Couldn’t start the export.'); setCode(''); return; }
      setCode('');
      setStarted(true);
      const ticket = encodeURIComponent(data.ticket);
      window.location.href = journal ? `/api/export/journal?format=${journal.format}&ticket=${ticket}` : `/api/export?ticket=${ticket}`;
    } catch {
      setError('Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="export-dialog" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div ref={ref} className="export-dialog__card" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <header className="export-dialog__head">
          <h2 id="export-title" className="export-dialog__title">
            {!journal ? 'Export all notes' : journal.format === 'pdf' ? 'Export journal as a PDF book' : 'Export journal as Markdown'}
          </h2>
          <button type="button" className="export-dialog__close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>

        {started ? (
          <div className="export-dialog__done" role="status">
            <p>Your download has started. We’ve emailed your account a note that it happened.</p>
            <button type="button" className="settings__btn" autoFocus onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            {!journal ? (
              <p className="export-dialog__lede">
                A zip of every note as plain text, with attachments. Locked notes are included in a
                separate <code>vault</code> folder. Because it holds everything, confirm it’s you.
              </p>
            ) : (
              <>
                <p className="export-dialog__lede">
                  {journal.format === 'pdf'
                    ? 'Every day with writing, laid out as a small book: a cover, contents, and each month in turn, pictures included.'
                    : <>Every day as a Markdown file, in folders by year and month (<code>journal/2026/10/2026-10-27.md</code>), with the pictures they use under <code>media</code>.</>}
                  {' '}Locked days are included, readable. Days in the Trash are not. Because it holds your private writing, confirm it’s you.
                </p>
                {summary.isSuccess && summary.data.days > 0 && (
                  <p className="export-dialog__summary" role="status">
                    {summary.data.days.toLocaleString()} {summary.data.days === 1 ? 'day' : 'days'} · {summary.data.words.toLocaleString()} words
                    {summary.data.first && summary.data.last && ` · ${mediumDate(summary.data.first)} – ${mediumDate(summary.data.last)}`}
                  </p>
                )}
                {nothing && <p className="settings__error" role="status">There are no journal days to export yet.</p>}
              </>
            )}

            <ol className="export-dialog__steps">
              <li className={`export-dialog__step${!needsVault || open ? ' is-done' : ''}`}>
                <span className="export-dialog__step-head">
                  {!needsVault || open ? <ShieldCheck size={16} aria-hidden="true" /> : <Lock size={16} aria-hidden="true" />}
                  {needsVault ? (open ? 'Vault unlocked' : 'Unlock your vault') : 'No vault to unlock'}
                </span>
                {needsVault && !open && <VaultUnlock autoBiometric onUnlocked={() => undefined} />}
              </li>
              <li className="export-dialog__step">
                <form onSubmit={start} className="export-dialog__form">
                  <CodeField
                    value={code}
                    onChange={(c) => { setCode(c); setError(null); }}
                    onEmail={user?.canEmailCode ? () => requestEmailCode('/api/auth/step-up/email') : undefined}
                  />
                  {error && <p className="settings__error" role="alert">{error}</p>}
                  <BusyButton type="submit" className="settings__btn" disabled={code.length !== 6 || (needsVault && !open) || nothing} busy={busy} busyLabel="Preparing…">
                    <Download size={16} /> Export
                  </BusyButton>
                </form>
              </li>
            </ol>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
