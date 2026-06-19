import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth, type AuthUser } from '../hooks/useAuth';
import { useNotes } from '../hooks/useNotes';
import { useSettings, useUpdateSettings, RETENTION_OPTIONS } from '../hooks/useSettings';
import './SettingsPage.css';

type Tab = 'profile' | 'trash' | 'admin';

export default function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  // The avatar dropdown deep-links to a tab via ?tab=…; keep it in the URL so the
  // active tab survives a refresh / back.
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: Tab = requested === 'admin' && isAdmin ? 'admin'
    : requested === 'trash' ? 'trash' : 'profile';
  const setTab = (t: Tab) => setParams(t === 'profile' ? {} : { tab: t }, { replace: true });

  return (
    <section className="settings">
      <h1 className="settings__title">Settings</h1>

      <div className="settings__tabs" role="tablist">
        <button
          type="button" role="tab" aria-selected={tab === 'profile'}
          className={`settings__tab${tab === 'profile' ? ' settings__tab--active' : ''}`}
          onClick={() => setTab('profile')}
        >
          Profile
        </button>
        <button
          type="button" role="tab" aria-selected={tab === 'trash'}
          className={`settings__tab${tab === 'trash' ? ' settings__tab--active' : ''}`}
          onClick={() => setTab('trash')}
        >
          Trash
        </button>
        {isAdmin && (
          <button
            type="button" role="tab" aria-selected={tab === 'admin'}
            className={`settings__tab${tab === 'admin' ? ' settings__tab--active' : ''}`}
            onClick={() => setTab('admin')}
          >
            Admin
          </button>
        )}
      </div>

      {tab === 'profile' && <ProfileTab user={user} />}
      {tab === 'trash' && <TrashTab />}
      {tab === 'admin' && isAdmin && <AdminTab />}
    </section>
  );
}

function TrashTab() {
  const { data: settings, isLoading } = useSettings();
  const update = useUpdateSettings();

  return (
    <div className="settings__panel">
      <h2 className="settings__subhead">Trash auto-delete</h2>
      <p className="settings__hint">
        How long deleted notes stay in Trash before they’re permanently removed.
        “Delete immediately” skips Trash — those deletes can’t be recovered.
      </p>
      <label className="settings__field">
        Permanently delete trashed notes
        <select
          className="settings__select"
          disabled={isLoading || update.isPending}
          value={settings?.trashRetentionDays ?? 30}
          onChange={(e) => update.mutate({ trashRetentionDays: Number(e.target.value) })}
        >
          {RETENTION_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      {update.isError && <p className="settings__error">Couldn’t save the setting.</p>}
    </div>
  );
}

function ProfileTab({ user }: { user: AuthUser | null }) {
  const { data: notes } = useNotes();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Stats derived from the cached vault mirror (the SQLite/in-memory cache the API
  // serves), never the disk — counts only.
  const noteCount = notes?.length ?? 0;
  const tagCount = new Set((notes ?? []).flatMap(n => n.tags ?? [])).size;

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    await queryClient.invalidateQueries({ queryKey: ['auth'] });
    navigate('/login', { replace: true });
  }

  return (
    <div className="settings__panel">
      <dl className="settings__details">
        <div><dt>Name</dt><dd>{user?.name || '—'}</dd></div>
        <div><dt>Username</dt><dd>{user?.username || '—'}</dd></div>
        <div><dt>Email</dt><dd>{user?.email || '—'}</dd></div>
        <div><dt>Role</dt><dd>{user?.role || '—'}</dd></div>
      </dl>

      <div className="settings__stats">
        <div className="settings__stat"><span className="settings__stat-num">{noteCount}</span> notes</div>
        <div className="settings__stat"><span className="settings__stat-num">{tagCount}</span> tags</div>
      </div>

      <button type="button" className="settings__danger" onClick={() => void logout()}>
        Sign out
      </button>
    </div>
  );
}

interface ManagedUser {
  id: number;
  username: string;
  name: string;
  email: string;
  role: string;
}

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
    const next = window.prompt(`New password for ${label}:`);
    if (!next) return;
    const res = await fetch(`/api/auth/users/${id}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: next }),
    });
    if (!res.ok) window.alert('Password reset failed.');
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
          <button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
