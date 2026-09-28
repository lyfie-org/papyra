import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, CloudDownload, ExternalLink, FileArchive, FolderInput,
  GitBranch, Loader2, Monitor, Moon, Sparkles, Sun, TriangleAlert, Upload,
} from 'lucide-react';
import TimeZonePicker from '../components/TimeZonePicker';
import GitRestorePanel from '../components/GitRestorePanel';
import { summaryLine } from '../lib/backupSummary';
import { usernameRule } from '../lib/profileRules';
import { browserTimeZone } from '../lib/timeZone';
import { MASKED_SECRET, NO_AUTOFILL } from '../lib/autofill';
import { normaliseRepoUrl } from '../lib/gitUrl';
import { useTheme, type ThemePreference } from '../hooks/useTheme';
import { importSummary, type ImportStatus } from '../hooks/useImportStatus';
import type { BackupSummary } from '../hooks/useGitSync';
import type { AuthUser } from '../hooks/useAuth';
import logo from '../assets/papyra_logo.png';
import './AuthForm.css';
import './SetupPage.css';

// The first-run wizard for a brand-new Papyra. Before the account exists:
//   welcome (fresh, or restore a backup first) → username → email → code →
//   password → vault PIN → time zone → create.
// Signed in afterwards:
//   GitHub backup to restore? → imports (optional) → theme → the desk.
// Restoring first prefills the account steps with what the backup remembered;
// the person still chooses their username, email, password and PIN again.

type Step =
  | 'welcome' | 'restore' | 'username' | 'email' | 'code' | 'password' | 'pin' | 'timezone'
  | 'backup' | 'import' | 'theme';

const ACCOUNT_STEPS: Step[] = ['username', 'email', 'code', 'password', 'pin', 'timezone'];
const AFTER_STEPS: Step[] = ['backup', 'import', 'theme'];
const RESUME_KEY = 'papyra-setup-resume';

const STEP_LABEL: Partial<Record<Step, string>> = {
  username: 'Username', email: 'Email', code: 'Verify', password: 'Password', pin: 'Vault PIN',
  timezone: 'Time zone', backup: 'Backup', import: 'Import', theme: 'Theme',
};

interface SetupStatus { needsSetup: boolean; emailConfigured: boolean; serverTimeZone?: string }

async function postJson(url: string, body: unknown, method = 'POST') {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return { res, data };
}

function pinRule(pin: string): string | null {
  if (!/^\d+$/.test(pin)) return 'A PIN is digits only.';
  if (pin.length < 6 || pin.length > 12) return 'A PIN is 6 to 12 digits.';
  const same = [...pin].every(c => c === pin[0]);
  let up = true, down = true;
  for (let i = 1; i < pin.length; i++) {
    const step = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
    if (step !== 1 && step !== -9) up = false;
    if (step !== -1 && step !== 9) down = false;
  }
  return same || up || down ? 'Too easy to guess — avoid repeated or sequential digits.' : null;
}

