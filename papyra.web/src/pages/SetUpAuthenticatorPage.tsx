import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import TotpQr from '../components/TotpQr';
import CodeField from '../components/CodeField';
import './ChoosePasswordPage.css';

/**
 * The one-time screen an account without an authenticator meets after signing
 * in (a new account, or one an admin reset). The server refuses the rest of the
 * API until it's done, so — like choosing a password — it's the only door.
 */
export default function SetUpAuthenticatorPage({ username, hasPassword }: { username: string; hasPassword: boolean }) {
  const queryClient = useQueryClient();
  const [enrol, setEnrol] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!enrol) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/totp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: enrol.secret, code, password: hasPassword ? password : undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? 'That didn’t work.');
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
    } catch {
      setError('Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    await queryClient.invalidateQueries({ queryKey: ['auth'] });
  }

  return (
    <main className="choose-pw">
      <form className="choose-pw__card" onSubmit={submit}>
        <h1 className="choose-pw__title">Add an authenticator</h1>
        <p className="choose-pw__body">
          Scan this with an authenticator app (Google Authenticator, 1Password, Aegis…).
          Its codes confirm it’s you, <strong>@{username}</strong>.
        </p>

        {error && <p className="choose-pw__error" role="alert">{error}</p>}
        {enrol && <TotpQr secret={enrol.secret} uri={enrol.uri} />}

        <CodeField value={code} onChange={setCode} label="Code from the app" />
        {hasPassword && (
          <label className="choose-pw__field">Your password
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
        )}

        <button type="submit" className="choose-pw__submit" disabled={busy || !enrol || code.length !== 6 || (hasPassword && !password)}>
          {busy ? 'Checking…' : 'Turn on'}
        </button>
        <button type="button" className="choose-pw__signout" onClick={() => void signOut()}>Sign out</button>
      </form>
    </main>
  );
}
