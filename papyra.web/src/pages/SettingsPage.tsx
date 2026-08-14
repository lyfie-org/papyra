import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  User as UserIcon, Palette, Database, Shield, Info, Camera,
  Sun, Moon, Monitor, Upload, Download, RefreshCw, KeyRound, Copy, Trash2, Lock, ShieldAlert,
  Fingerprint, CheckCircle2, GitBranch, AlertTriangle, Bell, Mail, KeySquare, Send, UserPlus,
  Sparkles,
} from 'lucide-react';
import { useGitConfig, useSaveGitConfig, useRunGitSync } from '../hooks/useGitSync';
import {
  useOidcConfig, useSaveOidcConfig, useSmtpConfig, useSaveSmtpConfig,
  useSendTestEmail, useInviteUser, useNotificationPrefs, useSaveNotificationPrefs,
} from '../hooks/useInstanceConfig';
import {
  useAiConfig, useSaveAiConfig, useAiStatus, useAiModels, usePullModel,
  type AiConfig, type PullProgress,
} from '../hooks/useAi';
import { useWebAuthnDevices } from '../hooks/useWebAuthnDevices';
import { hasPlatformAuthenticator, isWebAuthnAvailable } from '../lib/webauthn';
import { useAuth, type AuthUser } from '../hooks/useAuth';
import { useNotes } from '../hooks/useNotes';
import { useCategories } from '../hooks/useCategories';
import { useTheme, type ThemePreference } from '../hooks/useTheme';
import { useSettings, useUpdateSettings, RETENTION_OPTIONS } from '../hooks/useSettings';
import './SettingsPage.css';

const APP_VERSION = '0.0.1';

type Tab = 'profile' | 'appearance' | 'notifications' | 'security' | 'data' | 'keys' | 'sync' | 'sso' | 'email' | 'ai' | 'admin' | 'about';

const NAV: { id: Tab; label: string; icon: typeof UserIcon; adminOnly?: boolean }[] = [
  { id: 'profile', label: 'Profile', icon: UserIcon },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'security', label: 'Security', icon: Fingerprint },
  { id: 'data', label: 'Data & Storage', icon: Database },
  { id: 'keys', label: 'API Keys', icon: KeyRound },
  { id: 'sync', label: 'Git Sync', icon: GitBranch, adminOnly: true },
  { id: 'sso', label: 'SSO', icon: KeySquare, adminOnly: true },
  { id: 'email', label: 'Email', icon: Mail, adminOnly: true },
  { id: 'ai', label: 'AI', icon: Sparkles, adminOnly: true },
  { id: 'admin', label: 'Administration', icon: Shield, adminOnly: true },
  { id: 'about', label: 'About', icon: Info },
];

export default function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') as Tab | null;
  const valid = NAV.find(n => n.id === requested && (!n.adminOnly || isAdmin));
  const tab: Tab = valid?.id ?? 'profile';
  const setTab = (t: Tab) => setParams(t === 'profile' ? {} : { tab: t }, { replace: true });

  return (
    <section className="settings">
      <h1 className="page-title settings__title">Settings</h1>
      <div className="settings__shell">
        <nav className="settings__rail" aria-label="Settings sections">
          {NAV.filter(n => !n.adminOnly || isAdmin).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`settings__rail-item${tab === id ? ' is-active' : ''}`}
              aria-current={tab === id}
              onClick={() => setTab(id)}
            >
              <Icon size={17} /> {label}
            </button>
          ))}
        </nav>

        <div className="settings__content">
          {tab === 'profile' && <ProfileTab user={user} />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'security' && <SecurityTab />}
          {tab === 'data' && <DataTab />}
          {tab === 'keys' && <KeysTab />}
          {tab === 'sync' && isAdmin && <SyncTab />}
          {tab === 'sso' && isAdmin && <SsoTab />}
          {tab === 'email' && isAdmin && <EmailTab />}
          {tab === 'ai' && isAdmin && <AiTab />}
          {tab === 'admin' && isAdmin && <AdminTab />}
          {tab === 'about' && <AboutTab />}
        </div>
      </div>
    </section>
  );
}

// ── Profile ───────────────────────────────────────────────────────────────────
function ProfileTab({ user }: { user: AuthUser | null }) {
  const { data: notes } = useNotes();
  const { data: categories } = useCategories();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [avatarV, setAvatarV] = useState(0); // cache-bust after upload
  const [avatarOk, setAvatarOk] = useState(true);

  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);

  const noteCount = notes?.filter(n => !n.trashed).length ?? 0;
  const tagCount = new Set((notes ?? []).flatMap(n => n.tags ?? [])).size;
  const catCount = categories?.length ?? 0;
  const initial = (user?.name || user?.username || 'P').trim().charAt(0).toUpperCase();

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSavedMsg(null);
    const res = await fetch('/api/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
      setSavedMsg('Profile saved.');
    } else setSavedMsg('Couldn’t save profile.');
  }

  async function uploadAvatar(file: File) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/auth/avatar', { method: 'POST', body: form });
    if (res.ok) { setAvatarOk(true); setAvatarV(v => v + 1); }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: cur, next }),
    });
    if (res.ok) { setCur(''); setNext(''); setPwMsg('Password changed.'); }
    else {
      const data = await res.json().catch(() => null);
      setPwMsg(data?.error ?? 'Couldn’t change password.');
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    await queryClient.invalidateQueries({ queryKey: ['auth'] });
    navigate('/login', { replace: true });
  }

  return (
    <div className="settings__panel">
      <div className="settings__profile-head">
        <button
          type="button"
          className="settings__avatar"
          onClick={() => fileRef.current?.click()}
          aria-label="Change profile picture"
        >
          {avatarOk
            ? <img src={`/api/auth/avatar?v=${avatarV}`} alt="" onError={() => setAvatarOk(false)} />
            : <span>{initial}</span>}
          <span className="settings__avatar-edit"><Camera size={14} /></span>
        </button>
        <input
          ref={fileRef} type="file" accept="image/*" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) void uploadAvatar(f); }}
        />
        <div>
          <div className="settings__profile-name">{user?.name || user?.username}</div>
          <div className="settings__profile-sub">@{user?.username} · {user?.role}</div>
        </div>
      </div>

      <div className="settings__stats">
        <div className="settings__stat"><span className="settings__stat-num">{noteCount}</span> notes</div>
        <div className="settings__stat"><span className="settings__stat-num">{tagCount}</span> tags</div>
        <div className="settings__stat"><span className="settings__stat-num">{catCount}</span> categories</div>
      </div>

      <form className="settings__form" onSubmit={saveProfile}>
        <h2 className="settings__subhead">Account</h2>
        <label className="settings__field">Display name
          <input value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label className="settings__field">Email
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} />
        </label>
        <div className="settings__form-actions">
          <button type="submit" className="settings__btn">Save changes</button>
          {savedMsg && <span className="settings__msg">{savedMsg}</span>}
        </div>
      </form>

      <form className="settings__form" onSubmit={changePassword}>
        <h2 className="settings__subhead">Change password</h2>
        <label className="settings__field">Current password
          <input type="password" value={cur} onChange={e => setCur(e.target.value)} required />
        </label>
        <label className="settings__field">New password
          <input type="password" value={next} onChange={e => setNext(e.target.value)} required />
        </label>
        <div className="settings__form-actions">
          <button type="submit" className="settings__btn">Update password</button>
          {pwMsg && <span className="settings__msg">{pwMsg}</span>}
        </div>
      </form>

      <button type="button" className="settings__danger" onClick={() => void logout()}>Sign out</button>
    </div>
  );
}

