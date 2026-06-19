import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import './AuthForm.css';

export default function SetupPage() {
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, name, email, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? 'Setup failed.');
        return;
      }
      // Seed the auth cache from the setup response so RequireAuth lands the new
      // admin straight on the workspace instead of bouncing through /setup again.
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
        <h1 className="auth__title">Welcome to Papyra</h1>
        <p className="auth__tagline">Create the first admin account to begin.</p>

        {error && <p className="auth__error" role="alert">{error}</p>}

        <label className="auth__field">
          Username
          <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label className="auth__field">
          Display name
          <input value={name} onChange={e => setName(e.target.value)} autoComplete="name" />
        </label>
        <label className="auth__field">
          Email
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
        </label>
        <label className="auth__field">
          Password
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required />
        </label>

        <button className="auth__submit" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create admin account'}
        </button>
      </form>
    </div>
  );
}
