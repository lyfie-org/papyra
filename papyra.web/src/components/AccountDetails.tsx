import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthUser } from '../hooks/useAuth';
import SettingRow, { SettingGroup } from './SettingRow';
import TimeZonePicker from './TimeZonePicker';
import CodeField from './CodeField';
import { usernameRule } from '../lib/profileRules';
import { zoneCity, zoneOffsetLabel } from '../lib/timeZone';
import { NO_AUTOFILL } from '../lib/autofill';

type Saved = { ok: true } | { ok: false; error: string; field?: string; code?: string };

/** PUT only the fields given; the server leaves the rest as they are. */
async function saveProfile(fields: Record<string, unknown>): Promise<Saved> {
  try {
    const res = await fetch('/api/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => null) as { error?: string; field?: string; code?: string } | null;
    return { ok: false, error: data?.error ?? 'Couldn’t save that.', field: data?.field, code: data?.code };
  } catch {
    return { ok: false, error: 'Couldn’t reach the server.' };
  }
}

function Actions({ busy, disabled, onCancel, label = 'Save' }: { busy: boolean; disabled?: boolean; onCancel: () => void; label?: string }) {
  return (
    <div className="settings__form-actions">
      <button type="submit" className="settings__btn" disabled={busy || disabled}>{busy ? 'Saving…' : label}</button>
      <button type="button" className="settings__btn settings__btn--quiet" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/**
 * Settings → Profile → Account: each detail shown as it is, with its own
 * Edit. Only the field being changed is sent.
 */
export default function AccountDetails({ user }: { user: AuthUser | null }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['auth'] });
  const zone = user?.timeZone || '';

  return (
    <SettingGroup title="Account" id="account">
      <SettingRow label="Username" value={user ? `@${user.username}` : null} hint="For sign-in and @mentions">
        {close => <UsernameEditor current={user?.username ?? ''} onDone={async () => { await refresh(); close(); }} onCancel={close} />}
      </SettingRow>
      <SettingRow label="Display name" value={user?.name}>
        {close => (
          <SimpleEditor
            initial={user?.name ?? ''} label="Display name" maxLength={100} autoComplete="name"
            save={v => saveProfile({ name: v })} onDone={async () => { await refresh(); close(); }} onCancel={close}
          />
        )}
      </SettingRow>
      <SettingRow label="Email" value={user?.email} empty="No email address" action={user?.email ? 'Change' : 'Add'}>
        {close => <EmailEditor user={user} onDone={async () => { await refresh(); close(); }} onCancel={close} />}
      </SettingRow>
      <SettingRow
        label="Time zone"
        value={zone ? `${zoneCity(zone)} · ${zoneOffsetLabel(zone)}` : `Server default${user?.serverTimeZone ? ` (${zoneCity(user.serverTimeZone)})` : ''}`}
        action="Change"
      >
        {close => <TimeZoneEditor initial={zone} serverZone={user?.serverTimeZone} onDone={async () => { await refresh(); close(); }} onCancel={close} />}
      </SettingRow>
      <SettingRow label="Password" value={user?.hasPassword === false ? null : '••••••••'} empty="Signs in with single sign-on"
        action="Change" actionDisabled={user?.hasPassword === false} id="change-password">
        {close => <PasswordEditor onDone={close} onCancel={close} />}
      </SettingRow>
    </SettingGroup>
  );
}

function SimpleEditor({ initial, label, save, onDone, onCancel, maxLength, autoComplete }: {
  initial: string; label: string; save: (v: string) => Promise<Saved>; onDone: () => void; onCancel: () => void;
  maxLength?: number; autoComplete?: string;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="settings__form" onSubmit={async e => {
      e.preventDefault();
      setBusy(true);
      const r = await save(value.trim());
      setBusy(false);
      if (r.ok) onDone(); else setError(r.error);
    }}>
      <label className="settings__field">{label}
        <input value={value} maxLength={maxLength} autoComplete={autoComplete} autoFocus aria-invalid={!!error}
          onChange={e => { setValue(e.target.value); setError(null); }} />
        {error && <span className="settings__field-error">{error}</span>}
      </label>
      <Actions busy={busy} disabled={value.trim() === initial} onCancel={onCancel} />
    </form>
  );
}

function UsernameEditor({ current, onDone, onCancel }: { current: string; onDone: () => void; onCancel: () => void }) {
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<{ name: string; available: boolean; problem?: string | null } | null>(null);
  const wanted = value.trim();
  const problem = wanted ? usernameRule(wanted) : null;
  const check = !!wanted && !problem && wanted.toLowerCase() !== current.toLowerCase();
  const known = check && availability?.name === wanted ? availability : null;
  const taken = known && !known.available ? (known.problem ?? 'That username is taken.') : null;

  // Is it free on this Papyra? Asked while typing (debounced).
  useEffect(() => {
    if (!check) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/auth/username-available?name=${encodeURIComponent(wanted)}`, { signal: ctrl.signal });
        if (res.ok) setAvailability({ name: wanted, ...(await res.json()) });
      } catch { /* the server checks again on save */ }
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [check, wanted]);

  const message = error ?? problem ?? taken ?? (known?.available ? `@${wanted} is available.` : null);
  return (
    <form className="settings__form" onSubmit={async e => {
      e.preventDefault();
      if (problem || taken) return;
      setBusy(true);
      const r = await saveProfile({ username: wanted });
      setBusy(false);
      if (r.ok) onDone(); else setError(r.error);
    }}>
      <label className="settings__field">Username
        <span className="settings__affix">
          <span className="settings__affix-pre" aria-hidden="true">@</span>
          <input value={value} {...NO_AUTOFILL} spellCheck={false} autoCapitalize="none" maxLength={64} autoFocus
            aria-invalid={!!(error || problem || taken)} onChange={e => { setValue(e.target.value); setError(null); }} />
        </span>
        {message && <span className={error || problem || taken ? 'settings__field-error' : 'settings__hint'} aria-live="polite">{message}</span>}
      </label>
      <Actions busy={busy} disabled={!check || !!problem || !!taken} onCancel={onCancel} />
    </form>
  );
}

function TimeZoneEditor({ initial, serverZone, onDone, onCancel }: {
  initial: string; serverZone?: string; onDone: () => void; onCancel: () => void;
}) {
  const [zone, setZone] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="settings__form" onSubmit={async e => {
      e.preventDefault();
      setBusy(true);
      const r = await saveProfile({ timeZone: zone });
      setBusy(false);
      if (r.ok) onDone(); else setError(r.error);
    }}>
      <div className="settings__field">
        <span>Time zone</span>
        <TimeZonePicker value={zone} serverZone={serverZone} onChange={z => { setZone(z); setError(null); }} />
        {error && <span className="settings__field-error">{error}</span>}
      </div>
      <Actions busy={busy} disabled={zone === initial} onCancel={onCancel} />
    </form>
  );
}

/**
 * Moving the account's email needs proof: the authenticator's code (or a code
 * sent to the address it's leaving). Two steps: the new address, then the code.
 */
function EmailEditor({ user, onDone, onCancel }: { user: AuthUser | null; onDone: () => void; onCancel: () => void }) {
  const [email, setEmail] = useState(user?.email ?? '');
  const [proof, setProof] = useState<null | { kind: 'totp'; canEmail: boolean } | { kind: 'code'; sentTo: string } | { kind: 'password' }>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = email.trim().toLowerCase() !== (user?.email ?? '').toLowerCase();

  async function askProof(viaEmail = false): Promise<boolean> {
    const res = await fetch('/api/auth/email/code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim(), viaEmail }),
    });
    const data = await res.json().catch(() => null) as { required?: boolean; passwordRequired?: boolean; method?: string; canEmail?: boolean; sentTo?: string; error?: string } | null;
    if (!res.ok) { setError(data?.error ?? 'Couldn’t check that address.'); return false; }
    setCode('');
    if (data?.passwordRequired) { setProof({ kind: 'password' }); return false; }
    if (data?.method === 'totp') { setProof({ kind: 'totp', canEmail: !!data.canEmail }); return false; }
    if (data?.required) { setProof({ kind: 'code', sentTo: data.sentTo ?? 'your current address' }); return false; }
    return true; // no current address: nothing to prove
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (changed && user?.email && !proof && !(await askProof())) return;
      const r = await saveProfile({
        email: email.trim(),
        totpCode: proof?.kind === 'totp' ? code : undefined,
        emailCode: proof?.kind === 'code' ? code : undefined,
        currentPassword: proof?.kind === 'password' ? password : undefined,
      });
      if (r.ok) onDone();
      else if ((r.code === 'totp_required' || r.code === 'email_code_required') && !proof) await askProof();
      else setError(r.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings__form" onSubmit={submit}>
      <label className="settings__field">Email
        <input type="email" value={email} autoComplete="email" autoFocus={!proof} readOnly={!!proof}
          onChange={e => { setEmail(e.target.value); setError(null); }} />
      </label>
      {proof?.kind === 'totp' && (
        <CodeField value={code} onChange={setCode} autoFocus
          onEmail={proof.canEmail ? async () => { await askProof(true); return user?.email ?? 'your address'; } : undefined} />
      )}
      {proof?.kind === 'code' && <CodeField value={code} onChange={setCode} autoFocus label={`Code sent to ${proof.sentTo}`} />}
      {proof?.kind === 'password' && (
        <label className="settings__field">Your password
          <input type="password" value={password} autoComplete="current-password" autoFocus onChange={e => setPassword(e.target.value)} />
        </label>
      )}
      {error && <p className="settings__error" role="alert">{error}</p>}
      <Actions busy={busy} label={proof ? 'Confirm' : user?.email && changed ? 'Continue' : 'Save'}
        disabled={!changed || (proof?.kind === 'password' ? !password : !!proof && code.length !== 6)} onCancel={onCancel} />
    </form>
  );
}

function PasswordEditor({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="settings__form" onSubmit={async e => {
      e.preventDefault();
      if (next !== repeat) { setError('The new passwords don’t match.'); return; }
      setBusy(true);
      const res = await fetch('/api/auth/password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current, next }),
      });
      setBusy(false);
      if (res.ok) onDone();
      else setError((await res.json().catch(() => null))?.error ?? 'Couldn’t change the password.');
    }}>
      <label className="settings__field">Current password
        <input type="password" value={current} autoComplete="current-password" autoFocus required onChange={e => setCurrent(e.target.value)} />
      </label>
      <label className="settings__field">New password
        <input type="password" value={next} autoComplete="new-password" minLength={8} required onChange={e => setNext(e.target.value)} />
      </label>
      <label className="settings__field">Repeat new password
        <input type="password" value={repeat} autoComplete="new-password" required onChange={e => setRepeat(e.target.value)} />
      </label>
      {error && <p className="settings__error" role="alert">{error}</p>}
      <p className="settings__hint">Your other devices will be signed out.</p>
      <Actions busy={busy} label="Change password" disabled={!current || !next || !repeat} onCancel={onCancel} />
    </form>
  );
}
