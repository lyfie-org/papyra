import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, KeyRound, Mail, ShieldCheck, Trash2, X } from 'lucide-react';
import VaultUnlock from './VaultUnlock';
import { useAuth } from '../hooks/useAuth';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useVaultOpen } from '../hooks/useVault';
import { vaultFetch } from '../lib/vault';
import { NO_AUTOFILL } from '../lib/autofill';
import './DeleteAccountSection.css';

interface Status { scheduledUtc: string | null; blockers: string[]; graceDays: number; totp?: boolean; canEmail?: boolean }

/**
 * Settings → Security → Delete account. Two warnings before anything can be
 * typed, then every check the server makes: password, vault, a code (from the
 * authenticator app, or emailed), the username typed out. It schedules deletion a week out; the server does
 * the rest (daily reminders, then the purge).
 */
export default function DeleteAccountSection() {
  const { data: status, refetch } = useQuery<Status>({
    queryKey: ['account-delete'],
    queryFn: async () => (await fetch('/api/account/delete')).json(),
  });
  const [stage, setStage] = useState<null | 'warn' | 'confirm'>(null);

  const blocked = (status?.blockers.length ?? 0) > 0;

  return (
    <section className="danger-zone" aria-labelledby="delete-account">
      <h2 id="delete-account" className="settings__subhead danger-zone__title">
        <AlertTriangle size={18} aria-hidden="true" /> Delete account
      </h2>
      <p className="settings__hint">Erases your account and every note. Happens {status?.graceDays ?? 7} days after you confirm — you can cancel until then.</p>
      {blocked && (
        <ul className="danger-zone__blockers">
          {status!.blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}
      <button type="button" className="danger-zone__btn" disabled={!status || blocked} onClick={() => setStage('warn')}>
        <Trash2 size={16} /> Delete my account…
      </button>

      {stage === 'warn' && (
        <WarnDialog graceDays={status?.graceDays ?? 7} onCancel={() => setStage(null)} onContinue={() => setStage('confirm')} />
      )}
      {stage === 'confirm' && (
        <ConfirmDialog graceDays={status?.graceDays ?? 7} totp={!!status?.totp} canEmail={!!status?.canEmail}
          onClose={() => { setStage(null); void refetch(); }} />
      )}
    </section>
  );
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref);
  return createPortal(
    <div className="danger-dialog" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div ref={ref} className="danger-dialog__card" role="alertdialog" aria-modal="true" aria-labelledby="danger-title">
        <header className="danger-dialog__head">
          <h2 id="danger-title" className="danger-dialog__title"><AlertTriangle size={20} aria-hidden="true" /> {title}</h2>
          <button type="button" className="danger-dialog__close" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// Warning one: what goes, and that it's for good.
function WarnDialog({ graceDays, onCancel, onContinue }: { graceDays: number; onCancel: () => void; onContinue: () => void }) {
  return (
    <Shell title="Delete your account?" onClose={onCancel}>
      <p className="danger-dialog__lede">This can’t be undone once the {graceDays} days are up. It erases:</p>
      <ul className="danger-dialog__list">
        <li>every note and to-do list, including your locked vault notes</li>
        <li>every attachment, and the full history of every note</li>
        <li>notes you’ve shared — the people you shared them with lose them too</li>
        <li>your profile, passkeys, API keys and settings</li>
      </ul>
      <p className="danger-dialog__lede">
        If you want a copy, use <strong>Export all notes</strong> (Data &amp; Storage) first.
      </p>
      <div className="danger-dialog__actions">
        <button type="button" className="settings__btn" autoFocus onClick={onCancel}>Keep my account</button>
        <button type="button" className="danger-zone__btn" onClick={onContinue}>I understand, continue</button>
      </div>
    </Shell>
  );
}

// Warning two, with every check.
function ConfirmDialog({ graceDays, totp, canEmail, onClose }: {
  graceDays: number; totp: boolean; canEmail: boolean; onClose: () => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const vaultOpen = useVaultOpen();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'code' | 'delete'>(null);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setBusy('code');
    setError(null);
    try {
      const res = await fetch('/api/account/delete/code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error ?? 'Couldn’t send the code.'); return; }
      setSentTo(data.sentTo);
    } finally {
      setBusy(null);
    }
  }

  async function schedule(e: React.FormEvent) {
    e.preventDefault();
    setBusy('delete');
    setError(null);
    try {
      const res = await vaultFetch('/api/account/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, code, confirmUsername: confirm }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error ?? 'Couldn’t schedule the deletion.'); return; }
      // The account now only answers the "keep my account" screen.
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
      onClose();
    } finally {
      setBusy(null);
    }
  }

  const ready = !!password && code.length === 6 && confirm === user?.username && vaultOpen;

  return (
    <Shell title="Confirm it’s you" onClose={onClose}>
      <form className="danger-dialog__form" onSubmit={schedule}>
        <ol className="danger-dialog__steps">
          <li>
            <span className="danger-dialog__step-head">1 · Your password</span>
            <input type="password" autoComplete="current-password" value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }} />
          </li>
          <li>
            {/* The authenticator's code first; an emailed one works too. */}
            <span className="danger-dialog__step-head">
              {totp && !sentTo
                ? <><KeyRound size={15} aria-hidden="true" /> 2 · A code from your authenticator</>
                : <><Mail size={15} aria-hidden="true" /> 2 · A code from your email</>}
            </span>
            <div className="danger-dialog__row">
              <input {...NO_AUTOFILL} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6-digit code" value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              {canEmail && (
                <button type="button" className="settings__btn" disabled={!password || busy === 'code'} onClick={() => void sendCode()}>
                  {busy === 'code' ? 'Sending…' : sentTo ? 'Send again' : totp ? 'Email one instead' : 'Email me a code'}
                </button>
              )}
            </div>
            {sentTo && <span className="danger-dialog__hint">Sent to {sentTo}. It works once, for 10 minutes.</span>}
          </li>
          <li>
            <span className="danger-dialog__step-head">
              {vaultOpen ? <ShieldCheck size={15} aria-hidden="true" /> : null} 3 · {vaultOpen ? 'Vault unlocked' : 'Unlock your vault'}
            </span>
            {!vaultOpen && <VaultUnlock autoBiometric onUnlocked={() => undefined} />}
          </li>
          <li>
            <span className="danger-dialog__step-head">4 · Type <code>{user?.username}</code> to confirm</span>
            <input {...NO_AUTOFILL} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </li>
        </ol>
        {error && <p className="settings__error" role="alert">{error}</p>}
        <div className="danger-dialog__actions">
          <button type="button" className="settings__btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="danger-zone__btn danger-zone__btn--solid" disabled={!ready || busy === 'delete'}>
            {busy === 'delete' ? 'Scheduling…' : `Delete everything in ${graceDays} days`}
          </button>
        </div>
      </form>
    </Shell>
  );
}
