import { useState, type FormEvent } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import { resetPasswordToken } from '../api/auth';
import './ResetPasswordTokenPage.css';

export default function ResetPasswordTokenPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') ?? '';

  const [form, setForm] = useState({ newPassword: '', confirmPassword: '' });
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');
  const [succeeded,  setSucceeded]  = useState(false);

  function set(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm(prev => ({ ...prev, [field]: e.target.value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (form.newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (form.newPassword !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await resetPasswordToken(token, form.newPassword, form.confirmPassword);
      setSucceeded(true);
      setTimeout(() => navigate('/login', { replace: true }), 2500);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error
        ?? 'Invalid or expired reset link. Please request a new one.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="reset-token-page">
        <div className="reset-token-page__card">
          <h1 className="reset-token-page__title">Papyra</h1>
          <p className="reset-token-page__error">Missing reset token. Please use the link from your email.</p>
          <Link to="/forgot-password" className="reset-token-page__link">Request a new reset link</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="reset-token-page">
      <div className="reset-token-page__card">
        <header className="reset-token-page__header">
          <h1 className="reset-token-page__title">Papyra</h1>
          <p className="reset-token-page__subtitle">Set a new password</p>
        </header>

        {succeeded ? (
          <div className="reset-token-page__done">
            <p>Password reset successfully. Redirecting you to sign in…</p>
          </div>
        ) : (
          <form className="reset-token-page__form" onSubmit={handleSubmit} noValidate>
            <div className="reset-token-page__field">
              <label htmlFor="rtp-new" className="reset-token-page__label">New password</label>
              <input
                id="rtp-new"
                type="password"
                className="reset-token-page__input"
                value={form.newPassword}
                onChange={set('newPassword')}
                autoFocus
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="Min. 8 characters"
              />
            </div>

            <div className="reset-token-page__field">
              <label htmlFor="rtp-confirm" className="reset-token-page__label">Confirm password</label>
              <input
                id="rtp-confirm"
                type="password"
                className="reset-token-page__input"
                value={form.confirmPassword}
                onChange={set('confirmPassword')}
                required
                autoComplete="new-password"
                placeholder="Repeat password"
              />
            </div>

            {error && <p className="reset-token-page__error" role="alert">{error}</p>}

            <button
              type="submit"
              className="reset-token-page__submit"
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? 'Resetting…' : 'Reset password'}
            </button>

            <Link to="/login" className="reset-token-page__back">Back to sign in</Link>
          </form>
        )}
      </div>
    </div>
  );
}
