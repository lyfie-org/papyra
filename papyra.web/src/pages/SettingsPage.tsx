import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { useUserSettingsCtx } from '../context/UserSettingsContext';
import { useUserStats } from '../hooks/useUserSettings';
import { useAuth } from '../hooks/useAuth';
import { enable2fa, confirm2fa, disable2fa, regenerateRecoveryCodes } from '../api/auth';
import './SettingsPage.css';

export default function SettingsPage() {
  return (
    <div className="settings-page">
      <header className="settings-page__header">
        <h1 className="settings-page__title">Settings</h1>
        <p className="settings-page__subtitle">Preferences and account configuration.</p>
      </header>

      <div className="settings-page__sections">
        <StatsSection />
        <AppearanceSection />
        <SecuritySection />
      </div>
    </div>
  );
}

// ── Stats dashboard ────────────────────────────────────────────────────────────

function StatsSection() {
  const { data: stats, isLoading } = useUserStats();

  return (
    <section className="settings-section">
      <h2 className="settings-section__title">Your notes</h2>
      <div className="stats-grid">
        <StatCard label="Active"   value={isLoading ? '…' : String(stats?.active   ?? 0)} accent />
        <StatCard label="Archived" value={isLoading ? '…' : String(stats?.archived ?? 0)} />
        <StatCard label="Trash"    value={isLoading ? '…' : String(stats?.trash    ?? 0)} />
        <StatCard label="Words"    value={isLoading ? '…' : (stats?.wordCount ?? 0).toLocaleString()} accent />
      </div>
    </section>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`stat-card${accent ? ' stat-card--accent' : ''}`}>
      <span className="stat-card__value">{value}</span>
      <span className="stat-card__label">{label}</span>
    </div>
  );
}

// ── Appearance ────────────────────────────────────────────────────────────────

