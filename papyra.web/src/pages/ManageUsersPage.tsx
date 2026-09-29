import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UserPlus, KeyRound, Link2, Trash2, Copy, ShieldAlert, MoreHorizontal, Ban, CircleCheck, Clock,
  RotateCcw, Smartphone,
} from 'lucide-react';
import EmptyState from '../components/EmptyState';
import Avatar from '../components/Avatar';
import { useAuth } from '../hooks/useAuth';
import { useConfirm } from '../lib/confirmContext';
import { useToast } from '../lib/toastContext';
import './ManageUsersPage.css';
import '../components/CardMenu.css';
import LoadingBar from '../components/LoadingBar';
import { MASKED_SECRET, NO_AUTOFILL } from '../lib/autofill';

// Accounts on this instance — Settings → Users, shown to admins only. It sits in
// Settings' "Administration" group, apart from the preferences above it, so an
// admin's own choices and the instance's roster don't read as the same thing.
export interface ManagedUser {
  id: number;
  username: string;
  name: string;
  email: string;
  role: 'Admin' | 'User' | string;
  mustChangePassword: boolean;
  disabled: boolean;
  disabledUtc: string | null;
  disabledReason: string | null;
  lastSignInUtc: string | null;
  sso: boolean;
  totpEnabled?: boolean;
  deletionScheduledUtc: string | null;
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

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 days ago", "yesterday", "just now". */
function ago(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export default function UsersPanel() {
  const { user: me } = useAuth();
  const confirm = useConfirm();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [disabling, setDisabling] = useState<ManagedUser | null>(null);

  const { data: users, isLoading, isError } = useQuery<ManagedUser[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await fetch('/api/auth/users');
      if (!res.ok) throw new Error(`GET /api/auth/users failed: ${res.status}`);
      return res.json();
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });
  const activeAdmins = users?.filter(u => u.role === 'Admin' && !u.disabled).length ?? 0;

  async function changeRole(target: ManagedUser, role: string) {
    const promote = role === 'Admin';
    if (!(await confirm({
      title: promote ? `Make ${target.username} an admin?` : `Make ${target.username} a regular user?`,
      body: promote
        ? 'They’ll be able to add, disable and remove accounts, and change this server’s settings (email, sign-on, jobs). Admins still can’t read anyone else’s notes.'
        : 'They keep all their notes, and lose access to the Administration settings on their next click.',
      confirmLabel: promote ? 'Make admin' : 'Make regular user',
    }))) return;
    const res = await fetch(`/api/auth/users/${target.id}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) { toast(await readError(res, 'Couldn’t change that role.')); return; }
    toast(promote ? `${target.username} is now an admin.` : `${target.username} is now a regular user.`);
    await refresh();
  }

  async function enable(target: ManagedUser) {
    const res = await fetch(`/api/auth/users/${target.id}/enable`, { method: 'POST' });
    if (!res.ok) { toast(await readError(res, 'Couldn’t turn that account back on.')); return; }
    toast(`${target.username} can sign in again.`);
    await refresh();
  }

  // Lost everything (phone and email too): reset both, and they start over at
  // their next sign-in — a new password, then a new authenticator.
  async function resetPassword(target: ManagedUser, withAuthenticator = false) {
    if (!(await confirm({
      title: withAuthenticator ? `Reset sign-in for ${target.username}?` : `Reset the password for ${target.username}?`,
      body: withAuthenticator
        ? 'A new password is shown to you once, and their authenticator is cleared. They keep their notes, and set both up again at their next sign-in.'
        : 'A new password is shown to you once. They keep their notes and choose their own at their next sign-in.',
      confirmLabel: withAuthenticator ? 'Reset both' : 'Reset password',
    }))) return;

    const res = await fetch(`/api/auth/users/${target.id}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: null, sendEmail: Boolean(target.email), resetTwoFactor: withAuthenticator }),
    });
    if (!res.ok) { toast(await readError(res, 'Couldn’t reset that password.')); return; }

    const body = await res.json() as { password: string; emailed: boolean };
    setCredentials({ username: target.username, password: body.password, emailed: body.emailed });
    await refresh();
  }

  async function resetAuthenticator(target: ManagedUser) {
    if (!(await confirm({
      title: `Reset the authenticator for ${target.username}?`,
      body: 'For a lost phone. They’re signed out everywhere and set up a new authenticator at their next sign-in.',
      confirmLabel: 'Reset authenticator',
    }))) return;
    const res = await fetch(`/api/auth/users/${target.id}/reset-2fa`, { method: 'POST' });
    if (!res.ok) { toast(await readError(res, 'Couldn’t reset the authenticator.')); return; }
    toast(`${target.username} will set up a new authenticator at their next sign-in.`);
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
      body: 'Their account, API keys and shares are removed and they can no longer sign in. Their note files stay on the server’s disk. To keep them out without deleting anything, disable the account instead.',
      confirmLabel: 'Delete user',
      destructive: true,
    }))) return;

    const res = await fetch(`/api/auth/users/${target.id}`, { method: 'DELETE' });
    if (res.ok) await refresh();
    else toast(await readError(res, 'Couldn’t delete that user.'));
  }

  return (
    <div className="settings__panel users-panel">
      <div className="users-panel__head">
        <h2 id="people" className="settings__subhead">People</h2>
        <button type="button" className="users-panel__new" onClick={() => setAdding(true)}>
          <UserPlus size={16} /> Add someone
        </button>
      </div>
      <p className="settings__hint">Admins manage accounts but can’t read anyone’s notes.</p>

      {isLoading && <LoadingBar label="Loading people" />}
      {isError && <p className="settings__error">Couldn’t load the list of accounts.</p>}

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
        <ul className="people" aria-label="Accounts">
          {users.map(u => {
            const isMe = u.id === me?.id;
            const lastAdmin = u.role === 'Admin' && !u.disabled && activeAdmins <= 1;
            return (
              <li key={u.id} className={`person${u.disabled ? ' person--disabled' : ''}`}>
                <Avatar username={u.username} name={u.name} size={36} />
                <div className="person__who">
                  <span className="person__name">
                    {u.name || u.username}
                    {isMe && <span className="person__you">you</span>}
                  </span>
                  <span className="person__meta">
                    @{u.username}
                    {u.email && <> · {u.email}</>}
                    {u.sso && <> · single sign-on</>}
                  </span>
                  <span className="person__meta">
                    {u.lastSignInUtc ? `Last signed in ${ago(u.lastSignInUtc)}` : 'Hasn’t signed in yet'}
                  </span>
                </div>

                <div className="person__controls">
                  <div className="person__status">
                    <PersonStatus user={u} />
                  </div>

                  <select
                    className="person__role"
                    value={u.role}
                    aria-label={`Role for ${u.username}`}
                    disabled={isMe || u.disabled || (lastAdmin && u.role === 'Admin')}
                    title={isMe ? 'Another admin has to change your role'
                      : lastAdmin ? 'The last admin can’t be made a regular user' : undefined}
                    onChange={e => void changeRole(u, e.target.value)}
                  >
                    <option value="User">User</option>
                    <option value="Admin">Admin</option>
                  </select>
                </div>

                <PersonMenu
                  user={u}
                  isMe={isMe}
                  lastAdmin={lastAdmin}
                  onReset={() => void resetPassword(u)}
                  onResetBoth={() => void resetPassword(u, true)}
                  onResetTotp={() => void resetAuthenticator(u)}
                  onLink={() => void recoveryLink(u)}
                  onDisable={() => setDisabling(u)}
                  onEnable={() => void enable(u)}
                  onDelete={() => void remove(u)}
                />
              </li>
            );
          })}
        </ul>
      )}

      {adding && (
        <AddUserDialog
          onClose={() => setAdding(false)}
          onCreated={async (created) => { setAdding(false); setCredentials(created); await refresh(); }}
        />
      )}

      {disabling && (
        <DisableDialog
          target={disabling}
          onClose={() => setDisabling(null)}
          onDone={async () => {
            toast(`${disabling.username} is disabled and signed out everywhere.`);
            setDisabling(null);
            await refresh();
          }}
        />
      )}

      {credentials && (
        <CredentialsDialog credentials={credentials} onClose={() => setCredentials(null)} />
      )}
    </div>
  );
}

