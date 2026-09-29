import { useState } from 'react';
import './CodeField.css';

/**
 * "Confirm it's you": the one six-digit code Papyra ever asks for — from the
 * authenticator app, or (where this Papyra can send mail) an emailed one.
 * Every sensitive step uses this same field, so there is one thing to learn.
 *
 * `onEmail` sends the code and resolves to where it went (or throws).
 */
export default function CodeField({
  value, onChange, onEmail, label = 'Code from your authenticator app', autoFocus, invalid, id,
}: {
  value: string;
  onChange: (code: string) => void;
  onEmail?: () => Promise<string>;
  label?: string;
  autoFocus?: boolean;
  invalid?: boolean;
  id?: string;
}) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  async function email() {
    if (!onEmail) return;
    setSending(true);
    setEmailError(null);
    try {
      setSentTo(await onEmail());
    } catch (e) {
      setEmailError(e instanceof Error ? e.message : 'Couldn’t send a code.');
    } finally {
      setSending(false);
    }
  }

  return (
    <label className="code-field">
      <span className="code-field__label">{sentTo ? `Code sent to ${sentTo}` : label}</span>
      <input
        id={id}
        className="code-field__input"
        value={value}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        autoFocus={autoFocus}
        aria-invalid={invalid}
        placeholder="000000"
        onChange={e => onChange(e.target.value.replace(/\D/g, ''))}
      />
      {onEmail && (
        <button type="button" className="code-field__alt" disabled={sending} onClick={() => void email()}>
          {sending ? 'Sending…' : sentTo ? 'Send another' : 'No phone? Email me a code'}
        </button>
      )}
      {emailError && <span className="code-field__error" role="alert">{emailError}</span>}
    </label>
  );
}