function AppearanceSection() {
  const { settings, update } = useUserSettingsCtx();

  if (!settings) return null;

  function handleTheme(theme: string) {
    update({ theme });
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
    // Sync useTheme's localStorage key so theme persists across navigation.
    localStorage.setItem('papyra-theme', theme);
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section__title">Appearance</h2>

      <div className="settings-row">
        <label className="settings-label">Theme</label>
        <div className="settings-theme-pills">
          {(['light', 'dark'] as const).map(t => (
            <button
              key={t}
              className={`settings-theme-pill${settings.theme === t ? ' settings-theme-pill--active' : ''}`}
              onClick={() => handleTheme(t)}
            >
              {t === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label">Default view</label>
        <div className="settings-theme-pills">
          {(['grid', 'list'] as const).map(v => (
            <button
              key={v}
              className={`settings-theme-pill${settings.viewMode === v ? ' settings-theme-pill--active' : ''}`}
              onClick={() => update({ viewMode: v })}
            >
              {v === 'grid' ? 'Grid' : 'List'}
            </button>
          ))}
        </div>
      </div>

    </section>
  );
}

// ── Security / 2FA ────────────────────────────────────────────────────────────

type TwoFaPhase = 'idle' | 'setup' | 'codes' | 'disable' | 'regen';

function SecuritySection() {
  const { data: auth } = useAuth();
  const [phase, setPhase]           = useState<TwoFaPhase>('idle');
  const [secret, setSecret]         = useState('');
  const [otpUri, setOtpUri]         = useState('');
  const [qrDataUrl, setQrDataUrl]   = useState('');
  const [code, setCode]             = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy]             = useState(false);
  const [message, setMessage]       = useState('');
  const [errMsg, setErrMsg]         = useState('');
  const [copied, setCopied]         = useState(false);

  const is2faEnabled = auth?.twoFactorEnabled ?? false;

  // Generate QR code data URL whenever otpUri changes
  useEffect(() => {
    if (!otpUri) return;
    QRCode.toDataURL(otpUri, { width: 200, margin: 2 })
      .then(url => setQrDataUrl(url))
      .catch(() => setQrDataUrl(''));
  }, [otpUri]);

  function reset(targetPhase: TwoFaPhase = 'idle') {
    setCode(''); setErrMsg(''); setPhase(targetPhase);
  }

  async function handleEnable() {
    setBusy(true); setErrMsg('');
    try {
      const { secret: s, otpAuthUri } = await enable2fa();
      setSecret(s); setOtpUri(otpAuthUri);
      setPhase('setup');
    } catch {
      setErrMsg('Failed to initiate 2FA setup.');
    } finally { setBusy(false); }
  }

  async function handleConfirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErrMsg('');
    try {
      const { recoveryCodes: codes } = await confirm2fa(code);
      setRecoveryCodes(codes);
      setCode('');
      setPhase('codes');
      setMessage('');
    } catch {
      setErrMsg('Invalid code. Please try again.');
    } finally { setBusy(false); }
  }

  async function handleDisable(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErrMsg('');
    try {
      await disable2fa(code);
      reset('idle');
      setMessage('Two-factor authentication has been disabled.');
      window.location.reload();
    } catch {
      setErrMsg('Invalid code. Please try again.');
    } finally { setBusy(false); }
  }

  async function handleRegen(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErrMsg('');
    try {
      const { recoveryCodes: codes } = await regenerateRecoveryCodes(code);
      setRecoveryCodes(codes);
      setCode('');
      setPhase('codes');
      setMessage('');
    } catch {
      setErrMsg('Invalid code. Please try again.');
    } finally { setBusy(false); }
  }

  function copyAllCodes() {
    navigator.clipboard.writeText(recoveryCodes.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function downloadCodes() {
    const blob = new Blob([recoveryCodes.join('\n')], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'papyra-recovery-codes.txt' });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section__title">Security</h2>

      {message && <p className="settings-success">{message}</p>}

      {/* ── Idle state ─────────────────────────────────────────────────── */}
      {phase === 'idle' && (
        <div className="settings-2fa-row">
          <div>
            <p className="settings-label">Two-step verification</p>
            <p className="settings-hint">
              {is2faEnabled
                ? 'Your account is protected with a TOTP authenticator.'
                : 'Add an extra layer of security with an authenticator app.'}
            </p>
          </div>
          <div className="settings-2fa-idle-actions">
            {is2faEnabled ? (
              <>
                <button className="settings-btn settings-btn--ghost"
                  onClick={() => reset('regen')}>
                  New recovery codes
                </button>
                <button className="settings-btn settings-btn--danger"
                  onClick={() => reset('disable')}>
                  Disable 2FA
                </button>
              </>
            ) : (
              <button className="settings-btn" disabled={busy} onClick={handleEnable}>
                {busy ? 'Setting up…' : 'Enable 2FA'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Setup: scan QR + enter code ────────────────────────────────── */}
      {phase === 'setup' && (
        <div className="settings-2fa-setup">
          <p className="settings-2fa-instr">
            Scan the QR code with your authenticator app, then enter the 6-digit code to confirm.
          </p>
          {qrDataUrl ? (
            <div className="settings-2fa-qr">
              <img src={qrDataUrl} alt="QR code for 2FA enrollment" width={200} height={200} />
            </div>
          ) : null}
          <div className="settings-2fa-secret-box">
            <span className="settings-2fa-secret-label">Manual secret</span>
            <code className="settings-2fa-secret">{secret}</code>
          </div>
          <form className="settings-2fa-confirm-form" onSubmit={handleConfirm} noValidate>
            <label className="settings-label" htmlFor="2fa-confirm-code">
              Confirm with 6-digit code
            </label>
            <input
              id="2fa-confirm-code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              className="settings-code-input"
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              autoFocus
              aria-label="Six-digit authenticator code"
            />
            {errMsg && <p className="settings-error" role="alert">{errMsg}</p>}
            <div className="settings-2fa-actions">
              <button type="button" className="settings-btn settings-btn--ghost"
                onClick={() => reset('idle')}>
                Cancel
              </button>
              <button type="submit" className="settings-btn"
                disabled={busy || code.length !== 6}>
                {busy ? 'Verifying…' : 'Confirm & enable'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Recovery codes display (one-time) ──────────────────────────── */}
      {phase === 'codes' && (
        <div className="settings-2fa-setup">
          <p className="settings-2fa-instr">
            <strong>Save these recovery codes now.</strong> They will not be shown again. Each code
            can be used once if you lose access to your authenticator app.
          </p>
          <div className="settings-2fa-recovery-grid" aria-label="Recovery codes">
            {recoveryCodes.map(c => (
              <code key={c} className="settings-2fa-recovery-code">{c}</code>
            ))}
          </div>
          <div className="settings-2fa-actions">
            <button type="button" className="settings-btn settings-btn--ghost"
              onClick={downloadCodes}>
              Download .txt
            </button>
            <button type="button" className="settings-btn settings-btn--ghost"
              onClick={copyAllCodes}>
              {copied ? 'Copied!' : 'Copy all'}
            </button>
            <button type="button" className="settings-btn"
              onClick={() => { setMessage('Two-factor authentication is now active.'); reset('idle'); window.location.reload(); }}>
              Done
            </button>
          </div>
        </div>
      )}

      {/* ── Disable 2FA ────────────────────────────────────────────────── */}
      {phase === 'disable' && (
        <form className="settings-2fa-setup" onSubmit={handleDisable} noValidate>
          <p className="settings-2fa-instr">
            Enter your current authenticator code to disable 2FA.
          </p>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            className="settings-code-input"
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            autoFocus
            aria-label="Current authenticator code"
          />
          {errMsg && <p className="settings-error" role="alert">{errMsg}</p>}
          <div className="settings-2fa-actions">
            <button type="button" className="settings-btn settings-btn--ghost"
              onClick={() => reset('idle')}>
              Cancel
            </button>
            <button type="submit" className="settings-btn settings-btn--danger"
              disabled={busy || code.length !== 6}>
              {busy ? 'Disabling…' : 'Disable 2FA'}
            </button>
          </div>
        </form>
      )}

      {/* ── Regenerate recovery codes ───────────────────────────────────── */}
      {phase === 'regen' && (
        <form className="settings-2fa-setup" onSubmit={handleRegen} noValidate>
          <p className="settings-2fa-instr">
            Enter your current authenticator code to generate a new set of recovery codes.
            Your existing codes will be invalidated immediately.
          </p>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            className="settings-code-input"
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            autoFocus
            aria-label="Current authenticator code"
          />
          {errMsg && <p className="settings-error" role="alert">{errMsg}</p>}
          <div className="settings-2fa-actions">
            <button type="button" className="settings-btn settings-btn--ghost"
              onClick={() => reset('idle')}>
              Cancel
            </button>
            <button type="submit" className="settings-btn"
              disabled={busy || code.length !== 6}>
              {busy ? 'Generating…' : 'Generate new codes'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
