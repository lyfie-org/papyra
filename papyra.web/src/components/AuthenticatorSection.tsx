import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, ShieldAlert } from 'lucide-react';
import TotpQr from './TotpQr';
import LoadingBar from './LoadingBar';

interface TotpStatus { enabled: boolean; enabledUtc: string | null }

async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return { res, data };
}

/**
 * Settings → Security: the authenticator app. Its codes are the first way to
 * confirm a sensitive change (moving the email, deleting the account); an
 * emailed code is the fallback. Setting up, replacing or removing it asks for
 * the account password.
 */
export default function AuthenticatorSection() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['totp'],
    queryFn: async () => {
      const res = await fetch('/api/auth/totp');
      if (!res.ok) throw new Error(String(res.status));
      return res.json() as Promise<TotpStatus>;
    },
  });
  const [enrol, setEnrol] = useState<{ secret: string; uri: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setEnrol(null); setRemoving(false); setCode(''); setPassword(''); setError(null);
  }

  async function begin() {
    reset();
    setDone(null);
    const { res, data } = await post('/api/auth/totp/begin');
    if (!res.ok || !data?.secret) { setError((data?.error as string) ?? 'Couldn’t start setup.'); return; }
    setEnrol({ secret: data.secret as string, uri: data.uri as string });
  }

  async function refresh(message: string) {
    reset();
    setDone(message);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['totp'] }),
      queryClient.invalidateQueries({ queryKey: ['auth'] }),
      queryClient.invalidateQueries({ queryKey: ['account-delete'] }),
    ]);
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!enrol) return;
    setBusy(true);
    setError(null);
    try {
      const { res, data } = await post('/api/auth/totp', { secret: enrol.secret, code: code.trim(), password });
      if (!res.ok) { setError((data?.error as string) ?? 'Couldn’t turn it on.'); return; }
      await refresh('Authenticator on.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { res, data } = await post('/api/auth/totp/remove', { password });
      if (!res.ok) { setError((data?.error as string) ?? 'Couldn’t remove it.'); return; }
      await refresh('Authenticator removed.');
    } finally {
      setBusy(false);
    }
  }

  const enabled = !!status.data?.enabled;

  return (
    <>
      <h2 id="authenticator" className="settings__subhead">Authenticator app</h2>
      <p className="settings__hint">Codes to confirm sensitive changes. Email codes are the fallback.</p>
      {status.isLoading && <LoadingBar label="Loading" />}

      {status.data && !enrol && !removing && (
        enabled ? (
          <p className="settings__msg">
            <CheckCircle2 size={14} /> On{status.data.enabledUtc ? ` since ${new Date(status.data.enabledUtc).toLocaleDateString()}` : ''}.
            <button type="button" className="settings__link" onClick={() => void begin()}>Replace</button>
            <button type="button" className="settings__link settings__link--danger" onClick={() => { reset(); setDone(null); setRemoving(true); }}>Remove</button>
          </p>
        ) : (
          <>
            <p className="settings__hint settings__hint--warn">
              <ShieldAlert size={15} /> Not set up.
            </p>
            <div className="settings__form-actions">
              <button type="button" className="settings__btn" onClick={() => void begin()}>
                <KeyRound size={16} /> Set up authenticator
              </button>
            </div>
          </>
        )
      )}

      {enrol && (
        <form className="settings__form" onSubmit={confirm}>
          <TotpQr secret={enrol.secret} uri={enrol.uri} />
          <label className="settings__field">Code from the app
            <input
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              onChange={e => { setCode(e.target.value.replace(/\D/g, '')); setError(null); }}
            />
          </label>
          <label className="settings__field">Account password
            <input type="password" value={password} autoComplete="current-password" required
              onChange={e => { setPassword(e.target.value); setError(null); }} />
          </label>
          <div className="settings__form-actions">
            <button type="submit" className="settings__btn" disabled={busy || code.length !== 6 || !password}>
              {busy ? 'Checking…' : enabled ? 'Replace' : 'Turn on'}
            </button>
            <button type="button" className="settings__btn settings__btn--quiet" onClick={reset}>Cancel</button>
          </div>
        </form>
      )}

      {removing && (
        <form className="settings__form" onSubmit={remove}>
          <label className="settings__field">Account password
            <input type="password" value={password} autoComplete="current-password" required autoFocus
              onChange={e => { setPassword(e.target.value); setError(null); }} />
          </label>
          <div className="settings__form-actions">
            <button type="submit" className="danger-zone__btn" disabled={busy || !password}>
              {busy ? 'Removing…' : 'Remove authenticator'}
            </button>
            <button type="button" className="settings__btn settings__btn--quiet" onClick={reset}>Cancel</button>
          </div>
        </form>
      )}

      {error && <p className="settings__error" role="alert">{error}</p>}
      {done && <p className="settings__msg"><CheckCircle2 size={14} /> {done}</p>}
    </>
  );
}
