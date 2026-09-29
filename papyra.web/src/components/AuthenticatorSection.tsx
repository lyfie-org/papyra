import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import TotpQr from './TotpQr';
import LoadingBar from './LoadingBar';
import CodeField from './CodeField';
import { requestEmailCode } from '../lib/emailCode';
import { useAuth } from '../hooks/useAuth';

interface TotpStatus { enabled: boolean; enabledUtc: string | null }

async function send(url: string, body: unknown, method = 'POST') {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return { res, data };
}

/**
 * Settings → Security → Two-step sign-in. One authenticator app per account (it
 * can be replaced, never removed — its code is what every sensitive step asks
 * for), and one switch: whether signing in asks for the code too. Always on for
 * administrators.
 */
export default function AuthenticatorSection() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const status = useQuery({
    queryKey: ['totp'],
    queryFn: async () => {
      const res = await fetch('/api/auth/totp');
      if (!res.ok) throw new Error(String(res.status));
      return res.json() as Promise<TotpStatus>;
    },
  });
  const [enrol, setEnrol] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  // Turning two-step sign-in off asks for a code first.
  const [confirmOff, setConfirmOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isAdmin = user?.role === 'Admin';
  const hasPassword = user?.hasPassword !== false;
  const signInOn = !!user?.twoFactorLogin;
  const emailCode = user?.canEmailCode ? () => requestEmailCode('/api/auth/step-up/email') : undefined;

  function reset() {
    setEnrol(null); setConfirmOff(false); setCode(''); setPassword(''); setError(null);
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

  async function begin() {
    reset();
    setDone(null);
    const res = await fetch('/api/auth/totp/begin', { method: 'POST' });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.secret) { setError(data?.error ?? 'Couldn’t start setup.'); return; }
    setEnrol({ secret: data.secret, uri: data.uri });
  }

  async function replace(e: React.FormEvent) {
    e.preventDefault();
    if (!enrol) return;
    setBusy(true);
    setError(null);
    try {
      const { res, data } = await send('/api/auth/totp', { secret: enrol.secret, code, password: hasPassword ? password : undefined });
      if (!res.ok) { setError((data?.error as string) ?? 'That didn’t work.'); return; }
      await refresh('New authenticator saved.');
    } finally {
      setBusy(false);
    }
  }

  async function setSignIn(enabled: boolean, withCode?: string) {
    setBusy(true);
    setError(null);
    try {
      const { res, data } = await send('/api/auth/totp/login', { enabled, code: withCode }, 'PUT');
      if (!res.ok) { setError((data?.error as string) ?? 'Couldn’t change that.'); setCode(''); return; }
      await refresh(enabled ? 'Sign-in asks for a code.' : 'Sign-in no longer asks for a code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 id="authenticator" className="settings__subhead">Two-step sign-in</h2>
      {status.isLoading && <LoadingBar label="Loading" />}

      {status.data?.enabled && !enrol && (
        <p className="settings__msg">
          <CheckCircle2 size={14} /> Authenticator app on{status.data.enabledUtc ? ` since ${new Date(status.data.enabledUtc).toLocaleDateString()}` : ''}.
          <button type="button" className="settings__link" onClick={() => void begin()}>Replace</button>
        </p>
      )}

      {enrol && (
        <form className="settings__form" onSubmit={replace}>
          <TotpQr secret={enrol.secret} uri={enrol.uri} />
          <CodeField value={code} onChange={c => { setCode(c); setError(null); }} label="Code from the new app" />
          {hasPassword && (
            <label className="settings__field">Your password
              <input type="password" value={password} autoComplete="current-password" required
                onChange={e => { setPassword(e.target.value); setError(null); }} />
            </label>
          )}
          <div className="settings__form-actions">
            <button type="submit" className="settings__btn" disabled={busy || code.length !== 6 || (hasPassword && !password)}>
              {busy ? 'Checking…' : 'Save'}
            </button>
            <button type="button" className="settings__btn settings__btn--quiet" onClick={reset}>Cancel</button>
          </div>
        </form>
      )}

      {status.data?.enabled && !enrol && (
        <label className="settings__field settings__field--inline">
          <span>Ask for a code when I sign in{isAdmin && <span className="settings__hint"> · always on for admins</span>}</span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={signInOn}
            disabled={isAdmin || busy || confirmOff}
            onChange={e => { if (e.target.checked) void setSignIn(true); else { setDone(null); setConfirmOff(true); } }}
          />
        </label>
      )}

      {confirmOff && (
        <form className="settings__form" onSubmit={e => { e.preventDefault(); void setSignIn(false, code); }}>
          <CodeField value={code} onChange={c => { setCode(c); setError(null); }} autoFocus onEmail={emailCode} />
          <div className="settings__form-actions">
            <button type="submit" className="settings__btn" disabled={busy || code.length !== 6}>Turn off</button>
            <button type="button" className="settings__btn settings__btn--quiet" onClick={reset}>Cancel</button>
          </div>
        </form>
      )}

      {error && <p className="settings__error" role="alert">{error}</p>}
      {done && <p className="settings__msg"><CheckCircle2 size={14} /> {done}</p>}
    </>
  );
}
