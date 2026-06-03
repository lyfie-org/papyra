import { useState, type FormEvent } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { resendVerification } from '../api/auth';
import './ForgotPasswordPage.css'; // reuse identical layout styles

export default function ResendVerificationPage() {
  const [searchParams]  = useSearchParams();
  const [username, setUsername] = useState(searchParams.get('username') ?? '');
  const [submitted, setSubmitted] = useState(false);
  const [loading,   setLoading]   = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    try { await resendVerification(username.trim()); } catch { /* always shows success */ }
    setLoading(false);
    setSubmitted(true);
  }

  return (
    <div className="forgot-page">
      <div className="forgot-page__card">
        <header className="forgot-page__header">
          <h1 className="forgot-page__title">Papyra</h1>
          <p className="forgot-page__subtitle">Resend verification email</p>
        </header>

        {submitted ? (
          <div className="forgot-page__done">
            <p>
              If that account exists and is unverified, we've sent a new verification link.
              Check your inbox (and spam folder).
            </p>
            <Link to="/login" className="forgot-page__link">Back to sign in</Link>
          </div>
        ) : (
          <form className="forgot-page__form" onSubmit={handleSubmit} noValidate>
            <p className="forgot-page__intro">
              Enter your username and we'll send a new verification email.
            </p>

            <div className="forgot-page__field">
              <label htmlFor="rv-username" className="forgot-page__label">Username</label>
              <input
                id="rv-username"
                type="text"
                className="forgot-page__input"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoFocus
                required
                placeholder="your username"
                autoComplete="username"
                spellCheck={false}
              />
            </div>

            <button
              type="submit"
              className="forgot-page__submit"
              disabled={loading || !username.trim()}
              aria-busy={loading}
            >
              {loading ? 'Sending…' : 'Resend verification email'}
            </button>

            <Link to="/login" className="forgot-page__back">Back to sign in</Link>
          </form>
        )}
      </div>
    </div>
  );
}
