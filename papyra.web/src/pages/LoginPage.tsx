import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth, useLogin } from '../hooks/useAuth';
import TwoFactorModal from '../components/TwoFactorModal';
import './LoginPage.css';

export default function LoginPage() {
  const navigate = useNavigate();
  const { data: auth } = useAuth();
  const { mutate, isPending, error } = useLogin();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // When the backend returns a 2FA challenge, store the mfaToken here.
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    mutate(
      { username, password },
      {
        onSuccess: (data) => {
          if (data.requiresTwoFactor && data.mfaToken) {
            setMfaToken(data.mfaToken);
          } else {
            navigate('/', { replace: true });
          }
        },
      },
    );
  }

  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  const responseData = (error as { response?: { data?: { error?: string; requiresEmailVerification?: boolean } } } | null)?.response?.data;
  const needsVerification = status === 403 && responseData?.requiresEmailVerification;
  const serverError = error
    ? (status === 429
        ? 'Too many failed attempts. Please wait 15 minutes before trying again.'
        : status === 401
          ? 'Invalid username or password.'
          : needsVerification
            ? null // handled separately below
            : (responseData?.error ?? 'Login failed.'))
    : null;

  return (
    <>
      {mfaToken && (
        <TwoFactorModal
          mfaToken={mfaToken}
          onSuccess={() => navigate('/', { replace: true })}
          onCancel={() => setMfaToken(null)}
        />
      )}

      <div className="login-page">
        <div className="login-page__card">
          <header className="login-page__header">
            <h1 className="login-page__title">Papyra</h1>
            <p className="login-page__subtitle">Sign in to your workspace</p>
          </header>

          <form className="login-page__form" onSubmit={handleSubmit} noValidate>
            <div className="login-page__field">
              <label htmlFor="login-username" className="login-page__label">Username</label>
              <input
                id="login-username"
                type="text"
                className="login-page__input"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
                spellCheck={false}
                placeholder="your username"
              />
            </div>

            <div className="login-page__field">
              <label htmlFor="login-password" className="login-page__label">Password</label>
              <input
                id="login-password"
                type="password"
                className="login-page__input"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                placeholder="••••••••"
              />
            </div>

            {serverError && (
              <p className="login-page__error" role="alert">{serverError}</p>
            )}
            {needsVerification && (
              <p className="login-page__error" role="alert">
                Your email address is not verified yet. Check your inbox for a verification link.{' '}
                <a href={`/resend-verification?username=${encodeURIComponent(username)}`}
                   className="login-page__link">
                  Resend email
                </a>
              </p>
            )}

            <button
              type="submit"
              className="login-page__submit"
              disabled={isPending}
              aria-busy={isPending}
            >
              {isPending ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="login-page__register-link">
            <Link to="/forgot-password" className="login-page__link">Forgot password?</Link>
          </p>

          {auth?.allowSelfRegistration && (
            <p className="login-page__register-link">
              Don't have an account?{' '}
              <Link to="/register" className="login-page__link">Create one</Link>
            </p>
          )}
        </div>
      </div>
    </>
  );
}
