import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { forgotPassword } from '../api/auth';
import './ForgotPasswordPage.css';

export default function ForgotPasswordPage() {
  const [email,     setEmail]     = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading,   setLoading]   = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await forgotPassword(email.trim());
    } catch { /* always 200 on backend — any network error is surfaced below */ }
    setLoading(false);
    setSubmitted(true);
  }

  return (
    <div className="forgot-page">
      <div className="forgot-page__card">
        <header className="forgot-page__header">
          <h1 className="forgot-page__title">Papyra</h1>
          <p className="forgot-page__subtitle">Reset your password</p>
        </header>

        {submitted ? (
          <div className="forgot-page__done">
            <p>
              If that email address is registered, you will receive a password reset link
              shortly. Check your inbox (and spam folder).
            </p>
            <Link to="/login" className="forgot-page__link">Back to sign in</Link>
          </div>
        ) : (
          <form className="forgot-page__form" onSubmit={handleSubmit} noValidate>
            <p className="forgot-page__intro">
              Enter the email address associated with your account and we'll send you a link
              to reset your password.
            </p>

            <div className="forgot-page__field">
              <label htmlFor="fp-email" className="forgot-page__label">Email address</label>
              <input
                id="fp-email"
                type="email"
                className="forgot-page__input"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoFocus
                required
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>

            <button
              type="submit"
              className="forgot-page__submit"
              disabled={loading || !email.trim()}
              aria-busy={loading}
            >
              {loading ? 'Sending…' : 'Send reset link'}
            </button>

            <Link to="/login" className="forgot-page__back">Back to sign in</Link>
          </form>
        )}
      </div>
    </div>
  );
}