export default function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { preference, setPreference } = useTheme();
  // The pick itself, held here: setPreference animates the switch and its state
  // lands a frame later, and the account must get what was clicked.
  const [chosenTheme, setChosenTheme] = useState<ThemePreference | null>(null);
  const theme = chosenTheme ?? preference;
  const pickTheme = (t: ThemePreference) => { setChosenTheme(t); setPreference(t); };

  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState<Step>('welcome');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Account fields.
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [skipVerify, setSkipVerify] = useState(false);
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [zone, setZone] = useState(() => browserTimeZone());

  // A backup staged before the account exists.
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [restoreSummary, setRestoreSummary] = useState<BackupSummary | null>(null);
  const [restoredCount, setRestoredCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/auth/setup/status');
        const s = await res.json() as SetupStatus;
        if (cancelled) return;
        setStatus(s);
        if (!s.needsSetup) {
          // Reloaded after the account was made: pick up where the wizard was.
          let resume: string | null = null;
          try { resume = sessionStorage.getItem(RESUME_KEY); } catch { /* storage blocked */ }
          if (resume && AFTER_STEPS.includes(resume as Step)) setStep(resume as Step);
          else navigate('/', { replace: true });
        }
      } catch {
        if (!cancelled) setError('Couldn’t reach the server.');
      }
    })();
    return () => { cancelled = true; };
  }, [navigate]);

  function go(next: Step) {
    setError(null);
    setStep(next);
    if (AFTER_STEPS.includes(next)) {
      try { sessionStorage.setItem(RESUME_KEY, next); } catch { /* storage blocked */ }
    }
  }

  function prefillFrom(summary: BackupSummary) {
    const a = summary.account;
    if (!a) return;
    if (a.username && !username) setUsername(a.username);
    if (a.name && !name) setName(a.name);
    if (a.email && !email) setEmail(a.email);
    if (a.timeZone) setZone(a.timeZone);
    if (a.theme === 'light' || a.theme === 'dark' || a.theme === 'system') pickTheme(a.theme);
  }

  // ── Account steps ──────────────────────────────────────────────────────────

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const { res, data } = await postJson('/api/auth/setup/email/code', { email: email.trim() });
      if (!res.ok) {
        if (data?.code === 'email_not_configured') setStatus(s => s && { ...s, emailConfigured: false });
        setError((data?.error as string) ?? 'Couldn’t send the code.');
        return;
      }
      setCodeSentTo(email.trim());
      go('code');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    setBusy(true);
    setError(null);
    try {
      const { res, data } = await postJson('/api/auth/setup/email/verify', { email: email.trim(), code: code.trim() });
      if (!res.ok) { setError((data?.error as string) ?? 'That code didn’t work.'); return; }
      go('password');
    } finally {
      setBusy(false);
    }
  }

  async function createAccount() {
    setBusy(true);
    setError(null);
    try {
      const { res, data } = await postJson('/api/auth/setup', {
        username: username.trim(), name: name.trim() || undefined, email: email.trim() || undefined,
        emailCode: skipVerify ? undefined : code.trim() || undefined,
        password, pin, timeZone: zone, theme, restoreId: restoreId ?? undefined,
      });
      if (!res.ok) {
        const field = data?.field as string | undefined;
        setError((data?.error as string) ?? 'Setup failed.');
        const back: Record<string, Step> = {
          username: 'username', email: 'email', emailCode: 'code', password: 'password', pin: 'pin', timeZone: 'timezone', restore: 'welcome',
        };
        if (field && back[field]) setStep(back[field]);
        return;
      }
      const user = data as unknown as AuthUser & { restored?: number };
      queryClient.setQueryData(['auth'], { state: 'authed', user });
      if (restoreId) setRestoredCount(user.restored ?? 0);
      // Restored already: no need to ask about a GitHub backup again.
      go(restoreId ? 'import' : 'backup');
    } catch {
      setError('Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    try {
      await postJson('/api/auth/profile', { theme }, 'PUT');
      queryClient.setQueryData<{ state: string; user: AuthUser | null }>(['auth'], old =>
        old?.user ? { ...old, user: { ...old.user, theme } } : old);
      try { sessionStorage.removeItem(RESUME_KEY); } catch { /* storage blocked */ }
      await queryClient.invalidateQueries();
      navigate('/', { replace: true });
    } finally {
      setBusy(false);
    }
  }

  const accountIndex = ACCOUNT_STEPS.indexOf(step);
  const afterIndex = AFTER_STEPS.indexOf(step);
  const usernameProblem = username.trim() ? usernameRule(username.trim()) : null;
  const passwordProblem = password && password.length < 8 ? 'At least 8 characters.' : null;
  const pinProblem = pin ? pinRule(pin) : null;

  if (!status && !error) {
    return <div className="auth"><div className="setup__card"><Loader2 className="setup__spin" aria-label="Loading" /></div></div>;
  }

  return (
    <div className="auth">
      <div className="setup__card">
        <header className="setup__head">
          <img src={logo} alt="" className="setup__logo" />
          <span className="setup__brand">Papyra</span>
        </header>

        {(accountIndex >= 0 || afterIndex >= 0) && (
          <ol className="setup__progress" aria-label="Setup steps">
            {(accountIndex >= 0 ? ACCOUNT_STEPS : AFTER_STEPS).map((s, i) => {
              const at = accountIndex >= 0 ? accountIndex : afterIndex;
              return (
                <li key={s} className={`setup__dot${i === at ? ' is-current' : ''}${i < at ? ' is-done' : ''}`} aria-current={i === at ? 'step' : undefined}>
                  <span aria-hidden="true">{i < at ? <Check size={11} /> : i + 1}</span>
                  <span className="setup__dot-label">{STEP_LABEL[s]}</span>
                </li>
              );
            })}
          </ol>
        )}

        {error && <p className="auth__error" role="alert">{error}</p>}

        {step === 'welcome' && (
          <section className="setup__body">
            <h1 className="auth__title">Welcome to Papyra</h1>
            <p className="auth__tagline">Let’s set up this server’s administrator account. It takes a few minutes.</p>
            <div className="setup__choices">
              <button type="button" className="setup__choice" onClick={() => go('username')}>
                <Sparkles size={20} aria-hidden="true" />
                <strong>Start fresh</strong>
                <span>Create your account. You can still import notes or restore a GitHub backup along the way.</span>
              </button>
              <button type="button" className="setup__choice" onClick={() => go('restore')}>
                <CloudDownload size={20} aria-hidden="true" />
                <strong>Restore from a backup</strong>
                <span>Bring back notes, to-dos, locked notes, attachments and preferences from GitHub or an encrypted backup file.</span>
              </button>
            </div>
          </section>
        )}

        {step === 'restore' && (
          <RestoreStep
            onStaged={(id, summary) => {
              setRestoreId(id);
              setRestoreSummary(summary);
              prefillFrom(summary);
              go('username');
            }}
            onBack={() => go('welcome')}
          />
        )}

        {step === 'username' && (
          <form className="setup__body" onSubmit={e => { e.preventDefault(); if (!usernameProblem && username.trim()) go('email'); }}>
            <h1 className="auth__title">Choose a username</h1>
            {restoreSummary && (
              <p className="setup__note"><CheckCircle2 size={15} aria-hidden="true" /> Backup ready to restore: {summaryLine(restoreSummary)}. Now set up your account again.</p>
            )}
            <p className="auth__tagline">How you sign in and how people @mention you. It’s unique on this Papyra.</p>
            <label className="auth__field">Username
              <span className="setup__affix"><span aria-hidden="true">@</span>
                <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username"
                  spellCheck={false} autoCapitalize="none" maxLength={64} autoFocus required aria-invalid={!!usernameProblem} />
              </span>
              {usernameProblem && <span className="setup__field-error">{usernameProblem}</span>}
            </label>
            <label className="auth__field">Display name <span className="setup__optional">(optional)</span>
              <input value={name} onChange={e => setName(e.target.value)} autoComplete="name" maxLength={100} placeholder={username || 'Your name'} />
            </label>
            <Nav onBack={() => go(restoreSummary ? 'restore' : 'welcome')} nextDisabled={!username.trim() || !!usernameProblem} />
          </form>
        )}

        {step === 'email' && (
          <EmailStep
            email={email}
            setEmail={v => { setEmail(v); setSkipVerify(false); setCode(''); }}
            emailConfigured={!!status?.emailConfigured}
            busy={busy}
            onConfigured={() => setStatus(s => s && { ...s, emailConfigured: true })}
            onSend={() => void sendCode()}
            onSkip={() => { setSkipVerify(true); go('password'); }}
            onBack={() => go('username')}
            onError={setError}
          />
        )}

        {step === 'code' && (
          <form className="setup__body" onSubmit={e => { e.preventDefault(); void verifyCode(); }}>
            <h1 className="auth__title">Check your inbox</h1>
            <p className="auth__tagline">We sent a six-digit code to <strong>{codeSentTo}</strong>. It works for 15 minutes.</p>
            <label className="auth__field">Code
              <input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} inputMode="numeric"
                autoComplete="one-time-code" maxLength={6} autoFocus required className="setup__code" />
            </label>
            <button type="button" className="setup__link" disabled={busy} onClick={() => void sendCode()}>Send a new code</button>
            <Nav onBack={() => go('email')} nextDisabled={code.length !== 6 || busy} nextLabel={busy ? 'Checking…' : 'Verify'} />
          </form>
        )}

        {step === 'password' && (
          <form className="setup__body" onSubmit={e => { e.preventDefault(); if (!passwordProblem && password === password2) go('pin'); }}>
            <h1 className="auth__title">Set a password</h1>
            <p className="auth__tagline">At least 8 characters. It also unlocks encrypted backups of your notes.</p>
            <label className="auth__field">Password
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" autoFocus required />
              {passwordProblem && <span className="setup__field-error">{passwordProblem}</span>}
            </label>
            <label className="auth__field">Repeat password
              <input type="password" value={password2} onChange={e => setPassword2(e.target.value)} autoComplete="new-password" required />
              {password2 && password !== password2 && <span className="setup__field-error">The passwords don’t match.</span>}
            </label>
            <Nav onBack={() => go(skipVerify || !status?.emailConfigured || !email.trim() ? 'email' : 'code')}
              nextDisabled={!password || !!passwordProblem || password !== password2} />
          </form>
        )}

        {step === 'pin' && (
          <form className="setup__body" onSubmit={e => { e.preventDefault(); if (!pinProblem && pin === pin2) go('timezone'); }}>
            <h1 className="auth__title">A PIN for your vault</h1>
            <p className="auth__tagline">
              Locked notes open with this 6–12 digit PIN, even while you’re signed in. You can add fingerprint or
              face unlock later in Settings → Security.
            </p>
            <label className="auth__field">Vault PIN
              <input {...MASKED_SECRET} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={12} autoFocus required />
              {pinProblem && <span className="setup__field-error">{pinProblem}</span>}
            </label>
            <label className="auth__field">Repeat PIN
              <input {...MASKED_SECRET} value={pin2} onChange={e => setPin2(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={12} required />
              {pin2 && pin !== pin2 && <span className="setup__field-error">The PINs don’t match.</span>}
            </label>
            <Nav onBack={() => go('password')} nextDisabled={!pin || !!pinProblem || pin !== pin2} />
          </form>
        )}

        {step === 'timezone' && (
          <form className="setup__body" onSubmit={e => { e.preventDefault(); void createAccount(); }}>
            <h1 className="auth__title">Your time zone</h1>
            <p className="auth__tagline">Pick your country, then the zone within it. We guessed from this browser.</p>
            <TimeZonePicker value={zone} onChange={setZone} allowDefault={false} />
            <Nav onBack={() => go('pin')} nextDisabled={!zone || busy}
              nextLabel={busy ? (restoreId ? 'Creating and restoring…' : 'Creating…') : 'Create account'} />
          </form>
        )}

        {step === 'backup' && (
          <section className="setup__body">
            <h1 className="auth__title">Already have a GitHub backup?</h1>
            <p className="auth__tagline">
              If an earlier Papyra backed your notes up to GitHub, bring them back now — plain or encrypted.
              Otherwise skip this; you can set a new backup up later in Settings → Backup.
            </p>
            <GitRestorePanel confirmReplace={false} accountPassword={password} onRestored={n => setRestoredCount(n)} />
            <div className="setup__nav">
              <span />
              <button type="button" className="auth__submit" onClick={() => go('import')}>
                {restoredCount != null ? 'Continue' : 'Skip'} <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          </section>
        )}

        {step === 'import' && (
          <ImportStep restoredCount={restoredCount} onNext={() => go('theme')} />
        )}

        {step === 'theme' && (
          <section className="setup__body">
            <h1 className="auth__title">Light or dark?</h1>
            <p className="auth__tagline">Saved to your account, so every device you sign in on opens this way. Change it any time with the sun/moon button.</p>
            <div className="setup__themes" role="radiogroup" aria-label="Theme">
              {([
                ['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'Match device', Monitor],
              ] as [ThemePreference, string, typeof Sun][]).map(([id, label, Icon]) => (
                <button key={id} type="button" role="radio" aria-checked={theme === id}
                  className={`setup__theme setup__theme--${id}${theme === id ? ' is-on' : ''}`}
                  onClick={() => pickTheme(id)}>
                  <span className="setup__theme-swatch" aria-hidden="true"><span /><span /><span /></span>
                  <span className="setup__theme-label"><Icon size={15} aria-hidden="true" /> {label}</span>
                </button>
              ))}
            </div>
            <div className="setup__nav">
              <button type="button" className="setup__back" onClick={() => go('import')}><ArrowLeft size={15} aria-hidden="true" /> Back</button>
              <button type="button" className="auth__submit" disabled={busy} onClick={() => void finish()}>
                Open Papyra <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Nav({ onBack, nextDisabled, nextLabel = 'Next' }: { onBack: () => void; nextDisabled: boolean; nextLabel?: string }) {
  return (
    <div className="setup__nav">
      <button type="button" className="setup__back" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> Back</button>
      <button type="submit" className="auth__submit" disabled={nextDisabled}>
        {nextLabel} <ArrowRight size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

// ── Restore before the account exists ─────────────────────────────────────────

function RestoreStep({ onStaged, onBack }: { onStaged: (id: string, summary: BackupSummary) => void; onBack: () => void }) {
  const [kind, setKind] = useState<'git' | 'file'>('git');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [token, setToken] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const repoUrl = normaliseRepoUrl(repo);

  const ready = kind === 'git' ? !!repoUrl && !!token.trim() && (!needsPassword || !!password) : !!file && !!password;

  async function stage() {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('kind', kind);
      form.append('password', password);
      if (kind === 'git') {
        form.append('remoteUrl', repoUrl ?? '');
        form.append('branch', branch.trim() || 'main');
        form.append('token', token.trim());
      } else if (file) {
        form.append('file', file, file.name);
      }
      const res = await fetch('/api/auth/setup/restore', { method: 'POST', body: form });
      const data = await res.json().catch(() => null) as { restoreId?: string; summary?: BackupSummary; error?: string; code?: string } | null;
      if (!res.ok || !data?.restoreId || !data.summary) {
        if (data?.code === 'password_required' || data?.code === 'password_wrong') setNeedsPassword(true);
        setError(data?.error ?? 'That backup couldn’t be read.');
        return;
      }
      onStaged(data.restoreId, data.summary);
    } catch {
      setError('Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="setup__body" onSubmit={e => { e.preventDefault(); if (ready) void stage(); }}>
      <h1 className="auth__title">Restore a backup</h1>
      <p className="auth__tagline">
        Nothing is written yet — Papyra opens the backup, shows what’s in it, and restores it when your account is created.
      </p>
      <div className="setup__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={kind === 'git'} className={kind === 'git' ? 'is-on' : ''} onClick={() => setKind('git')}>
          <GitBranch size={15} aria-hidden="true" /> GitHub
        </button>
        <button type="button" role="tab" aria-selected={kind === 'file'} className={kind === 'file' ? 'is-on' : ''} onClick={() => setKind('file')}>
          <FileArchive size={15} aria-hidden="true" /> Backup file
        </button>
      </div>
      {kind === 'git' ? (
        <>
          <label className="auth__field">Repository address
            <input type="url" value={repo} {...NO_AUTOFILL} placeholder="https://github.com/your-name/papyra-notes" onChange={e => setRepo(e.target.value)} autoFocus />
          </label>
          <div className="setup__row">
            <label className="auth__field setup__narrow">Branch
              <input value={branch} {...NO_AUTOFILL} onChange={e => setBranch(e.target.value)} />
            </label>
            <label className="auth__field setup__grow">Access token
              <input {...MASKED_SECRET} value={token} placeholder="github_pat_…" onChange={e => setToken(e.target.value)} />
            </label>
          </div>
          <p className="setup__hint">
            A token that can read the repository: GitHub → Settings → Developer settings → <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
            Fine-grained tokens <ExternalLink size={11} aria-hidden="true" /></a> → only this repository → Contents: Read and write
            (write lets Papyra keep backing up there).
          </p>
          <label className="auth__field">Backup password {needsPassword ? '' : <span className="setup__optional">(encrypted backups only)</span>}
            <input type="password" value={password} autoComplete="off" onChange={e => setPassword(e.target.value)}
              placeholder="Your Papyra password when the backup was made" />
          </label>
        </>
      ) : (
        <>
          <div className="auth__field">Backup file (.papyra-vault)
            <button type="button" className="setup__file" onClick={() => fileRef.current?.click()}>
              <Upload size={15} aria-hidden="true" /> {file ? file.name : 'Choose file…'}
            </button>
            <input ref={fileRef} type="file" accept=".papyra-vault" hidden onChange={e => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <label className="auth__field">Backup password
            <input type="password" value={password} autoComplete="off" onChange={e => setPassword(e.target.value)} />
          </label>
        </>
      )}
      {error && <p className="setup__field-error" role="alert"><TriangleAlert size={14} aria-hidden="true" /> {error}</p>}
      <Nav onBack={onBack} nextDisabled={!ready || busy} nextLabel={busy ? 'Opening backup…' : 'Open backup'} />
    </form>
  );
}

// ── Email, with outgoing mail set up on the spot when needed ────────────────────

function EmailStep({ email, setEmail, emailConfigured, busy, onConfigured, onSend, onSkip, onBack, onError }: {
  email: string; setEmail: (v: string) => void; emailConfigured: boolean; busy: boolean;
  onConfigured: () => void; onSend: () => void; onSkip: () => void; onBack: () => void; onError: (e: string | null) => void;
}) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('587');
  const [useSsl, setUseSsl] = useState(true);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [from, setFrom] = useState('');
  const [saving, setSaving] = useState(false);
  const valid = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email.trim());

  async function saveSmtp() {
    setSaving(true);
    onError(null);
    try {
      const { res, data } = await postJson('/api/auth/setup/smtp', {
        host: host.trim(), port: Number(port) || 587, useSsl, username: smtpUser.trim(), password: smtpPass,
        fromAddress: (from.trim() || smtpUser.trim()), fromName: 'Papyra', publicUrl: window.location.origin,
      }, 'PUT');
      if (!res.ok) { onError((data?.error as string) ?? 'Those mail settings didn’t save.'); return; }
      onConfigured();
      onSend();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="setup__body" onSubmit={e => { e.preventDefault(); if (valid && emailConfigured) onSend(); }}>
      <h1 className="auth__title">Your email</h1>
      <p className="auth__tagline">For password resets and security alerts. We’ll send a code to confirm it’s yours.</p>
      <label className="auth__field">Email address
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" autoFocus required />
      </label>
      {!emailConfigured && (
        <fieldset className="setup__smtp">
          <legend>Papyra can’t send email yet</legend>
          <p className="setup__hint">
            Add your mail provider’s SMTP details and we’ll send the code. For Gmail: host <code>smtp.gmail.com</code>, port 587,
            your address as the username and an <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">app password</a>.
          </p>
          <div className="setup__row">
            <label className="auth__field setup__grow">SMTP host
              <input value={host} {...NO_AUTOFILL} onChange={e => setHost(e.target.value)} placeholder="smtp.example.com" />
            </label>
            <label className="auth__field setup__narrow">Port
              <input value={port} inputMode="numeric" onChange={e => setPort(e.target.value.replace(/\D/g, ''))} />
            </label>
          </div>
          <div className="setup__row">
            <label className="auth__field setup__grow">Username
              <input value={smtpUser} {...NO_AUTOFILL} onChange={e => setSmtpUser(e.target.value)} />
            </label>
            <label className="auth__field setup__grow">Password
              <input {...MASKED_SECRET} value={smtpPass} onChange={e => setSmtpPass(e.target.value)} />
            </label>
          </div>
          <label className="auth__field">Send from <span className="setup__optional">(defaults to the username)</span>
            <input value={from} {...NO_AUTOFILL} onChange={e => setFrom(e.target.value)} placeholder="papyra@example.com" />
          </label>
          <label className="setup__check">
            <input type="checkbox" checked={useSsl} onChange={e => setUseSsl(e.target.checked)} /> Use TLS
          </label>
          <div className="setup__row">
            <button type="button" className="auth__submit" disabled={!valid || !host.trim() || saving || busy} onClick={() => void saveSmtp()}>
              {saving || busy ? 'Sending…' : 'Save and send code'}
            </button>
            <button type="button" className="setup__link" onClick={onSkip} disabled={!valid}>
              Skip — set up email later (the address won’t be verified)
            </button>
          </div>
        </fieldset>
      )}
      <div className="setup__nav">
        <button type="button" className="setup__back" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> Back</button>
        {emailConfigured && (
          <button type="submit" className="auth__submit" disabled={!valid || busy}>
            {busy ? 'Sending…' : 'Send code'} <ArrowRight size={15} aria-hidden="true" />
          </button>
        )}
      </div>
    </form>
  );
}

// ── Imports, with how to get the export out of each app ───────────────────────

const KEEP_STEPS = [
  <>Open <a href="https://takeout.google.com" target="_blank" rel="noreferrer">Google Takeout <ExternalLink size={11} aria-hidden="true" /></a> signed in to the Google account with your notes.</>,
  <>Press <strong>Deselect all</strong>, then tick only <strong>Keep</strong>.</>,
  <>Press <strong>Next step</strong> → <em>Export once</em>, file type <strong>.zip</strong> → <strong>Create export</strong>.</>,
  <>Google emails you a link (minutes for a few notes, longer for many). Download the .zip and choose it below — don’t unzip it.</>,
];
const OBSIDIAN_STEPS = [
  <>In Obsidian, find your vault’s folder: the vault switcher → <strong>Manage vaults</strong> → <em>Reveal vault in system explorer</em>.</>,
  <>Zip the whole folder. Windows: right-click it → <strong>Send to → Compressed (zipped) folder</strong>. macOS: right-click → <strong>Compress</strong>.</>,
  <>Choose that .zip below. Notes keep their folders, tags, frontmatter and attachments.</>,
];

function ImportStep({ restoredCount, onNext }: { restoredCount: number | null; onNext: () => void }) {
  const [provider, setProvider] = useState<'keep' | 'obsidian'>('keep');
  const [job, setJob] = useState<ImportStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const running = !!job && !job.done;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const res = await fetch('/api/import/status');
      if (!res.ok || res.status === 204) return;
      const s = await res.json() as ImportStatus;
      setJob(s);
      if (s.done) setHistory(h => [...h, `${s.provider === 'keep' ? 'Google Keep' : 'Obsidian'}: ${importSummary(s)}`]);
    }, 1000);
    return () => clearInterval(t);
  }, [running]);

  async function upload(file: File) {
    setError(null);
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await fetch(`/api/import/${provider}`, { method: 'POST', body: form });
    const data = await res.json().catch(() => null) as (ImportStatus & { error?: string }) | null;
    if (!res.ok || !data) { setError(data?.error ?? 'That import couldn’t start.'); return; }
    setJob(data);
  }

  const pct = job && job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
  const steps = provider === 'keep' ? KEEP_STEPS : OBSIDIAN_STEPS;

  return (
    <section className="setup__body">
      <h1 className="auth__title">Bring your notes in</h1>
      {restoredCount != null && (
        <p className="setup__note"><CheckCircle2 size={15} aria-hidden="true" /> {restoredCount} notes restored from your backup.</p>
      )}
      <p className="auth__tagline">
        Optional. Import from Google Keep or Obsidian now — as many archives as you like — or skip and do it later
        from Settings → Data &amp; Storage. Importing the same archive twice never duplicates a note.
      </p>
      <div className="setup__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={provider === 'keep'} className={provider === 'keep' ? 'is-on' : ''} disabled={running} onClick={() => setProvider('keep')}>
          <FileArchive size={15} aria-hidden="true" /> Google Keep (Takeout)
        </button>
        <button type="button" role="tab" aria-selected={provider === 'obsidian'} className={provider === 'obsidian' ? 'is-on' : ''} disabled={running} onClick={() => setProvider('obsidian')}>
          <FolderInput size={15} aria-hidden="true" /> Obsidian vault
        </button>
      </div>
      <ol className="setup__howto">
        {steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      <div>
        <button type="button" className="setup__file" disabled={running} onClick={() => fileRef.current?.click()}>
          <Upload size={15} aria-hidden="true" /> Choose {provider === 'keep' ? 'Takeout' : 'vault'} .zip
        </button>
        <input ref={fileRef} type="file" accept=".zip" hidden onChange={e => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = '';
        }} />
      </div>
      {running && (
        <div className="setup__progress-bar" role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
          <em>{job!.total > 0 ? `${job!.processed} of ${job!.total}` : 'Starting…'}</em>
        </div>
      )}
      {history.length > 0 && (
        <ul className="setup__done-list" role="status">
          {history.map((h, i) => <li key={i}><CheckCircle2 size={14} aria-hidden="true" /> {h}</li>)}
        </ul>
      )}
      {history.length > 0 && !running && (
        <p className="setup__hint">Missing something? Import another archive — anything already here is recognised and left alone.</p>
      )}
      {error && <p className="setup__field-error" role="alert">{error}</p>}
      <div className="setup__nav">
        <span />
        <button type="button" className="auth__submit" disabled={running} onClick={onNext}>
          {history.length ? 'Continue' : 'Skip for now'} <ArrowRight size={15} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
