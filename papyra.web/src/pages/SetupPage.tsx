import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSetup } from '../hooks/useAuth';
import './SetupPage.css';

export default function SetupPage() {
  const navigate  = useNavigate();
  const { mutate, isPending, error } = useSetup();

  const [form, setForm] = useState({
    username: '',
    name:     '',
    email:    '',
    password: '',
    confirm:  '',
  });
  const [validationError, setValidationError] = useState('');

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
      { username: form.username, name: form.name, email: form.email, password: form.password },
      { onSuccess: () => navigate('/', { replace: true }) },
    );
  }

  const serverError = error
    ? ((error as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Setup failed.')
    : null;
  const displayError = validationError || serverError;

  return (
    <div className="setup-page">
      <div className="setup-page__card">
        <header className="setup-page__header">
          <h1 className="setup-page__title">Welcome to Papyra</h1>
          <p className="setup-page__subtitle">Create your admin account to get started.</p>
        </header>

        <form className="setup-page__form" onSubmit={handleSubmit} noValidate>
          <div className="setup-page__field">
            <label htmlFor="setup-username" className="setup-page__label">Username</label>
            <input
              id="setup-username"
              type="text"
              className="setup-page__input"
              value={form.username}
              onChange={set('username')}
              autoComplete="username"
              autoFocus
              required
              spellCheck={false}
              placeholder="e.g. rahul"
            />
          </div>

          <div className="setup-page__field">
            <label htmlFor="setup-name" className="setup-page__label">Display name</label>
            <input
              id="setup-name"
              type="text"
              className="setup-page__input"
              value={form.name}
              onChange={set('name')}
              autoComplete="name"
              placeholder="e.g. Rahul Anand"
            />
          </div>

          <div className="setup-page__field">
            <label htmlFor="setup-email" className="setup-page__label">Email</label>
            <input
              id="setup-email"
              type="email"
              className="setup-page__input"
              value={form.email}
              onChange={set('email')}
              autoComplete="email"
              placeholder="you@example.com"
            />
          </div>

          <div className="setup-page__field">
            <label htmlFor="setup-password" className="setup-page__label">Password</label>
            <input
              id="setup-password"
              type="password"
              className="setup-page__input"
              value={form.password}
              onChange={set('password')}
              autoComplete="new-password"
              required
              minLength={8}
              placeholder="Min. 8 characters"
            />
          </div>

          <div className="setup-page__field">
            <label htmlFor="setup-confirm" className="setup-page__label">Confirm password</label>
            <input
              id="setup-confirm"
              type="password"
              className="setup-page__input"
              value={form.confirm}
              onChange={set('confirm')}
              autoComplete="new-password"
              required
              placeholder="Repeat password"
            />
          </div>

          {displayError && (
            <p className="setup-page__error" role="alert">{displayError}</p>
          )}

          <button
            type="submit"
            className="setup-page__submit"
            disabled={isPending}
            aria-busy={isPending}
          >
            {isPending ? 'Creating account…' : 'Create admin account'}
          </button>
        </form>
      </div>
    </div>
  );
}
