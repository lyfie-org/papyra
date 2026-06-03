import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useVerifyTwoFactor } from '../hooks/useAuth';
import './TwoFactorModal.css';

interface Props {
  mfaToken: string;
  onSuccess: () => void;
  onCancel:  () => void;
}

export default function TwoFactorModal({ mfaToken, onSuccess, onCancel }: Props) {
  const [code, setCode]           = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const inputRef                  = useRef<HTMLInputElement>(null);
  const { mutate, isPending, error, reset } = useVerifyTwoFactor();

  useEffect(() => {
    inputRef.current?.focus();
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  // When toggling mode, clear the code and any error state
  function toggleMode() {
    setCode('');
    reset();
    setUseRecovery(v => !v);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (useRecovery) {
      // Recovery codes: XXXX-XXXX-XXXX format, 14 chars including dashes
      if (trimmed.length < 12) return;
    } else {
      if (trimmed.length !== 6) return;
    }
    mutate({ mfaToken, code: trimmed }, { onSuccess });
  }

  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  const serverError = error
    ? (status === 429
        ? 'Too many failed attempts. Please wait 15 minutes before trying again.'
        : status === 401
          ? (useRecovery ? 'Invalid recovery code.' : 'Invalid code. Please try again.')
          : ((error as { response?: { data?: { error?: string } } })
              .response?.data?.error ?? 'Verification failed.'))
    : null;

  return (
    <div className="tfa-overlay" role="dialog" aria-modal="true" aria-label="Two-factor authentication">
      <div className="tfa-card">
        <header className="tfa-header">
          <h2 className="tfa-title">Two-step verification</h2>
          <p className="tfa-subtitle">
            {useRecovery
              ? 'Enter one of your 8-character recovery codes.'
              : 'Enter the 6-digit code from your authenticator app.'}
          </p>
        </header>

        <form className="tfa-form" onSubmit={handleSubmit} noValidate>
          {useRecovery ? (
            <input
              ref={inputRef}
              className="tfa-code-input tfa-code-input--recovery"
              type="text"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-label="Recovery code"
            />
          ) : (
            <input
              ref={inputRef}
              className="tfa-code-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              autoComplete="one-time-code"
              aria-label="One-time code"
            />
          )}

          {serverError && (
            <p className="tfa-error" role="alert">{serverError}</p>
          )}

          <div className="tfa-actions">
            <button type="button" className="tfa-cancel" onClick={onCancel}>
              Back
            </button>
            <button
              type="submit"
              className="tfa-submit"
              disabled={isPending || (useRecovery ? code.trim().length < 12 : code.length !== 6)}
              aria-busy={isPending}
            >
              {isPending ? 'Verifying…' : 'Verify'}
            </button>
          </div>

          <button type="button" className="tfa-toggle-mode" onClick={toggleMode}>
            {useRecovery
              ? 'Use authenticator app instead'
              : 'Use a recovery code instead'}
          </button>
        </form>
      </div>
    </div>
  );
}
