import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import './AuthForm.css';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether an SSO button belongs on this screen (server tells us if OIDC is on).
  const [sso, setSso] = useState<{ enabled: boolean; name: string } | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    fetch('/api/auth/providers')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setSso({ enabled: !!d.sso, name: d.ssoName ?? 'SSO' }); })
      .catch(() => { /* SSO simply stays hidden */ });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        setError('Invalid credentials.');
        return;
      }
      // Seed the auth cache from the login response so RequireAuth sees an authed
      // session immediately instead of bouncing on the stale 'login' snapshot.
      const user = await res.json();
      queryClient.setQueryData(['auth'], { state: 'authed', user });
      navigate('/', { replace: true });
    } catch {
      setError('Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={submit}>
        <h1 className="auth__title">Welcome back</h1>
        <p className="auth__tagline">Sign in to your Papyra vault.</p>

        {error && <p className="auth__error" role="alert">{error}</p>}

        <label className="auth__field">
          Username
          <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label className="auth__field">
          Password
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>

        <button className="auth__submit" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {sso?.enabled && (
          <>
            <div className="auth__divider"><span>or</span></div>
            <button
              type="button"
              className="auth__sso"
              onClick={() => { window.location.href = '/api/auth/login/sso'; }}
            >
              Continue with {sso.name}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
