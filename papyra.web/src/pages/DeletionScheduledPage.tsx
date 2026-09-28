import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { clearSessionData } from '../lib/session';
import './AuthForm.css';

/**
 * What an account waiting out its deletion week sees instead of the desk. The
 * server refuses everything else meanwhile, so this is the only door: keep the
 * account (password), or sign out and let it go.
 */
export default function DeletionScheduledPage({ username, scheduledUtc }: { username: string; scheduledUtc: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const when = new Date(scheduledUtc).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });

  async function keep(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/account/delete/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? 'Couldn’t cancel the deletion.');
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
    await clearSessionData(queryClient);
    queryClient.setQueryData(['auth'], { state: 'login', user: null });
    navigate('/login', { replace: true });
  }

  return (
    <main className="auth">
      <form className="auth__card" onSubmit={keep}>
        <h1 className="auth__title">Your account is being deleted</h1>
        <p className="auth__tagline">
          <strong>@{username}</strong> and everything in it — every note, attachment and version — will be
          permanently erased on <strong>{when}</strong>. You’ll get an email each day until then.
        </p>
        <p className="auth__tagline">Changed your mind? Enter your password to keep it exactly as it is.</p>
        {error && <p className="auth__error" role="alert">{error}</p>}
        <label className="auth__field">
          Password
          <input type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="auth__submit" type="submit" disabled={busy || !password}>
          {busy ? 'Keeping…' : 'Keep my account'}
        </button>
        <button type="button" className="auth__link" onClick={() => void signOut()}>Sign out</button>
      </form>
    </main>
  );
}
