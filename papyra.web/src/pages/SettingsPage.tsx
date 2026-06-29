import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  User as UserIcon, Palette, Database, Shield, Info, Camera,
  Sun, Moon, Monitor, Upload, Download, RefreshCw, KeyRound, Copy, Trash2, Lock, ShieldAlert,
} from 'lucide-react';
import { useAuth, type AuthUser } from '../hooks/useAuth';
import { useNotes } from '../hooks/useNotes';
import { useCategories } from '../hooks/useCategories';
import { useTheme, type ThemePreference } from '../hooks/useTheme';
import { useSettings, useUpdateSettings, RETENTION_OPTIONS } from '../hooks/useSettings';
import './SettingsPage.css';

const APP_VERSION = '0.0.1';

type Tab = 'profile' | 'appearance' | 'data' | 'keys' | 'admin' | 'about';

const NAV: { id: Tab; label: string; icon: typeof UserIcon; adminOnly?: boolean }[] = [
  { id: 'profile', label: 'Profile', icon: UserIcon },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'data', label: 'Data & Storage', icon: Database },
  { id: 'keys', label: 'API Keys', icon: KeyRound },
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
          {tab === 'data' && <DataTab />}
          {tab === 'keys' && <KeysTab />}
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
