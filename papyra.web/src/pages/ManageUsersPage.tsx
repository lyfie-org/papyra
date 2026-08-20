import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, KeyRound, Link2, Trash2, Copy, ShieldAlert } from 'lucide-react';
import EmptyState from '../components/EmptyState';
import Avatar from '../components/Avatar';
import { useAuth } from '../hooks/useAuth';
import { useConfirm } from '../lib/confirmContext';
import { useToast } from '../lib/toastContext';
import './ManageUsersPage.css';

// Accounts on this instance. Split out of Settings because managing other people
// is not a preference: everything under Settings changes what happens to *you*,
// and mixing "who can sign in" into that list made an admin's own preferences and
// the whole instance's roster look like the same kind of thing.
export interface ManagedUser {
  id: number;
  username: string;
  name: string;
  email: string;
  role: string;
  mustChangePassword: boolean;
}

/** Sign-in details the server will hand back exactly once. */
interface Credentials {
  username: string;
  password?: string;
  link?: string;
  emailed: boolean;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  return (data as { error?: string } | null)?.error ?? fallback;
}

export default function ManageUsersPage() {
  const { user: me } = useAuth();
  const confirm = useConfirm();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);

  const { data: users, isLoading, isError } = useQuery<ManagedUser[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await fetch('/api/auth/users');
      if (!res.ok) throw new Error(`GET /api/auth/users failed: ${res.status}`);
      return res.json();
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  async function resetPassword(target: ManagedUser) {
    if (!(await confirm({
      title: `Reset the password for ${target.username}?`,
      body: 'A new password is generated and shown to you once. They keep their notes, and are asked to choose their own password the next time they sign in.',
      confirmLabel: 'Reset password',
    }))) return;

    const res = await fetch(`/api/auth/users/${target.id}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: null, sendEmail: Boolean(target.email) }),
    });
    if (!res.ok) { toast(await readError(res, 'Couldn’t reset that password.')); return; }

    const body = await res.json() as { password: string; emailed: boolean };
    setCredentials({ username: target.username, password: body.password, emailed: body.emailed });
    await refresh();
  }

  async function recoveryLink(target: ManagedUser) {
    const res = await fetch(`/api/auth/users/${target.id}/recovery-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sendEmail: Boolean(target.email) }),
    });
    if (!res.ok) { toast(await readError(res, 'Couldn’t create a recovery link.')); return; }

    const body = await res.json() as { link: string; emailed: boolean };
    setCredentials({ username: target.username, link: body.link, emailed: body.emailed });
  }

  async function remove(target: ManagedUser) {
    if (!(await confirm({
      title: `Delete ${target.username}?`,
      body: 'Their account, API keys and shares are removed and they can no longer sign in. Their note files stay on the server’s disk.',
      confirmLabel: 'Delete user',
      destructive: true,
    }))) return;

    const res = await fetch(`/api/auth/users/${target.id}`, { method: 'DELETE' });
    if (res.ok) await refresh();
    else toast(await readError(res, 'Couldn’t delete that user.'));
  }

  return (
    <section className="users-page">
      <header className="users-page__head">
        <h1 className="page-title users-page__title">Manage Users</h1>
        <button type="button" className="users-page__new" onClick={() => setAdding(true)}>
          <UserPlus size={18} /> Add someone
        </button>
      </header>
      <p className="users-page__hint">
        Everyone who can sign in to this Papyra. Each person gets their own notes —
        an admin can create and remove accounts, but cannot read anyone else’s notes.
      </p>

      {isLoading && <p className="users-page__status">Loading…</p>}
      {isError && <p className="users-page__status">Couldn’t load the list of accounts.</p>}

      {users && users.length === 0 && (
        <EmptyState
          icon={UserPlus}
          title="Nobody else has an account yet"
          body="Papyra can hold a whole household or team, each person with their own private notes on the same server."
          hint="Add someone and hand them the password it gives you — they’ll pick their own the first time they sign in."
          action={{ label: 'Add someone', onClick: () => setAdding(true) }}
        />
      )}

      {users && users.length > 0 && (
        <table className="users-table">
          <thead>
            <tr><th>Username</th><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td>
                  <span className="users-table__who">
                    <Avatar username={u.username} name={u.name} size={26} />
                    {u.username}{u.id === me?.id && <span className="users-table__you"> (you)</span>}
                  </span>
                </td>
                <td>{u.name}</td>
                <td>{u.email || '—'}</td>
                <td>{u.role}</td>
                <td>
                  {u.mustChangePassword
                    ? <span className="users-table__flag"><ShieldAlert size={14} aria-hidden="true" /> Hasn’t set their own password</span>
                    : <span className="users-table__ok">Active</span>}
                </td>
                <td className="users-table__actions">
                  <button type="button" className="users-table__link" onClick={() => void resetPassword(u)}>
                    <KeyRound size={14} aria-hidden="true" /> Reset password
                  </button>
                  <button type="button" className="users-table__link" onClick={() => void recoveryLink(u)}>
                    <Link2 size={14} aria-hidden="true" /> Recovery link
                  </button>
                  {u.id !== me?.id && (
                    <button type="button" className="users-table__link users-table__link--danger" onClick={() => void remove(u)}>
                      <Trash2 size={14} aria-hidden="true" /> Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && (
        <AddUserDialog
          onClose={() => setAdding(false)}
          onCreated={async (created) => { setAdding(false); setCredentials(created); await refresh(); }}
        />
      )}

      {credentials && (
        <CredentialsDialog credentials={credentials} onClose={() => setCredentials(null)} />
      )}
    </section>
  );
}

// ── Add someone ───────────────────────────────────────────────────────────────
// Password is optional: left blank the server generates one, which is the path
// worth encouraging — an admin inventing passwords for other people tends to
// invent one they can guess.
function AddUserDialog({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (credentials: Credentials) => void | Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState('User');
  const [sendEmail, setSendEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password && password !== confirmPassword) {
      setError('The two passwords don’t match.');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username, name, email, role, sendEmail,
          // Blank means "generate one" — don't send an empty string.
          password: password || null,
        }),
      });
      if (!res.ok) { setError(await readError(res, 'Couldn’t create that account.')); return; }
      const body = await res.json() as { username: string; password: string; emailed: boolean };
      await onCreated({ username: body.username, password: body.password, emailed: body.emailed });
    } catch {
      setError('Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="users-dialog__scrim" role="presentation" onMouseDown={onClose}>
      <div
        className="users-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-user-title"
        onMouseDown={e => e.stopPropagation()}
      >
        <h2 id="add-user-title" className="users-dialog__title">Add someone</h2>
        <form className="users-dialog__form" onSubmit={submit}>
          {error && <p className="users-dialog__error" role="alert">{error}</p>}

          <label className="users-dialog__field">Username
            <input value={username} onChange={e => setUsername(e.target.value)} required autoFocus />
          </label>
          <label className="users-dialog__field">Display name
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Optional" />
          </label>
          <label className="users-dialog__field">Email
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Optional" />
          </label>

          <label className="users-dialog__field">First password
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Leave blank to generate one"
              autoComplete="new-password"
            />
          </label>
          {password && (
            <label className="users-dialog__field">Repeat the password
              <input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
          )}

          <label className="users-dialog__field">Role
            <select value={role} onChange={e => setRole(e.target.value)}>
              <option value="User">User — their own notes</option>
              <option value="Admin">Admin — can also manage accounts and instance settings</option>
            </select>
          </label>

          <label className="users-dialog__check">
            <input
              type="checkbox"
              checked={sendEmail}
              onChange={e => setSendEmail(e.target.checked)}
              disabled={!email}
            />
            Email them their sign-in details{!email && ' (add an email address first)'}
          </label>

          <p className="users-dialog__note">
            Whichever password is used, they’re asked to choose their own the first
            time they sign in — until then it’s a password somebody else knows.
          </p>

          <div className="users-dialog__actions">
            <button type="button" className="users-dialog__btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="users-dialog__btn users-dialog__btn--primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Shown once ────────────────────────────────────────────────────────────────
// The server never stores the password in the clear, so this panel is the only
// chance to read it. Say so plainly rather than letting an admin close it and
// discover that later.
function CredentialsDialog({ credentials, onClose }: { credentials: Credentials; onClose: () => void }) {
  const { toast } = useToast();
  const secret = credentials.password ?? credentials.link ?? '';

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      toast('Copied.');
    } catch {
      toast('Couldn’t copy — select the text instead.');
    }
  }

  return (
    <div className="users-dialog__scrim" role="presentation" onMouseDown={onClose}>
      <div
        className="users-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="credentials-title"
        onMouseDown={e => e.stopPropagation()}
      >
        <h2 id="credentials-title" className="users-dialog__title">
          {credentials.password ? `Password for ${credentials.username}` : `Recovery link for ${credentials.username}`}
        </h2>
        <p className="users-dialog__note">
          {credentials.emailed
            ? 'Sent to their email address. Here it is as well, in case it doesn’t arrive.'
            : 'Copy this now — it can’t be shown again.'}
          {credentials.link && ' The link works once and expires in an hour.'}
        </p>

        <p className="users-dialog__secret">{secret}</p>

        <div className="users-dialog__actions">
          <button type="button" className="users-dialog__btn" onClick={() => void copy()}>
            <Copy size={15} aria-hidden="true" /> Copy
          </button>
          <button type="button" className="users-dialog__btn users-dialog__btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
