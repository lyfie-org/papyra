import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import TotpQr from './TotpQr';
import LoadingBar from './LoadingBar';
import CodeField from './CodeField';
import SettingRow, { SettingGroup } from './SettingRow';
import { requestEmailCode } from '../lib/emailCode';
import { useAuth } from '../hooks/useAuth';
import { parseUtc } from '../lib/vault';

interface Authenticator { id: number; name: string; createdUtc: string; lastUsedUtc: string | null }
interface TotpStatus { enabled: boolean; authenticators: Authenticator[] }

async function send(url: string, body: unknown, method = 'POST') {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  return { res, data };
}

/**
 * Settings → Security → Two-step sign-in: the authenticator apps on the
 * account (any of them answers a code; the last can't be removed) and whether
 * signing in asks for a code too — always, for administrators.
 */
export default function AuthenticatorSection() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const status = useQuery({
    queryKey: ['totp'],
    queryFn: async () => {
      const res = await fetch('/api/auth/totp');
      if (!res.ok) throw new Error(String(res.status));
      return res.json() as Promise<TotpStatus>;
    },
  });
  const [adding, setAdding] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  const isAdmin = user?.role === 'Admin';
  const signInOn = !!user?.twoFactorLogin;
  const emailCode = user?.canEmailCode ? () => requestEmailCode('/api/auth/step-up/email') : undefined;
  const list = status.data?.authenticators ?? [];

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['totp'] }),
      queryClient.invalidateQueries({ queryKey: ['auth'] }),
      queryClient.invalidateQueries({ queryKey: ['account-delete'] }),
    ]);
  }

  async function setSignIn(enabled: boolean, code?: string): Promise<boolean> {
    setSignInError(null);
    const { res, data } = await send('/api/auth/totp/login', { enabled, code }, 'PUT');
    if (!res.ok) { setSignInError((data?.error as string) ?? 'Couldn’t change that.'); return false; }
    await refresh();
    return true;
  }

  return (
    <SettingGroup
      title="Two-step sign-in"
      id="authenticator"
      footer={!adding && (
        <button type="button" className="settings__btn settings__btn--quiet" onClick={() => setAdding(true)}>
          <Plus size={15} /> Add authenticator
        </button>
      )}
    >
      {status.isLoading && <div className="setting-row"><div className="setting-row__line"><LoadingBar label="Loading" /></div></div>}

      {list.map(a => (
        <SettingRow
          key={a.id}
          label="Authenticator"
          value={a.name}
          hint={`Added ${parseUtc(a.createdUtc).toLocaleDateString()}${a.lastUsedUtc ? ` · last used ${parseUtc(a.lastUsedUtc).toLocaleDateString()}` : ''}`}
          action="Remove"
          actionDisabled={list.length === 1}
        >
          {close => <RemoveAuthenticator id={a.id} onEmail={emailCode} onDone={async () => { await refresh(); close(); }} onCancel={close} />}
        </SettingRow>
      ))}

      {adding && (
        <div className="setting-row is-open">
          <div className="setting-row__editor setting-row__editor--solo">
            <AddAuthenticator
              hasOne={list.length > 0}
              hasPassword={user?.hasPassword !== false}
              onEmail={emailCode}
              onDone={async () => { await refresh(); setAdding(false); }}
              onCancel={() => setAdding(false)}
            />
          </div>
        </div>
      )}

      {status.data?.enabled && (
        <SettingRow
          label="Ask for a code when I sign in"
          value={isAdmin ? 'Always on for administrators' : signInOn ? 'On' : 'Off'}
          action={signInOn ? 'Turn off' : 'Turn on'}
          actionDisabled={isAdmin}
        >
          {close => signInOn ? (
            <TurnOff onEmail={emailCode} error={signInError}
              onSubmit={async code => { if (await setSignIn(false, code)) close(); }} onCancel={close} />
          ) : (
            <form className="settings__form" onSubmit={async e => { e.preventDefault(); if (await setSignIn(true)) close(); }}>
              <p className="settings__hint">Signing in will ask for a code from your authenticator.</p>
              {signInError && <p className="settings__error" role="alert">{signInError}</p>}
              <div className="settings__form-actions">
                <button type="submit" className="settings__btn">Turn on</button>
                <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
              </div>
            </form>
          )}
        </SettingRow>
      )}
    </SettingGroup>
  );
}

