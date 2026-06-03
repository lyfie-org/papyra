import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useResetPassword } from '../hooks/useAuth';
import './ResetPasswordPage.css';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const { mutate, isPending, error } = useResetPassword();

  const [newPassword,     setNewPassword]     = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [validationError, setValidationError] = useState('');
  const [success,         setSuccess]         = useState(false);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError('');

    if (newPassword.length < 8) {
      setValidationError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setValidationError('Passwords do not match.');
      return;
    }

    mutate(
      { newPassword, confirmPassword },
      {
        onSuccess: () => {
          setSuccess(true);
          // Small delay so the user sees the success message, then navigate home.
          setTimeout(() => navigate('/', { replace: true }), 1200);
        },
      },
    );
  }

  const serverError = error
    ? ((error as { response?: { data?: { error?: string } } }).response?.data?.error
       ?? 'Password reset failed.')
    : null;
  const displayError = validationError || serverError;

  return (
    <div className="reset-page">
      <div className="reset-page__card">
        <header className="reset-page__header">
          {/* Papyra wordmark */}
          <p className="reset-page__app-name">Papyra</p>
          <h1 className="reset-page__title">Set a new password</h1>
          <p className="reset-page__notice">
            Your administrator has required a password reset before you can
            access your notes. Choose a secure password to continue.
          </p>
        </header>

        {success ? (
          <div className="reset-page__success" role="status">
            <span className="reset-page__success-icon" aria-hidden="true">✓</span>
            Password updated. Redirecting…
          </div>
        ) : (
          <form className="reset-page__form" onSubmit={handleSubmit} noValidate>
            <div className="reset-page__field">
              <label htmlFor="reset-new" className="reset-page__label">New password</label>
              <input
                id="reset-new"
                type="password"
                className="reset-page__input"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                autoComplete="new-password"
                autoFocus
                required
                minLength={8}
                placeholder="Min. 8 characters"
              />
            </div>

            <div className="reset-page__field">
              <label htmlFor="reset-confirm" className="reset-page__label">Confirm password</label>
              <input
                id="reset-confirm"
                type="password"
                className="reset-page__input"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
                placeholder="Repeat password"
              />
            </div>

            {displayError && (
              <p className="reset-page__error" role="alert">{displayError}</p>
            )}

            <button
              type="submit"
              className="reset-page__submit"
              disabled={isPending}
              aria-busy={isPending}
            >
              {isPending ? 'Saving…' : 'Set new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
