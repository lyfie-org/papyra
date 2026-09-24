import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useVault } from '../hooks/useVault';
import { pinProblem, setVaultPin, VaultError } from '../lib/vault';
import './VaultUnlock.css';
import './VaultPinForm.css';

/**
 * Create, change or reset the vault PIN.
 *
 * The server wants proof it is the owner, not just the session: the first PIN is
 * confirmed with the account password; a change takes the current PIN; a
 * forgotten (or disabled) PIN is reset with the password. SSO accounts without a
 * password set their first PIN directly while nothing is locked yet.
 */
export default function VaultPinForm({ onDone }: { onDone?: () => void }) {
  const { status, refresh } = useVault();
  const s = status.data;
  const pinSet = !!s?.pinSet;
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [password, setPassword] = useState('');
  // Changing an existing PIN: by the current PIN, or "forgot it" → password.
  const [usePassword, setUsePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!s) return null;
  const min = s.pinLength.min, max = s.pinLength.max;
  const byPassword = !pinSet ? s.hasPassword : (usePassword || s.pinDisabled);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = pinProblem(pin, min, max);
    if (problem) { setError(problem); return; }
    if (pin !== confirm) { setError('The two PINs do not match.'); return; }
    if (byPassword && !password) { setError('Enter your account password.'); return; }
    if (pinSet && !byPassword && !currentPin) { setError('Enter your current PIN.'); return; }

    setBusy(true);
    try {
      await setVaultPin(pin, byPassword ? { password } : pinSet ? { currentPin } : {});
      setPin(''); setConfirm(''); setCurrentPin(''); setPassword('');
      setDone(true);
      await refresh();
      onDone?.();
    } catch (err) {
      setError(err instanceof VaultError ? err.message : 'Could not reach the server.');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const digits = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    set(e.target.value.replace(/\D/g, ''));
    setError(null);
    setDone(false);
  };

  return (
    <form className="vault-pin-form" onSubmit={submit}>
      {pinSet && !s.pinDisabled && !usePassword && (
        <label className="vault-pin-form__field">
          <span>Current PIN</span>
          <input
            className="vault-unlock__input" type="password" inputMode="numeric" pattern="[0-9]*"
            autoComplete="off" maxLength={max} value={currentPin} onChange={digits(setCurrentPin)} disabled={busy}
          />
        </label>
      )}
      <label className="vault-pin-form__field">
        <span>{pinSet ? 'New PIN' : 'Choose a PIN'} ({min}–{max} digits)</span>
        <input
          className="vault-unlock__input" type="password" inputMode="numeric" pattern="[0-9]*"
          autoComplete="new-password" maxLength={max} value={pin} onChange={digits(setPin)} disabled={busy}
        />
      </label>
      <label className="vault-pin-form__field">
        <span>Confirm PIN</span>
        <input
          className="vault-unlock__input" type="password" inputMode="numeric" pattern="[0-9]*"
          autoComplete="new-password" maxLength={max} value={confirm} onChange={digits(setConfirm)} disabled={busy}
        />
      </label>
      {byPassword && (
        <label className="vault-pin-form__field">
          <span>Account password</span>
          <input
            className="vault-pin-form__password" type="password" autoComplete="current-password"
            value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} disabled={busy}
          />
        </label>
      )}

      <div className="vault-pin-form__actions">
        <button type="submit" className="vault-unlock__btn" disabled={busy}>
          <KeyRound size={15} /> {busy ? 'Saving…' : pinSet ? 'Change PIN' : 'Set PIN'}
        </button>
        {pinSet && !s.pinDisabled && s.hasPassword && (
          <button type="button" className="vault-pin-form__switch" onClick={() => { setUsePassword((v) => !v); setError(null); }}>
            {usePassword ? 'Use my current PIN instead' : 'Forgot your PIN?'}
          </button>
        )}
      </div>

      {error && <p className="vault-unlock__error vault-pin-form__msg" role="alert">{error}</p>}
      {done && <p className="vault-unlock__muted vault-pin-form__msg" role="status">PIN saved. Your vault is open for the next few minutes.</p>}
    </form>
  );
}
