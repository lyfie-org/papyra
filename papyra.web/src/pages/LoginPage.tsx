import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Fingerprint } from 'lucide-react';
import { assertionToJson, isWebAuthnAvailable, toRequestOptions, webAuthnErrorMessage } from '../lib/webauthn';
import CodeField from '../components/CodeField';
import { requestEmailCode } from '../lib/emailCode';
import './AuthForm.css';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // "Remember this device": stay signed in for 30 days, and skip the code here.
  const [remember, setRemember] = useState(false);
  // Two-step sign-in: the password was right, the code is next.
  const [step2, setStep2] = useState<{ ticket: string; canEmail: boolean } | null>(null);
  const [code, setCode] = useState('');
  // Arriving here because an admin disabled the account — mid-session (the
  // auth probe says why) or back from single sign-on (?disabled=1).
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(() => {
    const probe = queryClient.getQueryData<{ reason?: string }>(['auth']);
    const fromSso = new URLSearchParams(window.location.search).has('disabled');
    if (probe?.reason === 'account_disabled' || fromSso) return 'This account has been disabled. Ask your Papyra administrator.';
    if (probe?.reason === 'session_ended') return 'You were signed out on this device.';
    return null;
  });
  const [busy, setBusy] = useState(false);
  // Whether an SSO button belongs on this screen (server tells us if OIDC is on).
  const [sso, setSso] = useState<{ enabled: boolean; name: string } | null>(null);

  // Forgot-password panel, inline rather than a separate route: it is two fields
  // and one request, and a dead-end page for someone already locked out is worse.
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotId, setForgotId] = useState('');
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);

  async function requestReset() {
    setForgotBusy(true);
    setForgotMsg(null);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernameOrEmail: forgotId }),
      });
      const data = await res.json().catch(() => null);
      // The server answers identically for a known and an unknown account, and
      // so must this: anything more specific is an account-existence oracle.
      setForgotMsg(data?.message
        ?? 'If that account exists and has an email address, a reset link is on its way.');
    } catch {
      setForgotMsg('Couldn’t reach the server. Try again in a moment.');
    } finally {
      setForgotBusy(false);
    }
  }
  const navigate = useNavigate();
  const usernameRef = useRef<HTMLInputElement | null>(null);
  // Passkeys need the WebAuthn API and a secure context (HTTPS or localhost).
  const canPasskey = isWebAuthnAvailable();

  function signedIn(user: unknown) {
    // Seed the auth cache from the login response so RequireAuth sees an authed
    // session immediately instead of bouncing on the stale 'login' snapshot.
    queryClient.setQueryData(['auth'], { state: 'authed', user });
    navigate('/', { replace: true });
  }

  // Sign in with a biometric device registered under Settings → Security. The
  // passkeys aren't discoverable, so the account is named first; the server
  // answers the same for any name, and the device decides.
  async function passkeySignIn() {
    setError(null);
    const name = username.trim();
    if (!name) {
      setError('Enter your username, then use your passkey.');
      usernameRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const optRes = await fetch('/api/auth/passkey/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name }),
      });
      const options = await optRes.json().catch(() => null);
      if (!optRes.ok) { setError(options?.error ?? 'Passkey sign-in isn’t available here.'); return; }

      let assertion: PublicKeyCredential | null;
      try {
        assertion = (await navigator.credentials.get({ publicKey: toRequestOptions(options) })) as PublicKeyCredential | null;
      } catch (e) {
        setError(`${webAuthnErrorMessage(e)} No passkey for this account on this device? Use your password.`);
        return;
      }
      if (!assertion) { setError('Passkey sign-in was cancelled.'); return; }

      const res = await fetch('/api/auth/passkey/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name, response: assertionToJson(assertion), remember }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error ?? 'That passkey didn’t work.'); return; }
      signedIn(data);
    } catch {
      setError('Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    fetch('/api/auth/providers')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setSso({ enabled: !!d.sso, name: d.ssoName ?? 'SSO' }); })
      .catch(() => { /* SSO simply stays hidden */ });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, remember }),
      });
      if (!res.ok) {
        // A disabled account or a lockout says so; anything else stays vague.
        const data = await res.json().catch(() => null) as { error?: string; code?: string } | null;
        setError(data?.code === 'account_disabled' || res.status === 429 ? (data?.error ?? 'Try again later.') : 'Invalid credentials.');
        return;
      }
      const data = await res.json();
      if (data?.twoFactorRequired) {
        setStep2({ ticket: data.ticket, canEmail: !!data.canEmail });
        setCode('');
        return;
      }
      signedIn(data);
    } catch {
      setError('Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!step2) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/auth/login/2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: step2.ticket, code }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // A timed-out or spent ticket goes back to the password.
        if (data?.code === 'ticket_expired' || data?.code === 'account_disabled') setStep2(null);
        setError(data?.error ?? 'That code didn’t work.');
        setCode('');
        return;
      }
      signedIn(data);
    } catch {
      setError('Couldn’t reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (step2) {
    return (
      <div className="auth">
        <form className="auth__card" onSubmit={submitCode}>
          <h1 className="auth__title">One more step</h1>
          <p className="auth__tagline">Enter the code from your authenticator app.</p>
          {error && <p className="auth__error" role="alert">{error}</p>}
          <CodeField
            value={code}
            onChange={setCode}
            autoFocus
            label="Code"
            onEmail={step2.canEmail ? () => requestEmailCode('/api/auth/login/2fa/email', { ticket: step2.ticket }) : undefined}
          />
          <button className="auth__submit" type="submit" disabled={busy || code.length !== 6}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          <button type="button" className="auth__link" onClick={() => { setStep2(null); setError(null); }}>
            <ArrowLeft size={12} aria-hidden="true" /> Back
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={submit}>
        <h1 className="auth__title">Welcome back</h1>
        <p className="auth__tagline">Sign in to your Papyra vault.</p>

        {error && <p className="auth__error" role="alert">{error}</p>}

        <label className="auth__field">
          Username
          <input ref={usernameRef} value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label className="auth__field">
          Password
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <label className="auth__remember">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          Remember this device
        </label>

        <button className="auth__submit" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {/* Always offered. Whether a reset can actually be emailed depends on the
            instance having SMTP configured, and the endpoint answers identically
            either way — telling people here which instances can send mail would
            leak configuration to anyone who loads the sign-in page. */}
        <button
          type="button"
          className="auth__link"
          onClick={() => setForgotOpen(o => !o)}
        >
          Forgot your password?
        </button>

        {forgotOpen && (
          <div className="auth__forgot">
            <label className="auth__field">
              Username or email
              <input
                type="text"
                value={forgotId}
                onChange={e => setForgotId(e.target.value)}
                autoComplete="username"
              />
            </label>
            <button
              type="button"
              className="auth__submit"
              disabled={forgotBusy}
              onClick={() => void requestReset()}
            >
              {forgotBusy ? 'Sending…' : 'Email me a reset link'}
            </button>
            {forgotMsg && <p className="auth__tagline">{forgotMsg}</p>}
          </div>
        )}

        {(canPasskey || sso?.enabled) && <div className="auth__divider"><span>or</span></div>}

        {canPasskey && (
          <button type="button" className="auth__sso auth__passkey" disabled={busy} onClick={() => void passkeySignIn()}>
            <Fingerprint size={17} aria-hidden="true" /> Sign in with a passkey
          </button>
        )}

        {sso?.enabled && (
          <>
            <button
              type="button"
              className="auth__sso"
              onClick={() => { window.location.href = '/api/auth/login/sso'; }}
            >
              Continue with {sso.name}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
