import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import TotpQr from '../components/TotpQr';
import CodeField from '../components/CodeField';
import './ChoosePasswordPage.css';

/**
 * The one-time screen an account without an authenticator meets after signing
 * in (a new account, or one an admin reset). The server refuses the rest of the
 * API until it's done, so — like choosing a password — it's the only door.
 *
 * No password here: the person has just signed in to reach this screen. Adding
 * another authenticator later, from Settings, is where the password is asked.
 * The code submits itself on the sixth digit.
 */
export default function SetUpAuthenticatorPage({ username }: { username: string }) {
  const queryClient = useQueryClient();
  const [enrol, setEnrol] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/auth/totp/begin', { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (cancelled) return;
      if (!res.ok || !data?.secret) setError(data?.error ?? 'Couldn’t start setup. Reload to try again.');
      else setEnrol({ secret: data.secret, uri: data.uri });
    })();
    return () => { cancelled = true; };
  }, []);

  async function verify(digits: string) {
    if (!enrol || submitting.current) return;
    submitting.current = true;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: enrol.secret, code: digits }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? 'That didn’t work.');
        setCode('');
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
    } catch {
      setError('Couldn’t reach the server.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function onCode(next: string) {
    setCode(next);
    if (next.length === 6) void verify(next);
  }

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    await queryClient.invalidateQueries({ queryKey: ['auth'] });
  }

  return (
    <main className="choose-pw">
      <form className="choose-pw__card" onSubmit={e => { e.preventDefault(); void verify(code); }}>
        <h1 className="choose-pw__title">Secure your account</h1>
        <p className="choose-pw__body">
          Add Papyra to an authenticator app, then enter the 6-digit code it shows, <strong>@{username}</strong>.
        </p>

        {error && <p className="choose-pw__error" role="alert">{error}</p>}
        {enrol && <TotpQr secret={enrol.secret} uri={enrol.uri} />}

        <CodeField value={code} onChange={onCode} label="6-digit code" />

        <button type="submit" className="choose-pw__submit" disabled={busy || !enrol || code.length !== 6}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
        <button type="button" className="choose-pw__signout" onClick={() => void signOut()}>Sign out</button>
      </form>
    </main>
  );
}
