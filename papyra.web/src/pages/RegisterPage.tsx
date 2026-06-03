import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useRegister } from '../hooks/useAuth';
import './RegisterPage.css';

export default function RegisterPage() {
  const navigate = useNavigate();
  const { mutate, isPending, error } = useRegister();

  const [form, setForm] = useState({
    username: '',
    name:     '',
    email:    '',
    password: '',
    confirm:  '',
  });
  const [validationError, setValidationError] = useState('');
  const [pendingVerification, setPendingVerification] = useState(false);
  const [registeredUsername, setRegisteredUsername]   = useState('');

  function set(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm(prev => ({ ...prev, [field]: e.target.value }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError('');

    if (form.password !== form.confirm) {
      setValidationError('Passwords do not match.');
      return;
    }
    if (form.password.length < 8) {
      setValidationError('Password must be at least 8 characters.');
      return;
    }

    mutate(
      {
        username: form.username.trim(),
        password: form.password,
        name:     form.name.trim() || undefined,
        email:    form.email.trim() || undefined,
      },
      {
        onSuccess: (data) => {
          // Backend returns { requiresEmailVerification: true } when email gate is on
          if ((data as { requiresEmailVerification?: boolean }).requiresEmailVerification) {
            setRegisteredUsername(form.username.trim());
            setPendingVerification(true);
          } else {
            navigate('/', { replace: true });
          }
        },
      },
    );
  }

  const serverError = error
    ? ((error as { response?: { status?: number; data?: { error?: string } } }).response?.status === 403
        ? 'Self-registration is not enabled on this instance.'
        : ((error as { response?: { data?: { error?: string } } }).response?.data?.error
           ?? 'Registration failed.'))
    : null;
  const displayError = validationError || serverError;

  // ── Pending verification state ────────────────────────────────────────────
  if (pendingVerification) {
    return (
      <div className="register-page">
        <div className="register-page__card">
          <header className="register-page__header">
            <h1 className="register-page__title">Check your inbox</h1>
            <p className="register-page__subtitle">Almost there — one more step.</p>
          </header>

          <div className="register-page__verify-notice">
            <p>
              We sent a verification link to the email address you provided.
              Click the link in that email to activate your account.
            </p>
            <p className="register-page__verify-hint">
              Didn't receive it?{' '}
              <Link
                to={`/resend-verification?username=${encodeURIComponent(registeredUsername)}`}
                className="register-page__link"
              >
                Resend verification email
              </Link>
            </p>
          </div>

          <p className="register-page__footer">
            <Link to="/login" className="register-page__link">Back to sign in</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="register-page">
      <div className="register-page__card">
        <header className="register-page__header">
          <h1 className="register-page__title">Create account</h1>
          <p className="register-page__subtitle">Join your Papyra workspace.</p>
        </header>

        <form className="register-page__form" onSubmit={handleSubmit} noValidate>
          <div className="register-page__field">
            <label htmlFor="reg-username" className="register-page__label">Username</label>
            <input
              id="reg-username"
              type="text"
              className="register-page__input"
              value={form.username}
              onChange={set('username')}
              autoComplete="username"
              autoFocus
              required
              spellCheck={false}
              placeholder="e.g. alice"
            />
          </div>

          <div className="register-page__field">
            <label htmlFor="reg-name" className="register-page__label">Display name</label>
            <input
              id="reg-name"
              type="text"
              className="register-page__input"
              value={form.name}
              onChange={set('name')}
              autoComplete="name"
              placeholder="e.g. Alice Smith"
            />
          </div>

          <div className="register-page__field">
            <label htmlFor="reg-email" className="register-page__label">Email <span className="register-page__optional">(optional)</span></label>
            <input
              id="reg-email"
              type="email"
              className="register-page__input"
              value={form.email}
              onChange={set('email')}
              autoComplete="email"
              placeholder="alice@example.com"
            />
          </div>

          <div className="register-page__field">
            <label htmlFor="reg-password" className="register-page__label">Password</label>
            <input
              id="reg-password"
              type="password"
              className="register-page__input"
              value={form.password}
              onChange={set('password')}
              autoComplete="new-password"
              required
              minLength={8}
              placeholder="Min. 8 characters"
            />
          </div>

          <div className="register-page__field">
            <label htmlFor="reg-confirm" className="register-page__label">Confirm password</label>
            <input
              id="reg-confirm"
              type="password"
              className="register-page__input"
              value={form.confirm}
              onChange={set('confirm')}
              autoComplete="new-password"
              required
              placeholder="Repeat password"
            />
          </div>

          {displayError && (
            <p className="register-page__error" role="alert">{displayError}</p>
          )}

          <button
            type="submit"
            className="register-page__submit"
            disabled={isPending}
            aria-busy={isPending}
          >
            {isPending ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="register-page__footer">
          Already have an account?{' '}
          <Link to="/login" className="register-page__link">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