// ── Appearance ──────────────────────────────────────────────────────────────────
function AppearanceTab() {
  const { preference, setPreference } = useTheme();
  const options: { id: ThemePreference; label: string; icon: typeof Sun }[] = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'system', label: 'System', icon: Monitor },
  ];
  return (
    <div className="settings__panel">
      <h2 className="settings__subhead">Theme</h2>
      <p className="settings__hint">Choose how Papyra looks. “System” follows your OS setting.</p>
      <div className="settings__segment" role="radiogroup" aria-label="Theme">
        {options.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={preference === id}
            className={`settings__segment-btn${preference === id ? ' is-active' : ''}`}
            onClick={() => setPreference(id)}
          >
            <Icon size={18} /> {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Security (biometric devices) ─────────────────────────────────────────────────
// Enrol a platform authenticator so `secure: true` notes can be unlocked. The
// private key never leaves the device; Papyra only stores the public key.
function SecurityTab() {
  const { devices, enroll, revoke, enrolling, error, setError } = useWebAuthnDevices();
  const [name, setName] = useState('');
  const [justEnrolled, setJustEnrolled] = useState(false);
  // Whether this machine actually offers Touch ID / Windows Hello, so we can
  // explain an unavailable button instead of just disabling it.
  const [platformAvailable, setPlatformAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void hasPlatformAuthenticator().then(ok => { if (!cancelled) setPlatformAvailable(ok); });
    return () => { cancelled = true; };
  }, []);

  const supported = isWebAuthnAvailable();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setJustEnrolled(false);
    const ok = await enroll(name);
    if (ok) { setName(''); setJustEnrolled(true); }
  }

  async function remove(device: { id: number; name: string }) {
    if (!confirm(`Remove “${device.name}”? You won’t be able to unlock secure notes with it any more.`)) return;
    await revoke(device.id);
  }

  return (
    <div className="settings__panel">
      <h2 className="settings__subhead">Biometric unlock</h2>
      <p className="settings__hint">
        Register this device’s built-in authenticator (Touch ID, Face ID, or Windows Hello) to unlock notes
        marked <code>secure: true</code>. The private key never leaves your device — Papyra only stores the
        public key, and a locked note’s contents stay on the server until you authenticate.
      </p>

      {!supported && (
        <p className="settings__hint settings__hint--warn">
          <ShieldAlert size={15} />
          This browser can’t register a key here. WebAuthn needs a secure context — use{' '}
          <code>localhost</code> or serve Papyra over HTTPS.
        </p>
      )}
      {supported && platformAvailable === false && (
        <p className="settings__hint settings__hint--warn">
          <ShieldAlert size={15} />
          No built-in biometric sensor was detected on this device. You can still register a security key
          if your browser offers one.
        </p>
      )}

      <form className="settings__row" onSubmit={submit}>
        <input
          className="settings__select"
          placeholder="Device name (e.g. Work laptop)"
          value={name}
          onChange={e => { setName(e.target.value); setError(null); }}
          disabled={!supported || enrolling}
        />
        <button type="submit" className="settings__btn" disabled={!supported || enrolling}>
          <Fingerprint size={16} /> {enrolling ? 'Waiting for authenticator…' : 'Register this device'}
        </button>
      </form>

      {error && <p className="settings__error" role="alert">{error}</p>}
      {justEnrolled && (
        <p className="settings__msg"><CheckCircle2 size={14} /> Device registered — you can now unlock secure notes.</p>
      )}

      {devices.isLoading && <p>Loading devices…</p>}
      {devices.data && devices.data.length > 0 && (
        <table className="settings__users">
          <thead>
            <tr><th>Device</th><th>Registered</th><th>Last used</th><th /></tr>
          </thead>
          <tbody>
            {devices.data.map(d => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{new Date(d.createdUtc).toLocaleDateString()}</td>
                <td>{d.lastUsedUtc ? new Date(d.lastUsedUtc).toLocaleString() : 'Never'}</td>
                <td>
                  <button type="button" className="settings__link settings__link--danger" onClick={() => void remove(d)}>
                    <Trash2 size={13} /> Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {devices.data && devices.data.length === 0 && (
        <p className="settings__hint">No devices registered yet. Secure notes stay locked until you add one.</p>
      )}
    </div>
  );
}

// ── Data & Storage ───────────────────────────────────────────────────────────────
function DataTab() {
  const { data: settings, isLoading } = useSettings();
  const update = useUpdateSettings();
  const [provider, setProvider] = useState<'obsidian' | 'keep'>('obsidian');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [rebuildMsg, setRebuildMsg] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);

  async function runImport(file: File) {
    setImportMsg('Uploading…');
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/import/${provider}`, { method: 'POST', body: form });
    setImportMsg(res.ok ? 'Import started — notes will appear as they’re processed.' : 'Import failed.');
  }

  async function rebuild() {
    setRebuildMsg('Rebuilding…');
    const res = await fetch('/api/system/rebuild-index', { method: 'POST' });
    const data = await res.json().catch(() => null);
    setRebuildMsg(res.ok ? `Rebuilt ${data?.rebuilt ?? 0} notes.` : 'Rebuild failed.');
  }

  return (
    <div className="settings__panel">
      <h2 className="settings__subhead">Import</h2>
      <p className="settings__hint">Bring notes in from another app. Existing notes are never overwritten.</p>
      <div className="settings__row">
        <select className="settings__select" value={provider} onChange={e => setProvider(e.target.value as 'obsidian' | 'keep')}>
          <option value="obsidian">Obsidian vault (.zip)</option>
          <option value="keep">Google Keep (.zip)</option>
        </select>
        <button type="button" className="settings__btn" onClick={() => importRef.current?.click()}>
          <Upload size={16} /> Choose archive
        </button>
        <input ref={importRef} type="file" accept=".zip" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) void runImport(f); }} />
      </div>
      {importMsg && <p className="settings__msg">{importMsg}</p>}

      <h2 className="settings__subhead">Export</h2>
      <p className="settings__hint">Download every note as a zip of plain text files you can open anywhere.</p>
      <a className="settings__btn" href="/api/export">
        <Download size={16} /> Export all notes
      </a>

      <EncryptedBackupSection />

      <h2 className="settings__subhead">Maintenance</h2>
      <p className="settings__hint">If search is missing notes it should be finding, rebuild it from your files. Safe to run any time — it only rewrites what search uses, never your notes.</p>
      <button type="button" className="settings__btn" onClick={() => void rebuild()}>
        <RefreshCw size={16} /> Rebuild search
      </button>
      {rebuildMsg && <p className="settings__msg">{rebuildMsg}</p>}

      <h2 className="settings__subhead">Trash auto-delete</h2>
      <p className="settings__hint">
        How long deleted notes stay in Trash. “Delete immediately” skips Trash — those deletes can’t be recovered.
      </p>
      <label className="settings__field settings__field--inline">Permanently delete trashed notes
        <select
          className="settings__select"
          disabled={isLoading || update.isPending}
          value={settings?.trashRetentionDays ?? 30}
          onChange={e => update.mutate({ trashRetentionDays: Number(e.target.value) })}
        >
          {RETENTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {update.isError && <p className="settings__error">Couldn’t save the setting.</p>}
    </div>
  );
}

// ── Encrypted backup ──────────────────────────────────────────────────────────────
// AES-GCM vault export/restore, gated by the account password. Restore replaces
// the signed-in user's notes + media with the backup's contents.
function EncryptedBackupSection() {
  const queryClient = useQueryClient();
  const restoreRef = useRef<HTMLInputElement | null>(null);

  const [exportPw, setExportPw] = useState('');
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);

  const [restorePw, setRestorePw] = useState('');
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setExportMsg(null);
    setExportBusy(true);
    try {
      const res = await fetch('/api/backups/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: exportPw }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setExportMsg(data?.error ?? 'Couldn’t generate the backup.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'papyra-backup.papyra-vault';
      a.click();
      URL.revokeObjectURL(url);
      setExportPw('');
      setExportMsg('Encrypted backup downloaded.');
    } finally {
      setExportBusy(false);
    }
  }

  async function restore(file: File) {
    if (!restorePw) { setRestoreMsg('Enter your account password first.'); return; }
    if (!confirm('Restore this backup? It replaces all your current notes and media with the backup’s contents. This can’t be undone.')) return;
    setRestoreMsg('Restoring…');
    setRestoreBusy(true);
    try {
      const form = new FormData();
      form.append('password', restorePw);
      form.append('file', file);
      const res = await fetch('/api/backups/restore', { method: 'POST', body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setRestoreMsg(data?.error ?? 'Restore failed.'); return; }
      setRestorePw('');
      setRestoreMsg(`Restored ${data?.restored ?? 0} notes.`);
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
      await queryClient.invalidateQueries({ queryKey: ['categories'] });
    } finally {
      setRestoreBusy(false);
    }
  }

  return (
    <>
      <h2 className="settings__subhead">Encrypted backup</h2>
      <p className="settings__hint">
        Download an encrypted <code>.papyra-vault</code> of every note and attachment, sealed with your account
        password (AES-GCM). Keep the password — without it the backup can’t be opened.
      </p>
      <form className="settings__row" onSubmit={generate}>
        <input
          className="settings__select" type="password" autoComplete="current-password"
          placeholder="Account password" value={exportPw} onChange={e => setExportPw(e.target.value)} required
        />
        <button type="submit" className="settings__btn" disabled={exportBusy || !exportPw}>
          <Lock size={16} /> {exportBusy ? 'Encrypting…' : 'Download encrypted backup'}
        </button>
      </form>
      {exportMsg && <p className="settings__msg">{exportMsg}</p>}

      <h2 className="settings__subhead">Restore from encrypted backup</h2>
      <p className="settings__hint settings__hint--warn">
        <ShieldAlert size={15} /> Restoring <strong>replaces</strong> all your current notes and attachments with the
        backup’s contents. Enter the password the backup was sealed with.
      </p>
      <div className="settings__row">
        <input
          className="settings__select" type="password" autoComplete="off"
          placeholder="Backup password" value={restorePw} onChange={e => setRestorePw(e.target.value)}
        />
        <button
          type="button" className="settings__btn" disabled={restoreBusy || !restorePw}
          onClick={() => restoreRef.current?.click()}
        >
          <Upload size={16} /> Choose vault file
        </button>
        <input
          ref={restoreRef} type="file" accept=".papyra-vault" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) void restore(f); e.target.value = ''; }}
        />
      </div>
      {restoreMsg && <p className="settings__msg">{restoreMsg}</p>}
    </>
  );
}

// ── API Keys ──────────────────────────────────────────────────────────────────────
interface ApiKeyRow { id: number; name: string; prefix: string; createdUtc: string; lastUsedUtc: string | null }

function KeysTab() {
  const queryClient = useQueryClient();
  const { data: keys, isLoading } = useQuery<ApiKeyRow[]>({
    queryKey: ['apiKeys'],
    queryFn: async () => {
      const res = await fetch('/api/keys');
      if (!res.ok) throw new Error(`GET /api/keys failed: ${res.status}`);
      return res.json();
    },
  });

  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null); // raw token, shown once
  const [copied, setCopied] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const data = await res.json();
      setCreated(data.token);
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['apiKeys'] });
    }
  }

  async function revoke(id: number) {
    if (!confirm('Revoke this key? Any integration using it will stop working.')) return;
    await fetch(`/api/keys/${id}`, { method: 'DELETE' });
    await queryClient.invalidateQueries({ queryKey: ['apiKeys'] });
  }

  async function copy() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ }
  }

  return (
    <div className="settings__panel">
      <h2 className="settings__subhead">Personal access tokens</h2>
      <p className="settings__hint">
        Send a token as <code>X-API-Key: &lt;token&gt;</code> (or <code>Authorization: Bearer &lt;token&gt;</code>)
        to reach the API from scripts and integrations. A token carries your own access only. It’s shown
        once — store it somewhere safe.
      </p>

      {created && (
        <div className="settings__token">
          <code className="settings__token-value">{created}</code>
          <button type="button" className="settings__btn" onClick={() => void copy()}>
            <Copy size={15} /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}

      <form className="settings__row" onSubmit={create}>
        <input
          className="settings__select"
          placeholder="Key name (e.g. CLI, backup script)"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <button type="submit" className="settings__btn"><KeyRound size={15} /> Generate key</button>
      </form>

      {isLoading && <p>Loading keys…</p>}
      {keys && keys.length > 0 && (
        <table className="settings__users">
          <thead>
            <tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th /></tr>
          </thead>
          <tbody>
            {keys.map(k => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td><code>{k.prefix}…</code></td>
                <td>{new Date(k.createdUtc).toLocaleDateString()}</td>
                <td>{k.lastUsedUtc ? new Date(k.lastUsedUtc).toLocaleDateString() : '—'}</td>
                <td>
                  <button type="button" className="settings__link" onClick={() => void revoke(k.id)}>
                    <Trash2 size={13} /> Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {keys && keys.length === 0 && <p className="settings__hint">No keys yet.</p>}
    </div>
  );
}

// ── About ────────────────────────────────────────────────────────────────────────
function AboutTab() {
  return (
    <div className="settings__panel settings__about">
      <h2 className="settings__subhead">Papyra</h2>
      <p className="settings__hint">A note-taking app you run yourself. Your notes stay as plain text files on your own server.</p>
      <dl className="settings__details">
        <div><dt>Version</dt><dd>{APP_VERSION}</dd></div>
        <div><dt>Notes stored as</dt><dd>Plain text files</dd></div>
        <div><dt>License</dt><dd>Open source</dd></div>
      </dl>
    </div>
  );
}

// ── Git Sync ─────────────────────────────────────────────────────────────────────
// Admin-only. The panel leads with the blast radius because the setting reads
// like a personal backup and is not one: the mirrored repo is the whole users/
// directory, so a sync publishes every tenant's vault to whatever remote is
// typed here. That warning previously existed only in the API docs, which is
// not where an admin is standing when they paste a URL.
function SyncTab() {
  const { data, isLoading, isError } = useGitConfig();
  const save = useSaveGitConfig();
  const run = useRunGitSync();

  // null means "not edited yet", so the field shows whatever the server holds
  // without an effect copying it into state (which would cascade a render on
  // every refetch). The token is never returned by the API, so it starts empty.
  const [remoteUrlEdit, setRemoteUrl] = useState<string | null>(null);
  const [branchEdit, setBranch] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);

  const remoteUrl = remoteUrlEdit ?? data?.remoteUrl ?? '';
  const branch = branchEdit ?? data?.branch ?? '';

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    save.mutate(
      { remoteUrl, branch, token: token.trim() === '' ? undefined : token },
      { onSuccess: () => { setToken(''); setSaved(true); } },
    );
  }

  if (isLoading) return <div className="settings__panel"><p className="settings__hint">Loading…</p></div>;
  if (isError) return <div className="settings__panel"><p className="settings__error">Couldn’t load the git configuration.</p></div>;

  return (
    <div className="settings__panel">
      <h2 className="settings__subhead">Git mirroring</h2>

      <div className="settings__callout" role="note">
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>This pushes every account’s notes, not just yours.</strong>
          <p>
            The mirrored repository is the whole vault directory, so a sync publishes
            all notes and media belonging to <em>every</em> user on this instance to the
            remote below. On a shared instance, treat that remote as having the same
            trust level as the server itself — anyone who can read it can read
            everyone’s notes.
          </p>
          <p>Papyra’s own state (<code>.papyra/</code>, <code>.trash/</code>) is excluded.</p>
        </div>
      </div>

      <form className="settings__form" onSubmit={submit}>
        <label className="settings__field">Remote URL
          <input
            type="url"
            value={remoteUrl}
            placeholder="https://github.com/you/papyra-vault.git"
            onChange={e => setRemoteUrl(e.target.value)}
          />
        </label>
        <label className="settings__field">Branch
          <input
            type="text"
            value={branch}
            placeholder="main"
            onChange={e => setBranch(e.target.value)}
          />
        </label>
        <label className="settings__field">
          Access token {data?.hasToken && <span className="settings__hint">(one is stored — leave blank to keep it)</span>}
          <input
            type="password"
            value={token}
            autoComplete="new-password"
            placeholder={data?.hasToken ? '••••••••' : 'Personal access token'}
            onChange={e => setToken(e.target.value)}
          />
        </label>

        <div className="settings__form-actions">
          <button type="submit" className="settings__btn" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save configuration'}
          </button>
          {saved && <span className="settings__msg"><CheckCircle2 size={15} /> Saved</span>}
          {save.isError && <span className="settings__error">Couldn’t save.</span>}
        </div>
      </form>

      <h2 className="settings__subhead">Run a sync</h2>
      <p className="settings__hint">
        Stages, commits and pushes every tenant’s vault. A diverged remote is never
        force-pushed — the sync stops and flags a conflict instead.
      </p>
      <div className="settings__row">
        <button
          type="button"
          className="settings__btn"
          disabled={run.isPending || !data?.remoteUrl}
          onClick={() => run.mutate()}
        >
          <RefreshCw size={16} /> {run.isPending ? 'Syncing…' : 'Sync now'}
        </button>
        {!data?.remoteUrl && <span className="settings__hint">Set a remote URL first.</span>}
        {run.data && (
          <span className="settings__msg">
            <CheckCircle2 size={15} /> {run.data.status}{run.data.detail ? ` — ${run.data.detail}` : ''}
          </span>
        )}
        {run.isError && <span className="settings__error">The sync failed to run.</span>}
      </div>

      <dl className="settings__details">
        <div><dt>Last sync</dt>
          <dd>{data?.lastSyncUtc ? new Date(data.lastSyncUtc).toLocaleString() : 'Never'}</dd></div>
        <div><dt>Status</dt>
          <dd>{data?.conflict ? 'Conflict — the remote has diverged' : 'OK'}</dd></div>
        {data?.lastError && <div><dt>Last error</dt><dd>{data.lastError}</dd></div>}
      </dl>
    </div>
  );
}

// ── Notifications (per user) ─────────────────────────────────────────────────────
// Opt-out switches for courtesy email. The in-app inbox is never affected: turning
// mention mail off stops the email, not the delivery — so the copy says so rather
// than letting someone think they'll stop being mentioned.
function NotificationsTab() {
  const { data, isLoading } = useNotificationPrefs();
  const save = useSaveNotificationPrefs();

  if (isLoading) return <div className="settings__panel"><p className="settings__hint">Loading…</p></div>;

  return (
    <div className="settings__panel">
      <h2 className="settings__subhead">Email notifications</h2>
      <p className="settings__hint">
        Papyra emails you when something needs your attention. These are courtesy copies —
        your in-app Inbox always receives everything regardless of what you choose here.
      </p>

      {!data?.emailConfigured && (
        <div className="settings__callout" role="note">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Email isn’t set up on this instance.</strong>
            <p>
              These preferences are saved, but nothing will be sent until an administrator
              configures an SMTP server under Settings → Email.
            </p>
          </div>
        </div>
      )}

      {data?.emailConfigured && !data.hasAddress && (
        <div className="settings__callout" role="note">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Your account has no email address.</strong>
            <p>Add one on the Profile tab to receive notifications.</p>
          </div>
        </div>
      )}

      <label className="settings__field settings__field--inline">
        <input
          type="checkbox"
          checked={data?.mention ?? true}
          onChange={e => save.mutate({ mention: e.target.checked })}
        />
        Someone @mentions me in a note
      </label>

      <label className="settings__field settings__field--inline">
        <input
          type="checkbox"
          checked={data?.share ?? true}
          onChange={e => save.mutate({ share: e.target.checked })}
        />
        Someone shares a note with me
      </label>

      <p className="settings__hint">
        Security email — a password reset, or confirmation that your password changed — is
        always sent and can’t be switched off.
      </p>
      {save.isError && <p className="settings__error">Couldn’t save that preference.</p>}
    </div>
  );
}

// ── SSO (admin) ──────────────────────────────────────────────────────────────────
// OIDC used to be configurable only through appsettings.json, which a self-hoster
// running the published container can't reach. Saving here takes effect immediately:
// the server evicts the cached auth options rather than waiting for a restart.
function SsoTab() {
  const { data, isLoading, isError } = useOidcConfig();
  const save = useSaveOidcConfig();

  const [enabledEdit, setEnabled] = useState<boolean | null>(null);
  const [authorityEdit, setAuthority] = useState<string | null>(null);
  const [clientIdEdit, setClientId] = useState<string | null>(null);
  const [displayNameEdit, setDisplayName] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [saved, setSaved] = useState(false);

  // null means "not edited yet", so the field shows the server's value without an
  // effect copying it into state on every refetch.
  const enabled = enabledEdit ?? data?.enabled ?? false;
  const authority = authorityEdit ?? data?.authority ?? '';
  const clientId = clientIdEdit ?? data?.clientId ?? '';
  const displayName = displayNameEdit ?? data?.displayName ?? '';

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    save.mutate(
      { enabled, authority, clientId, displayName, clientSecret: secret.trim() === '' ? undefined : secret },
      { onSuccess: () => { setSecret(''); setSaved(true); } },
    );
  }

  if (isLoading) return <div className="settings__panel"><p className="settings__hint">Loading…</p></div>;
  if (isError) return <div className="settings__panel"><p className="settings__error">Couldn’t load the SSO configuration.</p></div>;

  return (
    <div className="settings__panel">
      <h2 className="settings__subhead">Single sign-on (OIDC)</h2>
      <p className="settings__hint">
        Let people sign in with an existing identity provider. Papyra exchanges the provider’s
        identity for its own session, creating the account and its vault on first sign-in.
      </p>

      <div className="settings__callout" role="note">
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>Add this redirect URI to your provider.</strong>
          <p>
            Your provider must allow <code>{data?.redirectUri}</code> on this instance’s public
            address. A mismatch here is the most common cause of a failed SSO login.
          </p>
        </div>
      </div>

      <form className="settings__form" onSubmit={submit}>
        <label className="settings__field settings__field--inline">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          Enable SSO on the sign-in screen
        </label>

        <label className="settings__field">Authority (issuer URL)
          <input
            type="url" value={authority} placeholder="https://login.example.com"
            onChange={e => setAuthority(e.target.value)}
          />
        </label>
        <label className="settings__field">Client ID
          <input type="text" value={clientId} onChange={e => setClientId(e.target.value)} />
        </label>
        <label className="settings__field">
          Client secret {data?.hasClientSecret && <span className="settings__hint">(stored — leave blank to keep it)</span>}
          <input
            type="password" value={secret} autoComplete="new-password"
            placeholder={data?.hasClientSecret ? '••••••••' : 'Client secret'}
            onChange={e => setSecret(e.target.value)}
          />
        </label>
        <label className="settings__field">Button label
          <input
            type="text" value={displayName} placeholder="SSO"
            onChange={e => setDisplayName(e.target.value)}
          />
        </label>

        <div className="settings__form-actions">
          <button type="submit" className="settings__btn" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save SSO settings'}
          </button>
          {saved && <span className="settings__msg"><CheckCircle2 size={15} /> Saved — active immediately</span>}
          {save.isError && <span className="settings__error">{(save.error as Error).message}</span>}
        </div>
      </form>

      <dl className="settings__details">
        <div><dt>Status</dt><dd>{data?.ready ? 'Ready — the sign-in screen offers SSO' : 'Not active'}</dd></div>
      </dl>
    </div>
  );
}

// ── Email / SMTP (admin) ─────────────────────────────────────────────────────────
function EmailTab() {
  const { data, isLoading, isError } = useSmtpConfig();
  const save = useSaveSmtpConfig();
  const test = useSendTestEmail();
  const invite = useInviteUser();

  const [edits, setEdits] = useState<Partial<SmtpForm>>({});
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [inviteUser, setInviteUser] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('User');
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);

  const v = <K extends keyof SmtpForm>(key: K): SmtpForm[K] =>
    (edits[key] ?? (data as SmtpForm | undefined)?.[key] ?? SMTP_DEFAULTS[key]) as SmtpForm[K];
  const set = <K extends keyof SmtpForm>(key: K, value: SmtpForm[K]) =>
    setEdits(prev => ({ ...prev, [key]: value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    save.mutate(
      {
        enabled: v('enabled'), host: v('host'), port: v('port'), useSsl: v('useSsl'),
        username: v('username'), fromAddress: v('fromAddress'), fromName: v('fromName'),
        publicUrl: v('publicUrl'),
        password: password.trim() === '' ? undefined : password,
      },
      { onSuccess: () => { setPassword(''); setSaved(true); } },
    );
  }

  function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteMsg(null);
    invite.mutate(
      { username: inviteUser.trim(), email: inviteEmail.trim(), role: inviteRole },
      {
        onSuccess: () => { setInviteUser(''); setInviteEmail(''); setInviteMsg('Invitation sent.'); },
        onError: (err) => setInviteMsg((err as Error).message),
      },
    );
  }

  if (isLoading) return <div className="settings__panel"><p className="settings__hint">Loading…</p></div>;
  if (isError) return <div className="settings__panel"><p className="settings__error">Couldn’t load the email configuration.</p></div>;

  return (
    <div className="settings__panel">
      <h2 className="settings__subhead">Outbound email (SMTP)</h2>
      <p className="settings__hint">
        Used for password resets, invitations, and the notifications each person chooses on
        their own Notifications tab. Papyra sends plain-text messages only.
      </p>

      <form className="settings__form" onSubmit={submit}>
        <label className="settings__field settings__field--inline">
          <input type="checkbox" checked={v('enabled')} onChange={e => set('enabled', e.target.checked)} />
          Enable outbound email
        </label>

        <label className="settings__field">SMTP host
          <input type="text" value={v('host')} placeholder="smtp.example.com"
            onChange={e => set('host', e.target.value)} />
        </label>
        <label className="settings__field">Port
          <input type="number" min={1} max={65535} value={v('port')}
            onChange={e => set('port', Number(e.target.value))} />
        </label>
        <label className="settings__field settings__field--inline">
          <input type="checkbox" checked={v('useSsl')} onChange={e => set('useSsl', e.target.checked)} />
          Use TLS/SSL
        </label>
        <label className="settings__field">Username <span className="settings__hint">(blank for an unauthenticated relay)</span>
          <input type="text" value={v('username')} onChange={e => set('username', e.target.value)} />
        </label>
        <label className="settings__field">
          Password {data?.hasPassword && <span className="settings__hint">(stored — leave blank to keep it)</span>}
          <input type="password" value={password} autoComplete="new-password"
            placeholder={data?.hasPassword ? '••••••••' : 'SMTP password'}
            onChange={e => setPassword(e.target.value)} />
        </label>
        <label className="settings__field">From address
          <input type="email" value={v('fromAddress')} placeholder="papyra@example.com"
            onChange={e => set('fromAddress', e.target.value)} />
        </label>
        <label className="settings__field">From name
          <input type="text" value={v('fromName')} placeholder="Papyra"
            onChange={e => set('fromName', e.target.value)} />
        </label>
        <label className="settings__field">Public URL <span className="settings__hint">(used for links in emails)</span>
          <input type="url" value={v('publicUrl')} placeholder="https://notes.example.com"
            onChange={e => set('publicUrl', e.target.value)} />
        </label>

        <div className="settings__form-actions">
          <button type="submit" className="settings__btn" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save email settings'}
          </button>
          {saved && <span className="settings__msg"><CheckCircle2 size={15} /> Saved</span>}
          {save.isError && <span className="settings__error">{(save.error as Error).message}</span>}
        </div>
      </form>

      <h2 className="settings__subhead">Send a test</h2>
      <p className="settings__hint">
        Prove the settings work before anyone’s password reset depends on them. Save first —
        the test uses the stored configuration.
      </p>
      <div className="settings__row">
        <input
          type="email" className="settings__test-input" value={testTo}
          placeholder="Leave blank to use your own address"
          onChange={e => setTestTo(e.target.value)}
        />
        <button
          type="button" className="settings__btn"
          disabled={test.isPending}
          onClick={() => test.mutate(testTo)}
        >
          <Send size={16} /> {test.isPending ? 'Sending…' : 'Send test email'}
        </button>
        {test.isSuccess && <span className="settings__msg"><CheckCircle2 size={15} /> Sent to {test.data}</span>}
        {test.isError && <span className="settings__error">{(test.error as Error).message}</span>}
      </div>

      <h2 className="settings__subhead">Invite someone</h2>
      <p className="settings__hint">
        Sends a one-time link instead of you choosing a password for them. The account is
        created only when they set their own; the link expires in 7 days.
      </p>
      <form className="settings__form" onSubmit={sendInvite}>
        <label className="settings__field">Username
          <input type="text" value={inviteUser} onChange={e => setInviteUser(e.target.value)} />
        </label>
        <label className="settings__field">Email address
          <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} />
        </label>
        <label className="settings__field">Role
          <select className="settings__select" value={inviteRole} onChange={e => setInviteRole(e.target.value)}>
            <option value="User">User</option>
            <option value="Admin">Admin</option>
          </select>
        </label>
        <div className="settings__form-actions">
          <button type="submit" className="settings__btn" disabled={invite.isPending}>
            <UserPlus size={16} /> {invite.isPending ? 'Sending…' : 'Send invitation'}
          </button>
          {inviteMsg && <span className="settings__msg">{inviteMsg}</span>}
        </div>
      </form>
    </div>
  );
}

interface SmtpForm {
  enabled: boolean; host: string; port: number; useSsl: boolean;
  username: string; fromAddress: string; fromName: string; publicUrl: string;
}

const SMTP_DEFAULTS: SmtpForm = {
  enabled: false, host: '', port: 587, useSsl: true,
  username: '', fromAddress: '', fromName: '', publicUrl: '',
};

// ── AI assistant (admin) ─────────────────────────────────────────────────────────
// Two audiences share this panel, so it's ordered for the common one. Almost
// everybody wants a model on their own machine and nothing else: that's the top
// half, three cards, one click, no jargon and no model names. The small minority
// who want to spend money at OpenAI or Anthropic get the bottom half, folded away.
//
// Keys are write-only: blank means "keep the stored one", same as SSO and Email.
function AiTab() {
  const { data, isLoading, isError } = useAiConfig();
  const { data: status, refetch: refetchStatus } = useAiStatus();
  const { data: choices } = useAiModels();
  const save = useSaveAiConfig();

  const [edits, setEdits] = useState<Partial<AiConfig>>({});
  const [openAiKey, setOpenAiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [showCloud, setShowCloud] = useState(false);
  const [pulling, setPulling] = useState<string | null>(null);
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);

  const pull = usePullModel(setProgress);

  // null/undefined means "not edited yet", so a field shows the server's value
  // without an effect copying it into state on every refetch.
  const v = <K extends keyof AiConfig>(key: K): AiConfig[K] =>
    (edits[key] ?? data?.[key] ?? AI_DEFAULTS[key]) as AiConfig[K];
  const set = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) =>
    setEdits(e => ({ ...e, [key]: value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    save.mutate({
      chatProvider: v('chatProvider'),
      embedProvider: v('embedProvider'),
      ollamaBaseUrl: v('ollamaBaseUrl'),
      ollamaChatModel: v('ollamaChatModel'),
      ollamaEmbedModel: v('ollamaEmbedModel'),
      openAiBaseUrl: v('openAiBaseUrl'),
      openAiChatModel: v('openAiChatModel'),
      openAiEmbedModel: v('openAiEmbedModel'),
      anthropicChatModel: v('anthropicChatModel'),
      openAiKey: openAiKey.trim() === '' ? undefined : openAiKey,
      anthropicKey: anthropicKey.trim() === '' ? undefined : anthropicKey,
    }, {
      onSuccess: () => { setOpenAiKey(''); setAnthropicKey(''); setSaved(true); },
    });
  }

  function install(model: string) {
    setPulling(model);
    setProgress(null);
    setPullError(null);
    pull.mutate(model, {
      onError: (e) => setPullError((e as Error).message),
      onSettled: () => { setPulling(null); setProgress(null); void refetchStatus(); },
    });
  }

  if (isLoading) return <div className="settings__panel"><p className="settings__hint">Loading…</p></div>;
  if (isError) return <div className="settings__panel"><p className="settings__error">Couldn’t load the assistant settings.</p></div>;

  const usingCloud = v('chatProvider') !== 'ollama';
  const installed = status?.installedModels ?? [];
  const activeModel = status?.chatModel;
  // Ollama reports "llama3.1:8b"; a bare name means the default tag.
  const isInstalled = (m: string) =>
    installed.some(i => i === m || i === `${m}:latest` || i.split(':')[0] === m.split(':')[0]);

  return (
    <div className="settings__panel">
      <h2 className="settings__subhead">Assistant</h2>
      <p className="settings__hint">
        Ask questions about your own notes and get an answer that cites them. Notes you’ve
        locked are never included.
      </p>

      <dl className="settings__details">
        <div>
          <dt>Status</dt>
          <dd>{status?.ready ? 'Ready' : (status?.reason ?? 'Not set up yet')}</dd>
        </div>
      </dl>

      {/* ── On this machine ──────────────────────────────────────────────── */}
      <h3 className="settings__subhead">On this machine</h3>
      <p className="settings__hint">
        Download one of these and the assistant runs entirely on your own server — your
        notes never leave it, and there’s nothing to pay for. Pick the largest one your
        machine can handle; you can change it later.
      </p>

      {status && !status.canPull && (
        <div className="settings__callout" role="note">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>The model engine isn’t running.</strong>
            <p>
              Papyra couldn’t reach it, so downloads are unavailable right now. If you
              started Papyra with Docker, run <code>docker compose up -d</code> again to
              bring it up.
            </p>
          </div>
        </div>
      )}

      <ul className="settings__models">
        {(choices ?? []).map(c => {
          const here = isInstalled(c.model);
          const active = here && activeModel === c.model;
          const busy = pulling === c.model;
          return (
            <li key={c.model} className={`settings__model${active ? ' is-active' : ''}`}>
              <div className="settings__model-head">
                <span className="settings__model-tier">{c.tier}</span>
                {active
                  ? <span className="settings__model-badge">In use</span>
                  : here && <span className="settings__model-badge">Downloaded</span>}
              </div>
              <p className="settings__model-blurb">{c.blurb}</p>
              <dl className="settings__model-specs">
                <div><dt>Size</dt><dd>{c.size}</dd></div>
                <div><dt>Memory needed</dt><dd>{c.memory}</dd></div>
              </dl>
              <button
                type="button"
                className="settings__btn"
                disabled={active || pulling !== null || !status?.canPull}
                onClick={() => install(c.model)}
              >
                {active ? 'In use'
                  : busy ? 'Downloading…'
                  : here ? 'Use this one'
                  : 'Download'}
              </button>

              {busy && (
                <div className="settings__model-progress" role="status">
                  <div
                    className="settings__model-bar"
                    style={{ '--pct': `${progress && progress.total > 0
                      ? Math.round((progress.completed / progress.total) * 100) : 0}%` } as React.CSSProperties}
                  />
                  <span>
                    {progress?.phase === 'search'
                      ? 'Setting up search…'
                      : progress && progress.total > 0
                        ? `${Math.round((progress.completed / progress.total) * 100)}% downloaded`
                        : 'Starting…'}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {pullError && <p className="settings__error">{pullError}</p>}
      {pulling && (
        <p className="settings__hint">
          This can take a while on a slow connection. You can leave this page — the
          download keeps going.
        </p>
      )}

      {/* ── Or use a paid service ────────────────────────────────────────── */}
      <h3 className="settings__subhead">Or use a paid service</h3>
      <p className="settings__hint">
        Faster and more accurate, but the parts of your notes needed to answer each
        question are sent to that company, and they charge you for it.
      </p>

      {!showCloud && !usingCloud ? (
        <button type="button" className="settings__btn settings__btn--ghost" onClick={() => setShowCloud(true)}>
          Set up OpenAI or Anthropic
        </button>
      ) : (
        <form className="settings__form" onSubmit={submit}>
          <label className="settings__field">Answer with
            <select value={v('chatProvider')} onChange={e => set('chatProvider', e.target.value)}>
              <option value="ollama">The model on this machine</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>

          {usingCloud && (
            <div className="settings__callout" role="note">
              <AlertTriangle size={18} aria-hidden="true" />
              <div>
                <strong>Your notes will leave this machine.</strong>
                <p>
                  To answer a question, Papyra sends the relevant parts of your notes to{' '}
                  {v('chatProvider') === 'openai' ? 'OpenAI' : 'Anthropic'}. Switch back to
                  the model on this machine to keep everything local.
                </p>
              </div>
            </div>
          )}

          <label className="settings__field">
            OpenAI key {data?.hasOpenAiKey && <span className="settings__hint">(saved — leave blank to keep it)</span>}
            <input type="password" value={openAiKey} autoComplete="new-password"
              placeholder={data?.hasOpenAiKey ? '••••••••' : 'Paste your key'}
              onChange={e => setOpenAiKey(e.target.value)} />
          </label>
          <label className="settings__field">OpenAI model
            <input type="text" value={v('openAiChatModel')} placeholder="gpt-4o"
              onChange={e => set('openAiChatModel', e.target.value)} />
          </label>

          <label className="settings__field">
            Anthropic key {data?.hasAnthropicKey && <span className="settings__hint">(saved — leave blank to keep it)</span>}
            <input type="password" value={anthropicKey} autoComplete="new-password"
              placeholder={data?.hasAnthropicKey ? '••••••••' : 'Paste your key'}
              onChange={e => setAnthropicKey(e.target.value)} />
          </label>
          <label className="settings__field">Anthropic model
            <input type="text" value={v('anthropicChatModel')} placeholder="claude-opus-5"
              onChange={e => set('anthropicChatModel', e.target.value)} />
          </label>

          <details className="settings__advanced">
            <summary>Advanced</summary>
            <label className="settings__field">Search index built by
              <select value={v('embedProvider')} onChange={e => set('embedProvider', e.target.value)}>
                <option value="ollama">The model on this machine</option>
                <option value="openai">OpenAI</option>
              </select>
              <span className="settings__hint">
                Anthropic can’t do this part, so search always uses one of the other two.
              </span>
            </label>
            <label className="settings__field">Model engine address
              <input type="url" value={v('ollamaBaseUrl')} placeholder="http://localhost:11434"
                onChange={e => set('ollamaBaseUrl', e.target.value)} />
            </label>
            <label className="settings__field">OpenAI address
              <input type="url" value={v('openAiBaseUrl')} placeholder="https://api.openai.com/v1"
                onChange={e => set('openAiBaseUrl', e.target.value)} />
              <span className="settings__hint">Change this to use a compatible service.</span>
            </label>
          </details>

          <div className="settings__form-actions">
            <button type="submit" className="settings__btn" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="settings__msg"><CheckCircle2 size={15} /> Saved</span>}
            {save.isError && <span className="settings__error">{(save.error as Error).message}</span>}
          </div>
        </form>
      )}
    </div>
  );
}

const AI_DEFAULTS: AiConfig = {
  chatProvider: 'ollama', embedProvider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaChatModel: 'mistral-nemo:12b', ollamaEmbedModel: 'nomic-embed-text',
  openAiBaseUrl: 'https://api.openai.com/v1',
  openAiChatModel: 'gpt-4o', openAiEmbedModel: 'text-embedding-3-small',
  anthropicChatModel: 'claude-opus-5',
  hasOpenAiKey: false, hasAnthropicKey: false,
};

// ── Admin ────────────────────────────────────────────────────────────────────────
interface ManagedUser { id: number; username: string; name: string; email: string; role: string }

function AdminTab() {
  const queryClient = useQueryClient();
  const { data: users, isLoading, isError } = useQuery<ManagedUser[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await fetch('/api/auth/users');
      if (!res.ok) throw new Error(`GET /api/auth/users failed: ${res.status}`);
      return res.json();
    },
  });

  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('User');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function provision(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, name, email, password, role }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? 'Could not provision user.');
        return;
      }
      setUsername(''); setName(''); setEmail(''); setPassword(''); setRole('User');
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    } catch {
      setError('Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function reset(id: number, label: string) {
    const nextPw = window.prompt(`New password for ${label}:`);
    if (!nextPw) return;
    const res = await fetch(`/api/auth/users/${id}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: nextPw }),
    });
    if (!res.ok) window.alert('Password reset failed.');
  }

  async function remove(id: number, label: string) {
    if (!confirm(`Delete user “${label}”? Their account, API keys and shares are removed. Their note files stay on disk.`)) return;
    const res = await fetch(`/api/auth/users/${id}`, { method: 'DELETE' });
    if (res.ok) await queryClient.invalidateQueries({ queryKey: ['users'] });
    else {
      const data = await res.json().catch(() => null);
      window.alert(data?.error ?? 'Delete failed.');
    }
  }

  return (
    <div className="settings__panel">
      <form className="settings__provision" onSubmit={provision}>
        <h2 className="settings__subhead">Provision user</h2>
        {error && <p className="settings__error" role="alert">{error}</p>}
        <div className="settings__provision-row">
          <input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} required />
          <input placeholder="Display name" value={name} onChange={e => setName(e.target.value)} />
          <input placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
          <input placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} required />
          <select value={role} onChange={e => setRole(e.target.value)} aria-label="Role">
            <option value="User">User</option>
            <option value="Admin">Admin</option>
          </select>
          <button type="submit" className="settings__btn" disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
        </div>
      </form>

      <h2 className="settings__subhead">Users</h2>
      {isLoading && <p>Loading users…</p>}
      {isError && <p>Couldn’t load users.</p>}
      {users && (
        <table className="settings__users">
          <thead>
            <tr><th>Username</th><th>Name</th><th>Email</th><th>Role</th><th /></tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.name}</td>
                <td>{u.email || '—'}</td>
                <td>{u.role}</td>
                <td>
                  <button type="button" className="settings__link" onClick={() => void reset(u.id, u.username)}>
                    Reset password
                  </button>
                  <button type="button" className="settings__link settings__link--danger" onClick={() => void remove(u.id, u.username)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