function TurnOff({ onEmail, error, onSubmit, onCancel }: {
  onEmail?: () => Promise<string>; error: string | null; onSubmit: (code: string) => void; onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  return (
    <form className="settings__form" onSubmit={e => { e.preventDefault(); onSubmit(code); }}>
      <CodeField value={code} onChange={setCode} autoFocus onEmail={onEmail} />
      {error && <p className="settings__error" role="alert">{error}</p>}
      <div className="settings__form-actions">
        <button type="submit" className="settings__btn" disabled={code.length !== 6}>Turn off</button>
        <button type="button" className="settings__btn settings__btn--quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function RemoveAuthenticator({ id, onEmail, onDone, onCancel }: {
  id: number; onEmail?: () => Promise<string>; onDone: () => void; onCancel: () => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="settings__form" onSubmit={async e => {
      e.preventDefault();
      setBusy(true);
      const { res, data } = await send(`/api/auth/totp/${id}/remove`, { code });
      setBusy(false);
      if (res.ok) onDone(); else { setError((data?.error as string) ?? 'Couldn’t remove it.'); setCode(''); }
    }}>
      <CodeField value={code} onChange={setCode} autoFocus label="Code from any of your authenticators" onEmail={onEmail} />
      {error && <p className="settings__error" role="alert">{error}</p>}
      <div className="settings__form-actions">
        <button type="submit" className="settings__btn" disabled={busy || code.length !== 6}>Remove</button>
        <button type="button" className="settings__btn settings__btn--quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function AddAuthenticator({ hasOne, hasPassword, onEmail, onDone, onCancel }: {
  hasOne: boolean; hasPassword: boolean; onEmail?: () => Promise<string>; onDone: () => void; onCancel: () => void;
}) {
  const [enrol, setEnrol] = useState<{ secret: string; uri: string } | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A fresh secret when the form opens.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/auth/totp/begin', { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (cancelled) return;
      if (!res.ok || !data?.secret) setError(data?.error ?? 'Couldn’t start setup.');
      else setEnrol({ secret: data.secret, uri: data.uri });
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <form className="settings__form" onSubmit={async e => {
      e.preventDefault();
      if (!enrol) return;
      setBusy(true);
      const { res, data } = await send('/api/auth/totp', {
        secret: enrol.secret, code, name, password: hasPassword ? password : undefined, confirmCode: hasOne ? confirmCode : undefined,
      });
      setBusy(false);
      if (res.ok) onDone(); else setError((data?.error as string) ?? 'That didn’t work.');
    }}>
      <label className="settings__field">Name
        <input value={name} maxLength={60} placeholder="e.g. Phone, 1Password" autoFocus onChange={e => setName(e.target.value)} />
      </label>
      {enrol ? <TotpQr secret={enrol.secret} uri={enrol.uri} /> : <LoadingBar label="Preparing" />}
      <CodeField value={code} onChange={c => { setCode(c); setError(null); }} label="Code from the new app" />
      {hasOne && (
        <CodeField value={confirmCode} onChange={c => { setConfirmCode(c); setError(null); }}
          label="Code from an authenticator you already have" onEmail={onEmail} />
      )}
      {hasPassword && (
        <label className="settings__field">Your password
          <input type="password" value={password} autoComplete="current-password" onChange={e => { setPassword(e.target.value); setError(null); }} />
        </label>
      )}
      {error && <p className="settings__error" role="alert">{error}</p>}
      <div className="settings__form-actions">
        <button type="submit" className="settings__btn"
          disabled={busy || !enrol || code.length !== 6 || (hasOne && confirmCode.length !== 6) || (hasPassword && !password)}>
          {busy ? 'Checking…' : 'Add'}
        </button>
        <button type="button" className="settings__btn settings__btn--quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
