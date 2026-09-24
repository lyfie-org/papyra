import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Fingerprint, KeyRound } from 'lucide-react';
import { useVault } from '../hooks/useVault';
import { isWebAuthnAvailable } from '../lib/webauthn';
import { parseUtc, unlockWithBiometric, unlockWithPin, VaultError } from '../lib/vault';
import './VaultUnlock.css';

function useCountdown(until: Date | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until.getTime()) clearInterval(t);
    }, 500);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until.getTime() - now) / 1000)) : 0;
}

function formatWait(seconds: number): string {
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)} h`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} min`;
  return `${seconds} s`;
}

/**
 * Opens the vault: the PIN always, and the device's biometric check as a
 * shortcut when this address and browser can use one. Reports the lockout as it
 * stands — tries left, the wait, or that the PIN is disabled — rather than a bare
 * "wrong". Calls `onUnlocked` with the unlock token.
 */
export default function VaultUnlock({
  onUnlocked,
  autoBiometric = false,
}: {
  onUnlocked: (token: string) => void;
  /** Offer the biometric prompt straight away (where it can work). */
  autoBiometric?: boolean;
}) {
  const { status, refresh } = useVault();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState<'pin' | 'bio' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The lockout from the last refused guess; the server's status covers a wait
  // that started elsewhere (another tab, a reload mid-wait).
  const [refusedUntil, setRefusedUntil] = useState<Date | null>(null);
  const [disabled, setDisabled] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoTried = useRef(false);
  // A biometric prompt can sit waiting (no sensor, the wrong device, a phone
  // left in a pocket). The PIN stays usable meanwhile, and using it stops the prompt.
  const bioAbort = useRef<AbortController | null>(null);
  useEffect(() => () => bioAbort.current?.abort(), []);

  const s = status.data;
  const serverUntilRaw = s?.lockedUntilUtc ?? null;
  const lockedUntil = useMemo(() => {
    const server = serverUntilRaw ? parseUtc(serverUntilRaw) : null;
    if (!server) return refusedUntil;
    if (!refusedUntil) return server;
    return server > refusedUntil ? server : refusedUntil;
  }, [serverUntilRaw, refusedUntil]);
  const wait = useCountdown(lockedUntil);
  const pinDisabled = disabled || !!s?.pinDisabled;
  const biometricHere = !!s?.biometric.available && (s?.biometric.usableHere ?? 0) > 0 && isWebAuthnAvailable();

  async function viaPin(e: React.FormEvent) {
    e.preventDefault();
    if (!pin || busy === 'pin' || wait > 0 || pinDisabled) return;
    bioAbort.current?.abort();
    setBusy('pin');
    setError(null);
    try {
      const token = await unlockWithPin(pin);
      setPin('');
      void refresh();
      onUnlocked(token);
    } catch (err) {
      setPin('');
      if (err instanceof VaultError) {
        if (err.code === 'pin_disabled') setDisabled(true);
        if (err.lockedUntil) setRefusedUntil(err.lockedUntil);
        setError(err.code === 'pin_wrong' && err.attemptsLeft !== null
          ? `Wrong PIN. ${err.attemptsLeft} ${err.attemptsLeft === 1 ? 'try' : 'tries'} left before it is disabled.`
          : err.message);
      } else setError('Could not reach the server.');
      void refresh();
      inputRef.current?.focus();
    } finally {
      setBusy(null);
    }
  }

  async function viaBiometric() {
    if (busy) return;
    setBusy('bio');
    setError(null);
    const controller = new AbortController();
    bioAbort.current = controller;
    try {
      onUnlocked(await unlockWithBiometric(controller.signal));
    } catch (err) {
      // Stopped because the PIN was used instead: not an error worth showing.
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? `${err.message} You can use your PIN instead.` : 'Biometric check failed.');
      inputRef.current?.focus();
    } finally {
      if (bioAbort.current === controller) bioAbort.current = null;
      setBusy((b) => (b === 'bio' ? null : b));
    }
  }

  // Offer the fingerprint prompt once, on open, where it can work.
  useEffect(() => {
    if (autoBiometric && biometricHere && !autoTried.current) {
      autoTried.current = true;
      void viaBiometric();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBiometric, biometricHere]);

  if (status.isLoading) return <p className="vault-unlock__muted">Checking the vault…</p>;

  if (pinDisabled) {
    return (
      <div className="vault-unlock">
        <p className="vault-unlock__error" role="alert">
          Your PIN is disabled after too many wrong tries.
        </p>
        {biometricHere && (
          <button type="button" className="vault-unlock__bio" onClick={() => void viaBiometric()} disabled={!!busy}>
            <Fingerprint size={16} /> {busy === 'bio' ? 'Waiting for your device…' : 'Unlock with biometrics'}
          </button>
        )}
        <Link className="vault-unlock__link" to="/settings?tab=security&s=vault-pin">Reset your PIN in Settings</Link>
        {error && <p className="vault-unlock__error" role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div className="vault-unlock">
      <form className="vault-unlock__form" onSubmit={viaPin}>
        <label className="vault-unlock__label" htmlFor="vault-pin-input">
          <KeyRound size={14} /> Vault PIN
        </label>
        <div className="vault-unlock__row">
          <input
            id="vault-pin-input"
            ref={inputRef}
            className="vault-unlock__input"
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            maxLength={s?.pinLength.max ?? 12}
            value={pin}
            disabled={busy === 'pin' || wait > 0}
            // Digits only, so a stray letter never reaches the server as a "guess".
            onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setError(null); }}
            aria-describedby="vault-unlock-status"
            autoFocus
          />
          <button type="submit" className="vault-unlock__btn" disabled={!pin || busy === 'pin' || wait > 0}>
            {busy === 'pin' ? 'Checking…' : 'Unlock'}
          </button>
        </div>
      </form>

      {biometricHere && (
        <button type="button" className="vault-unlock__bio" onClick={() => void viaBiometric()} disabled={!!busy}>
          <Fingerprint size={16} /> {busy === 'bio' ? 'Waiting for your device…' : 'Use biometrics instead'}
        </button>
      )}

      <p id="vault-unlock-status" className="vault-unlock__muted" aria-live="polite">
        {wait > 0 ? `Too many wrong tries. Try again in ${formatWait(wait)}.` : ''}
      </p>
      {error && wait === 0 && <p className="vault-unlock__error" role="alert">{error}</p>}
    </div>
  );
}
