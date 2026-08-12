import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  User as UserIcon, Palette, Database, Shield, Info, Camera,
  Sun, Moon, Monitor, Upload, Download, RefreshCw, KeyRound, Copy, Trash2, Lock, ShieldAlert,
  Fingerprint, CheckCircle2, GitBranch, AlertTriangle,
} from 'lucide-react';
import { useGitConfig, useSaveGitConfig, useRunGitSync } from '../hooks/useGitSync';
import { useWebAuthnDevices } from '../hooks/useWebAuthnDevices';
import { hasPlatformAuthenticator, isWebAuthnAvailable } from '../lib/webauthn';
import { useAuth, type AuthUser } from '../hooks/useAuth';
import { useNotes } from '../hooks/useNotes';
import { useCategories } from '../hooks/useCategories';
import { useTheme, type ThemePreference } from '../hooks/useTheme';
import { useSettings, useUpdateSettings, RETENTION_OPTIONS } from '../hooks/useSettings';
import './SettingsPage.css';

const APP_VERSION = '0.0.1';

type Tab = 'profile' | 'appearance' | 'security' | 'data' | 'keys' | 'sync' | 'admin' | 'about';

const NAV: { id: Tab; label: string; icon: typeof UserIcon; adminOnly?: boolean }[] = [
  { id: 'profile', label: 'Profile', icon: UserIcon },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'security', label: 'Security', icon: Fingerprint },
  { id: 'data', label: 'Data & Storage', icon: Database },
  { id: 'keys', label: 'API Keys', icon: KeyRound },
  { id: 'sync', label: 'Git Sync', icon: GitBranch, adminOnly: true },
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
      <h1 className="settings__title">Settings</h1>
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
          {tab === 'security' && <SecurityTab />}
          {tab === 'data' && <DataTab />}
          {tab === 'keys' && <KeysTab />}
          {tab === 'sync' && isAdmin && <SyncTab />}
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
      <p className="settings__hint">Download every note as a zip of plain markdown files.</p>
      <a className="settings__btn" href="/api/export">
        <Download size={16} /> Export all notes
      </a>

      <EncryptedBackupSection />

      <h2 className="settings__subhead">Maintenance</h2>
      <p className="settings__hint">Rebuild the search index from the markdown files (the source of truth).</p>
      <button type="button" className="settings__btn" onClick={() => void rebuild()}>
        <RefreshCw size={16} /> Rebuild search index
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
      <p className="settings__hint">A self-hosted, file-first note-taking app. Your notes are plain markdown on disk.</p>
      <dl className="settings__details">
        <div><dt>Version</dt><dd>{APP_VERSION}</dd></div>
        <div><dt>Storage</dt><dd>Markdown + YAML frontmatter</dd></div>
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
