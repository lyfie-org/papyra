import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import './AuthForm.css';

interface TokenInfo {
  kind: 'reset' | 'invite';
  username: string;
  email: string;
}

/**
 * Landing page for the one-time links Papyra emails: a password reset and an
 * invitation. Both do the same thing from here — prove the token, then set a
 * password — so they share a page and differ only in wording.
 *
 * Sits outside the auth guard: whoever follows a reset link is by definition
 * unable to sign in.
 */
export default function TokenPage({ mode }: { mode: 'reset' | 'invite' }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [info, setInfo] = useState<TokenInfo | null>(null);
  // Only "checking" when there is something to check. Starting at `true` and
  // clearing it inside the effect would be a synchronous setState on mount for
  // the no-token case, which cascades a render for no reason.
  const [checking, setChecking] = useState(() => token.length > 0);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  // Validate before showing the form, so an expired link says so plainly instead
  // of failing only after someone has typed a new password.
  useEffect(() => {
    if (!token) return;   // `checking` already starts false in this case
    let cancelled = false;
    void fetch(`/api/auth/token/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) setInfo(await res.json());
        else setInfo(null);
      })
      .catch(() => { if (!cancelled) setInfo(null); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError('The two passwords don’t match.'); return; }

    setBusy(true);
    try {
      const endpoint = mode === 'reset' ? '/api/auth/reset-password' : '/api/auth/accept-invite';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? 'That didn’t work. The link may have expired.');
        return;
      }
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 1800);
    } finally {
      setBusy(false);
    }
  }

  const heading = mode === 'reset' ? 'Choose a new password' : 'Welcome to Papyra';

  if (checking) {
    return (
      <div className="auth">
        <div className="auth__card"><p className="auth__tagline">Checking your link…</p></div>
      </div>
    );
  }

  if (!token || !info) {
    return (
      <div className="auth">
        <div className="auth__card">
          <h1 className="auth__title">This link has expired</h1>
          <p className="auth__tagline">
            Reset links last one hour and can be used once; invitations last seven days.
            Ask for a new one.
          </p>
          <button type="button" className="auth__submit" onClick={() => navigate('/login')}>
            Back to sign in
          </button>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="auth">
        <div className="auth__card">
          <h1 className="auth__title"><CheckCircle2 size={20} /> All set</h1>
          <p className="auth__tagline">
            {mode === 'reset' ? 'Your password has been changed.' : 'Your account is ready.'}{' '}
            Taking you to sign in…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={submit}>
        <h1 className="auth__title">{heading}</h1>
        <p className="auth__tagline">
          {mode === 'reset'
            ? <>Setting a new password for <strong>{info.username}</strong>.</>
            : <>Choose a password for <strong>{info.username}</strong> to finish signing up.</>}
        </p>

        <label className="auth__field">New password
          <input
            type="password" value={password} autoComplete="new-password" required
            onChange={e => setPassword(e.target.value)}
          />
        </label>
        <label className="auth__field">Confirm password
          <input
            type="password" value={confirm} autoComplete="new-password" required
            onChange={e => setConfirm(e.target.value)}
          />
        </label>

        {error && <p className="auth__error" role="alert">{error}</p>}

        <button type="submit" className="auth__submit" disabled={busy}>
          {busy ? 'Saving…' : mode === 'reset' ? 'Change password' : 'Create my account'}
        </button>
      </form>
    </div>
  );
}
