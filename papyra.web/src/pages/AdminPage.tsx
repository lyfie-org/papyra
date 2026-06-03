import { useState } from 'react';
import {
  useAdminUsers, useAdminRoles, useChangeUserRole, useUpdateRole,
  useCreateUser, useAdminSettings, useToggleRegistration,
  useToggleEmailVerification, useSaveSmtp, useTestSmtp,
} from '../hooks/useAdmin';
import type { RoleModel, SmtpSettingsRequest } from '../types';
import './AdminPage.css';

export default function AdminPage() {
  return (
    <div className="admin-page">
      <header className="admin-page__header">
        <h1 className="admin-page__title">Administration</h1>
        <p className="admin-page__subtitle">Manage users, roles, and access controls.</p>
      </header>

      <div className="admin-page__sections">
        <SetupChecklistSection />
        <InstanceSettingsSection />
        <SmtpSection />
        <UsersSection />
        <RolesSection />
      </div>
    </div>
  );
}

// ── Setup Checklist ───────────────────────────────────────────────────────────

function SetupChecklistSection() {
  const { data: settings } = useAdminSettings();
  const { data: users }    = useAdminUsers();

  const smtpConfigured  = Boolean(settings?.smtp?.host);
  const multipleUsers   = (users?.length ?? 0) > 1;
  const emailVerify     = settings?.requireEmailVerification ?? false;

  // Hide checklist once all items are done
  if (smtpConfigured && multipleUsers) return null;

  const items: { done: boolean; label: string; hint: string }[] = [
    {
      done:  smtpConfigured,
      label: 'Configure SMTP',
      hint:  'Required for password resets and email verification. See the SMTP section below.',
    },
    {
      done:  multipleUsers,
      label: 'Invite team members',
      hint:  'Create accounts for additional users in the Users section below.',
    },
    {
      done:  emailVerify,
      label: 'Enable email verification (optional)',
      hint:  'Require new self-registered accounts to verify their email address.',
    },
  ];

  return (
    <section className="admin-section admin-section--checklist">
      <h2 className="admin-section__title">Setup checklist</h2>
      <p className="admin-section__desc">Complete these steps to finish configuring your instance.</p>
      <ul className="admin-checklist">
        {items.map(item => (
          <li key={item.label} className={`admin-checklist__item${item.done ? ' admin-checklist__item--done' : ''}`}>
            <span className="admin-checklist__icon" aria-hidden="true">{item.done ? '✓' : '○'}</span>
            <div>
              <p className="admin-checklist__label">{item.label}</p>
              {!item.done && <p className="admin-checklist__hint">{item.hint}</p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Instance Settings ─────────────────────────────────────────────────────────

function InstanceSettingsSection() {
  const { data: settings, isLoading, error } = useAdminSettings();
  const { mutate: toggleReg,    isPending: pendingReg    } = useToggleRegistration();
  const { mutate: toggleVerify, isPending: pendingVerify } = useToggleEmailVerification();

  return (
    <section className="admin-section">
      <h2 className="admin-section__title">Instance Settings</h2>

      {isLoading && <p className="admin-section__empty">Loading settings…</p>}
      {error     && <p className="admin-section__error">Failed to load settings.</p>}

      {settings && (
        <div className="admin-settings-card">
          <div className="admin-settings-row">
            <div>
              <p className="admin-settings-label">Allow Self-Registration</p>
              <p className="admin-settings-hint">
                When enabled, anyone who can reach this instance may create a member account.
              </p>
            </div>
            <label className="admin-toggle" aria-label="Toggle self-registration">
              <input
                type="checkbox"
                checked={settings.allowSelfRegistration}
                disabled={pendingReg}
                onChange={() => toggleReg()}
              />
              <span className="admin-toggle__track" />
            </label>
          </div>

          <div className="admin-settings-row">
            <div>
              <p className="admin-settings-label">Require Email Verification</p>
              <p className="admin-settings-hint">
                New self-registered accounts must verify their email address before logging in.
                Requires SMTP to be configured.
              </p>
            </div>
            <label className="admin-toggle" aria-label="Toggle email verification requirement">
              <input
                type="checkbox"
                checked={settings.requireEmailVerification}
                disabled={pendingVerify}
                onChange={() => toggleVerify()}
              />
              <span className="admin-toggle__track" />
            </label>
          </div>
        </div>
      )}
    </section>
  );
}

// ── SMTP Configuration ────────────────────────────────────────────────────────

function SmtpSection() {
  const { data: settings, isLoading } = useAdminSettings();
  const { mutate: save,   isPending: saving } = useSaveSmtp();
  const { mutate: test,   isPending: testing, data: testResult } = useTestSmtp();

  const existing = settings?.smtp;

  const [form, setForm] = useState<SmtpSettingsRequest>({
    host:        '',
    port:        587,
    security:    'starttls',
    username:    '',
    password:    '',
    fromAddress: '',
    fromName:    'Papyra',
  });
  const [populated, setPopulated] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [saveOk, setSaveOk] = useState(false);

  // Populate form from server data once loaded
  if (existing && !populated) {
    setPopulated(true);
    setForm(f => ({
      ...f,
      host:        existing.host,
      port:        existing.port,
      security:    existing.security,
      username:    existing.username,
      fromAddress: existing.fromAddress,
      fromName:    existing.fromName,
    }));
  }

  function set(field: keyof SmtpSettingsRequest) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm(prev => ({ ...prev, [field]: field === 'port' ? Number(e.target.value) : e.target.value }));
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveOk(false);
    save(form, { onSuccess: () => { setSaveOk(true); setTimeout(() => setSaveOk(false), 3000); } });
  }

  function handleTest() {
    test(testEmail || undefined);
  }

  return (
    <section className="admin-section">
      <h2 className="admin-section__title">SMTP Email</h2>
      <p className="admin-section__desc">
        Configure outbound email for password resets and email verification.
        The password is stored encrypted using your <code>PAPYRA_DATA_KEY</code>.
      </p>

      {isLoading && <p className="admin-section__empty">Loading…</p>}

      {!isLoading && (
        <form className="admin-smtp-form" onSubmit={handleSave} noValidate>
          <div className="admin-smtp-grid">
            <div className="admin-smtp-field admin-smtp-field--host">
              <label htmlFor="smtp-host" className="admin-smtp-label">SMTP Host</label>
              <input id="smtp-host" type="text" className="admin-smtp-input"
                value={form.host} onChange={set('host')} placeholder="smtp.example.com" required />
            </div>

            <div className="admin-smtp-field admin-smtp-field--port">
              <label htmlFor="smtp-port" className="admin-smtp-label">Port</label>
              <input id="smtp-port" type="number" className="admin-smtp-input"
                value={form.port} onChange={set('port')} min={1} max={65535} required />
            </div>

            <div className="admin-smtp-field admin-smtp-field--security">
              <label htmlFor="smtp-security" className="admin-smtp-label">Security</label>
              <select id="smtp-security" className="admin-smtp-select"
                value={form.security} onChange={set('security')}>
                <option value="starttls">STARTTLS</option>
                <option value="ssl">SSL/TLS</option>
                <option value="none">None</option>
              </select>
            </div>

            <div className="admin-smtp-field admin-smtp-field--user">
              <label htmlFor="smtp-username" className="admin-smtp-label">Username</label>
              <input id="smtp-username" type="text" className="admin-smtp-input"
                value={form.username} onChange={set('username')}
                autoComplete="off" placeholder="user@example.com" />
            </div>

            <div className="admin-smtp-field admin-smtp-field--pass">
              <label htmlFor="smtp-password" className="admin-smtp-label">
                Password
                {existing?.hasPassword && (
                  <span className="admin-smtp-badge">saved</span>
                )}
              </label>
              <input id="smtp-password" type="password" className="admin-smtp-input"
                value={form.password} onChange={set('password')}
                autoComplete="new-password"
                placeholder={existing?.hasPassword ? 'Leave blank to keep existing' : 'Password'} />
            </div>

            <div className="admin-smtp-field admin-smtp-field--from-addr">
              <label htmlFor="smtp-from-addr" className="admin-smtp-label">From Address</label>
              <input id="smtp-from-addr" type="email" className="admin-smtp-input"
                value={form.fromAddress} onChange={set('fromAddress')}
                placeholder="papyra@example.com" required />
            </div>

            <div className="admin-smtp-field admin-smtp-field--from-name">
              <label htmlFor="smtp-from-name" className="admin-smtp-label">From Name</label>
              <input id="smtp-from-name" type="text" className="admin-smtp-input"
                value={form.fromName} onChange={set('fromName')}
                placeholder="Papyra" />
            </div>
          </div>

          <div className="admin-smtp-actions">
            <button type="submit" className="admin-smtp-save" disabled={saving} aria-busy={saving}>
              {saving ? 'Saving…' : saveOk ? 'Saved ✓' : 'Save SMTP settings'}
            </button>
          </div>
        </form>
      )}

      {existing && (
        <div className="admin-smtp-test">
          <h3 className="admin-smtp-test__title">Test connection</h3>
          <div className="admin-smtp-test__row">
            <input
              type="email"
              className="admin-smtp-input"
              value={testEmail}
              onChange={e => setTestEmail(e.target.value)}
              placeholder="Send test email to…"
              aria-label="Test email recipient"
            />
            <button
              type="button"
              className="admin-smtp-test__btn"
              onClick={handleTest}
              disabled={testing}
              aria-busy={testing}
            >
              {testing ? 'Sending…' : 'Send test email'}
            </button>
          </div>
          {testResult && (
            <p className={`admin-smtp-test__result ${testResult.success ? 'admin-smtp-test__result--ok' : 'admin-smtp-test__result--err'}`}>
              {testResult.success ? 'Test email sent successfully.' : `Error: ${testResult.error}`}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ── Create User ───────────────────────────────────────────────────────────────

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  return Array.from({ length: 14 }, () =>
    chars[Math.floor(Math.random() * chars.length)]).join('');
}

function UsersSection() {
  const { data: users, isLoading, error } = useAdminUsers();
  const { mutate: changeRole, isPending } = useChangeUserRole();
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  function handleRoleChange(username: string, newRole: string) {
    setBusy(username);
    changeRole(
      { username, role: newRole },
      { onSettled: () => setBusy(null) },
    );
  }

  return (
    <section className="admin-section">
      <div className="admin-section__header-row">
        <h2 className="admin-section__title">Users</h2>
        <button
          className="admin-add-btn"
          onClick={() => setShowCreateModal(true)}
          aria-label="Add new user"
        >
          + Add user
        </button>
      </div>

      {isLoading && <p className="admin-section__empty">Loading users…</p>}
      {error    && <p className="admin-section__error">Failed to load users.</p>}

      {users && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>2FA</th>
                <th>Status</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.username}>
                  <td><code className="admin-code">{u.username}</code></td>
                  <td>{u.name}</td>
                  <td className="admin-muted">{u.email || '—'}</td>
                  <td>
                    <select
                      className="admin-role-select"
                      value={u.role}
                      disabled={busy === u.username || isPending}
                      onChange={e => handleRoleChange(u.username, e.target.value)}
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td>
                    <span className={`admin-badge ${u.twoFactorEnabled ? 'admin-badge--on' : 'admin-badge--off'}`}>
                      {u.twoFactorEnabled ? 'On' : 'Off'}
                    </span>
                  </td>
                  <td>
                    {u.mustResetPassword && (
                      <span className="admin-badge admin-badge--warn" title="User must reset password on next login">
                        Reset req.
                      </span>
                    )}
                  </td>
                  <td className="admin-muted">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreateModal && (
        <CreateUserModal onClose={() => setShowCreateModal(false)} />
      )}
    </section>
  );
}

// ── Create User Modal ─────────────────────────────────────────────────────────

function CreateUserModal({ onClose }: { onClose: () => void }) {
  const { mutate: createUser, isPending, error } = useCreateUser();

  const [username, setUsername] = useState('');
  const [name,     setName]     = useState('');
  const [email,    setEmail]    = useState('');
  const [role,     setRole]     = useState<'member' | 'admin'>('member');
  const [password, setPassword] = useState(() => generateTempPassword());
  const [copied,   setCopied]   = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createUser(
      { username: username.trim(), password, name: name.trim() || undefined, email: email.trim() || undefined, role },
      { onSuccess: onClose },
    );
  }

  const serverError = error
    ? ((error as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Failed to create user.')
    : null;

  return (
    // Backdrop
    <div
      className="admin-modal-backdrop"
      role="presentation"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="admin-modal"
        role="dialog"
        aria-modal
        aria-labelledby="create-user-title"
      >
        <header className="admin-modal__header">
          <h3 id="create-user-title" className="admin-modal__title">Add new user</h3>
          <button className="admin-modal__close" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <form className="admin-modal__form" onSubmit={handleSubmit} noValidate>
          <div className="admin-modal__field">
            <label htmlFor="cu-username" className="admin-modal__label">Username</label>
            <input
              id="cu-username"
              type="text"
              className="admin-modal__input"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              required
              spellCheck={false}
              placeholder="e.g. alice"
            />
          </div>

          <div className="admin-modal__field">
            <label htmlFor="cu-name" className="admin-modal__label">Display name <span className="admin-modal__optional">(optional)</span></label>
            <input
              id="cu-name"
              type="text"
              className="admin-modal__input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Alice Smith"
            />
          </div>

          <div className="admin-modal__field">
            <label htmlFor="cu-email" className="admin-modal__label">Email <span className="admin-modal__optional">(optional)</span></label>
            <input
              id="cu-email"
              type="email"
              className="admin-modal__input"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="alice@example.com"
            />
          </div>

          <div className="admin-modal__field">
            <label htmlFor="cu-role" className="admin-modal__label">Role</label>
            <select
              id="cu-role"
              className="admin-modal__select"
              value={role}
              onChange={e => setRole(e.target.value as 'member' | 'admin')}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>

          <div className="admin-modal__field">
            <label htmlFor="cu-password" className="admin-modal__label">
              Temporary password
              <span className="admin-modal__hint-inline"> — give this to the user, they'll be asked to reset it</span>
            </label>
            <div className="admin-modal__password-row">
              <input
                id="cu-password"
                type="text"
                className="admin-modal__input admin-modal__input--mono"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                aria-describedby="cu-password-hint"
                spellCheck={false}
              />
              <button
                type="button"
                className="admin-modal__copy-btn"
                onClick={handleCopy}
                aria-label="Copy password"
              >
                {copied ? '✓' : 'Copy'}
              </button>
              <button
                type="button"
                className="admin-modal__regen-btn"
                onClick={() => { setPassword(generateTempPassword()); setCopied(false); }}
                aria-label="Generate new password"
              >
                ↻
              </button>
            </div>
            <span id="cu-password-hint" className="admin-modal__field-hint">
              User will be forced to change this on first login.
            </span>
          </div>

          {serverError && (
            <p className="admin-modal__error" role="alert">{serverError}</p>
          )}

          <div className="admin-modal__actions">
            <button type="button" className="admin-modal__cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="admin-modal__submit"
              disabled={isPending || !username.trim()}
              aria-busy={isPending}
            >
              {isPending ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RolesSection() {
  const { data: roles, isLoading, error } = useAdminRoles();
  const { mutate: updateRole } = useUpdateRole();
  const [editing, setEditing] = useState<Record<string, Partial<Omit<RoleModel, 'name'>>>>({});

  function handleFieldChange(name: string, field: keyof Omit<RoleModel, 'name'>, value: string | boolean | number) {
    setEditing(prev => ({
      ...prev,
      [name]: { ...prev[name], [field]: value },
    }));
  }

  function handleSave(name: string) {
    const patch = editing[name];
    if (!patch) return;
    updateRole(
      { name, patch },
      { onSuccess: () => setEditing(prev => { const next = { ...prev }; delete next[name]; return next; }) },
    );
  }

  return (
    <section className="admin-section">
      <h2 className="admin-section__title">Roles</h2>

      {isLoading && <p className="admin-section__empty">Loading roles…</p>}
      {error    && <p className="admin-section__error">Failed to load roles.</p>}

      {roles && (
        <div className="admin-role-cards">
          {roles.map(role => {
            const draft = editing[role.name] ?? {};
            const maxNotes  = draft.maxNotesAllowed      ?? role.maxNotesAllowed;
            const uploads   = draft.allowFileUploads     ?? role.allowFileUploads;
            const sizeLimit = draft.attachmentSizeLimitMB ?? role.attachmentSizeLimitMB;
            const dirty     = !!editing[role.name];

            return (
              <div key={role.name} className="admin-role-card">
                <h3 className="admin-role-card__name">{role.name}</h3>

                <div className="admin-role-card__field">
                  <label className="admin-role-card__label">Max Notes</label>
                  <input
                    type="number"
                    className="admin-role-card__input"
                    value={maxNotes === -1 ? '' : maxNotes}
                    placeholder="Unlimited"
                    min={-1}
                    onChange={e => handleFieldChange(role.name, 'maxNotesAllowed',
                      e.target.value === '' ? -1 : parseInt(e.target.value, 10))}
                  />
                  <span className="admin-role-card__hint">-1 = unlimited</span>
                </div>

                <div className="admin-role-card__field">
                  <label className="admin-role-card__label">File Uploads</label>
                  <label className="admin-toggle">
                    <input
                      type="checkbox"
                      checked={uploads}
                      onChange={e => handleFieldChange(role.name, 'allowFileUploads', e.target.checked)}
                    />
                    <span className="admin-toggle__track" />
                  </label>
                </div>

                <div className="admin-role-card__field">
                  <label className="admin-role-card__label">Attachment limit (MB)</label>
                  <input
                    type="number"
                    className="admin-role-card__input"
                    value={sizeLimit}
                    min={1}
                    onChange={e => handleFieldChange(role.name, 'attachmentSizeLimitMB',
                      parseInt(e.target.value, 10))}
                  />
                </div>

                <button
                  className="admin-role-card__save"
                  disabled={!dirty}
                  onClick={() => handleSave(role.name)}
                >
                  Save changes
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