function PersonStatus({ user }: { user: ManagedUser }) {
  if (user.disabled) {
    return (
      <span className="person-chip person-chip--off" title={user.disabledReason ?? undefined}>
        <Ban size={12} aria-hidden="true" /> Disabled
      </span>
    );
  }
  if (user.deletionScheduledUtc) {
    return <span className="person-chip person-chip--warn"><Clock size={12} aria-hidden="true" /> Leaving</span>;
  }
  if (user.mustChangePassword) {
    return (
      <span className="person-chip person-chip--warn" title="Hasn’t chosen their own password yet">
        <ShieldAlert size={12} aria-hidden="true" /> New password pending
      </span>
    );
  }
  return <span className="person-chip"><CircleCheck size={12} aria-hidden="true" /> Active</span>;
}

// A row's actions, behind one "…" — five inline links per row made the list
// read as a wall of underlines.
function PersonMenu({ user, isMe, lastAdmin, onReset, onResetBoth, onResetTotp, onLink, onDisable, onEnable, onDelete }: {
  user: ManagedUser; isMe: boolean; lastAdmin: boolean;
  onReset: () => void; onResetBoth: () => void; onResetTotp: () => void;
  onLink: () => void; onDisable: () => void; onEnable: () => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => { setOpen(false); setPos(null); }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const t = trigger.current?.getBoundingClientRect();
    const m = menu.current;
    if (!t || !m) return;
    const below = t.bottom + 4;
    const top = below + m.offsetHeight <= window.innerHeight - 8 ? below : Math.max(8, t.top - 4 - m.offsetHeight);
    setPos({ top, left: Math.max(8, Math.min(t.right - m.offsetWidth, window.innerWidth - 8 - m.offsetWidth)) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); trigger.current?.focus(); } };
    const move = () => close();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', move, true);
    window.addEventListener('resize', move);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', move, true);
      window.removeEventListener('resize', move);
    };
  }, [open, close]);

  useEffect(() => {
    if (open && pos) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open, pos]);

  const run = (fn: () => void) => () => { close(); fn(); };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="person__more"
        aria-label={`Actions for ${user.username}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && createPortal(
        <div
          ref={menu}
          className="card-menu"
          role="menu"
          style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
        >
          <button type="button" role="menuitem" className="card-menu__item" onClick={run(onReset)} disabled={user.sso}
            title={user.sso ? 'Signs in with single sign-on — no Papyra password' : undefined}>
            <KeyRound size={15} /> Reset password
          </button>
          <button type="button" role="menuitem" className="card-menu__item" onClick={run(onLink)} disabled={user.sso}>
            <Link2 size={15} /> Recovery link
          </button>
          {!isMe && (
            <>
              <button type="button" role="menuitem" className="card-menu__item" onClick={run(onResetTotp)} disabled={!user.totpEnabled}
                title={user.totpEnabled ? undefined : 'No authenticator set up yet'}>
                <Smartphone size={15} /> Reset authenticator
              </button>
              <button type="button" role="menuitem" className="card-menu__item" onClick={run(onResetBoth)} disabled={user.sso}>
                <RotateCcw size={15} /> Reset password + authenticator
              </button>
            </>
          )}
          {!isMe && (
            <>
              <div className="card-menu__sep" role="separator" />
              {user.disabled ? (
                <button type="button" role="menuitem" className="card-menu__item" onClick={run(onEnable)}>
                  <CircleCheck size={15} /> Enable account
                </button>
              ) : (
                <button type="button" role="menuitem" className="card-menu__item" onClick={run(onDisable)}
                  disabled={lastAdmin} title={lastAdmin ? 'The last admin can’t be disabled' : undefined}>
                  <Ban size={15} /> Disable account…
                </button>
              )}
              <button type="button" role="menuitem" className="card-menu__item card-menu__item--danger"
                onClick={run(onDelete)} disabled={lastAdmin}>
                <Trash2 size={15} /> Delete account
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Disable ───────────────────────────────────────────────────────────────────
// A reason is optional and only ever shown to admins — it's for the next admin
// who wonders why this account is off.
function DisableDialog({ target, onClose, onDone }: {
  target: ManagedUser; onClose: () => void; onDone: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/users/${target.id}/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || null }),
      });
      if (!res.ok) { setError(await readError(res, 'Couldn’t disable that account.')); return; }
      await onDone();
    } catch {
      setError('Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="users-dialog__scrim" role="presentation" onMouseDown={onClose}>
      <div className="users-dialog" role="dialog" aria-modal="true" aria-labelledby="disable-title"
        onMouseDown={e => e.stopPropagation()}>
        <h2 id="disable-title" className="users-dialog__title">Disable {target.username}?</h2>
        <form className="users-dialog__form" onSubmit={submit}>
          <p className="users-dialog__note">
            They’re signed out everywhere at once, and nothing gets back in — not their password,
            a passkey, single sign-on, an API key or a reset link — until you turn the account back on.
            Their notes, shares and settings are kept exactly as they are.
            {target.email && ' They’ll get an email saying so.'}
          </p>
          {error && <p className="users-dialog__error" role="alert">{error}</p>}
          <label className="users-dialog__field">Reason (only admins see this)
            <input value={reason} maxLength={200} onChange={e => setReason(e.target.value)}
              placeholder="e.g. Password leaked — waiting for a new one" autoFocus />
          </label>
          <div className="users-dialog__actions">
            <button type="button" className="users-dialog__btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="users-dialog__btn users-dialog__btn--danger" disabled={busy}>
              <Ban size={15} aria-hidden="true" /> {busy ? 'Disabling…' : 'Disable account'}
            </button>
          </div>
        </form>
      </div>
    </div>
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
            <input value={username} onChange={e => setUsername(e.target.value)} required autoFocus {...NO_AUTOFILL} />
          </label>
          <label className="users-dialog__field">Display name
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Optional" />
          </label>
          <label className="users-dialog__field">Email
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Optional" />
          </label>

          <label className="users-dialog__field">First password
            <input
              {...MASKED_SECRET}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Leave blank to generate one"
            />
          </label>
          {password && (
            <label className="users-dialog__field">Repeat the password
              <input
                {...MASKED_SECRET}
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
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
              type="checkbox" role="switch" className="switch"
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
