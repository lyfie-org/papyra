import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Lock, ShieldCheck, X } from 'lucide-react';
import VaultUnlock from './VaultUnlock';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useVault } from '../hooks/useVault';
import { vaultFetch } from '../lib/vault';
import './ExportDialog.css';

/**
 * Confirm-then-download for "Export all notes". The export is every note you
 * own — your vault included, in its own `vault/` folder — so it asks for what
 * guards the account (password) and what guards the vault (PIN or biometric).
 * The server answers with a one-time ticket; the download is a plain link, so
 * the browser saves the file itself. An email goes to the account afterwards.
 */
export default function ExportDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref);
  const { status, open } = useVault();
  const needsVault = !!status.data?.pinSet;
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await vaultFetch('/api/export/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ticket) { setError(data?.error ?? 'Couldn’t start the export.'); return; }
      setPassword('');
      setStarted(true);
      window.location.href = `/api/export?ticket=${encodeURIComponent(data.ticket)}`;
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
          <h2 id="export-title" className="export-dialog__title">Export all notes</h2>
          <button type="button" className="export-dialog__close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>

        {started ? (
          <div className="export-dialog__done" role="status">
            <p>Your download has started. We’ve emailed your account a note that it happened.</p>
            <button type="button" className="settings__btn" autoFocus onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <p className="export-dialog__lede">
              A zip of every note as plain text, with attachments. Locked notes are included in a
              separate <code>vault</code> folder. Because it holds everything, confirm it’s you.
            </p>

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
                  <label className="export-dialog__field">
                    <span>Your account password</span>
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); setError(null); }}
                      disabled={needsVault && !open}
                    />
                  </label>
                  {error && <p className="settings__error" role="alert">{error}</p>}
                  <button type="submit" className="settings__btn" disabled={busy || !password || (needsVault && !open)}>
                    <Download size={16} /> {busy ? 'Preparing…' : 'Export'}
                  </button>
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
