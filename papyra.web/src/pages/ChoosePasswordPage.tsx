import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import './ChoosePasswordPage.css';

/**
 * The wall a freshly provisioned account meets on its first sign-in.
 *
 * The server refuses everything else while `mustChangePassword` is set, so this
 * is not a nag that can be dismissed — it is the only door. Rendered instead of
 * the workspace rather than as a modal over it, because there is nothing behind
 * it to go back to.
 */
export default function ChoosePasswordPage({ username }: { username: string }) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== repeat) { setError('The two passwords don’t match.'); return; }

    setBusy(true);
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current, next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError((data as { error?: string } | null)?.error ?? 'Couldn’t set that password.');
        return;
      }
      // Re-probe: the flag is gone, so the guard lets the workspace through.
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
    } catch {
      setError('Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="choose-pw">
      <form className="choose-pw__card" onSubmit={submit}>
        <h1 className="choose-pw__title">Choose your password</h1>
        <p className="choose-pw__body">
          You’re signed in as <strong>{username}</strong> with a password somebody
          else picked for you. Set your own before you carry on — until you do,
          whoever set up your account can sign in as you.
        </p>

        {error && <p className="choose-pw__error" role="alert">{error}</p>}

        <label className="choose-pw__field">The password you were given
          <input
            type="password"
            value={current}
            onChange={e => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
            autoFocus
          />
        </label>
        <label className="choose-pw__field">Your new password
          <input
            type="password"
            value={next}
            onChange={e => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <label className="choose-pw__field">Repeat your new password
          <input
            type="password"
            value={repeat}
            onChange={e => setRepeat(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>

        <p className="choose-pw__hint">At least 8 characters. A few words you’ll remember beats a short scramble.</p>

        <button type="submit" className="choose-pw__submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save and continue'}
        </button>
      </form>
    </main>
  );
}
