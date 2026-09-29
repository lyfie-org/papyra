import { useState } from 'react';
import { Check, CheckCircle2, Copy, XCircle } from 'lucide-react';
import SettingRow, { SettingGroup } from './SettingRow';
import LoadingBar from './LoadingBar';
import { useOidcConfig, useSaveOidcConfig } from '../hooks/useInstanceConfig';
import { MASKED_SECRET } from '../lib/autofill';
import './SsoGuide.css';

type ProviderId = 'authentik' | 'keycloak' | 'google' | 'entra' | 'other';

interface Provider {
  id: ProviderId;
  name: string;
  /** Where to click, in order, with the values to paste marked by `{redirect}`. */
  steps: string[];
  issuerHint: string;
}

const PROVIDERS: Provider[] = [
  {
    id: 'authentik', name: 'Authentik',
    steps: [
      'Applications → Applications → Create with provider.',
      'Choose OAuth2/OpenID. Name it Papyra, client type Confidential.',
      'Add the redirect URI below, then Finish.',
      'Open the provider: copy its Client ID, Client Secret and OpenID Configuration Issuer.',
    ],
    issuerHint: 'https://auth.example.com/application/o/papyra/',
  },
  {
    id: 'keycloak', name: 'Keycloak',
    steps: [
      'Clients → Create client. Type OpenID Connect, client ID papyra.',
      'Turn on Client authentication.',
      'Add the redirect URI below under Valid redirect URIs, then Save.',
      'Copy the secret from Credentials. The issuer is your realm’s URL.',
    ],
    issuerHint: 'https://keycloak.example.com/realms/your-realm',
  },
  {
    id: 'google', name: 'Google',
    steps: [
      'Google Cloud console → APIs & Services → Credentials.',
      'Create credentials → OAuth client ID → Web application.',
      'Add the redirect URI below under Authorised redirect URIs, then Create.',
      'Copy the Client ID and secret. The issuer is always https://accounts.google.com.',
    ],
    issuerHint: 'https://accounts.google.com',
  },
  {
    id: 'entra', name: 'Microsoft Entra',
    steps: [
      'Entra admin center → App registrations → New registration.',
      'Platform Web, with the redirect URI below. Register.',
      'Certificates & secrets → New client secret; copy its Value.',
      'From Overview, copy the Application (client) ID and Directory (tenant) ID.',
    ],
    issuerHint: 'https://login.microsoftonline.com/your-tenant-id/v2.0',
  },
  {
    id: 'other', name: 'Other',
    steps: [
      'Create an OpenID Connect app (confidential / web).',
      'Add the redirect URI below. Scopes: openid, email, profile.',
      'Copy the client ID, client secret and issuer URL.',
    ],
    issuerHint: 'https://login.example.com',
  },
];

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="sso-guide__copy">
      <span className="sso-guide__copy-label">{label}</span>
      <code>{value}</code>
      <button type="button" className="sso-guide__copy-btn" aria-label={`Copy ${label}`}
        onClick={() => void navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => undefined)}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/**
 * Settings → SSO as a short guide, the way GitHub walks you through an OAuth
 * app: pick your provider, do three things there (with the values to paste
 * right beside them), paste three things back, test, turn on.
 */
export function SsoGuide({ onDone }: { onDone?: () => void }) {
  const { data, isLoading, isError } = useOidcConfig();
  const save = useSaveOidcConfig();

  const [providerEdit, setProvider] = useState<ProviderId | null>(null);
  const [authorityEdit, setAuthority] = useState<string | null>(null);
  const [clientIdEdit, setClientId] = useState<string | null>(null);
  const [displayNameEdit, setDisplayName] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [test, setTest] = useState<null | { ok: boolean; error?: string; issuer?: string }>(null);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const authority = authorityEdit ?? data?.authority ?? '';
  const clientId = clientIdEdit ?? data?.clientId ?? '';
  const provider = PROVIDERS.find(p => p.id === (providerEdit ?? guess(authority))) ?? PROVIDERS[0];
  const displayName = displayNameEdit ?? (data?.displayName || (provider.id === 'other' ? '' : provider.name));
  const hasSecret = !!data?.hasClientSecret || secret.trim() !== '';
  const complete = authority.trim() !== '' && clientId.trim() !== '' && hasSecret;

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const res = await fetch('/api/auth/oidc/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ authority }),
      });
      setTest(await res.json());
    } catch {
      setTest({ ok: false, error: 'Couldn’t reach this Papyra.' });
    } finally {
      setTesting(false);
    }
  }

  function store(enabled: boolean) {
    setSaved(null);
    save.mutate(
      { enabled, authority: authority.trim(), clientId: clientId.trim(), displayName: displayName.trim(), clientSecret: secret.trim() === '' ? undefined : secret.trim() },
      { onSuccess: () => { setSecret(''); setSaved(enabled ? 'On — the sign-in page shows the button.' : 'Saved. SSO is off.'); onDone?.(); } },
    );
  }

  if (isLoading) return <LoadingBar label="Loading settings" />;
  if (isError || !data) return <p className="settings__error">Couldn’t load the SSO settings.</p>;

  return (
    <div className="sso-guide">
      {data.ready && data.enabled && (
        <p className="settings__msg"><CheckCircle2 size={15} /> SSO is on: “Continue with {data.displayName || 'SSO'}”.</p>
      )}

      <ol className="sso-guide__steps">
        <li>
          <h3 className="sso-guide__step-title">Your provider</h3>
          <div className="settings__segment" role="radiogroup" aria-label="Identity provider">
            {PROVIDERS.map(p => (
              <button key={p.id} type="button" role="radio" aria-checked={p.id === provider.id}
                className={`settings__segment-btn${p.id === provider.id ? ' is-active' : ''}`}
                onClick={() => setProvider(p.id)}>
                {p.name}
              </button>
            ))}
          </div>
        </li>

        <li>
          <h3 className="sso-guide__step-title">In {provider.id === 'other' ? 'your provider' : provider.name}</h3>
          <ol className="sso-guide__howto">
            {provider.steps.map(step => <li key={step}>{step}</li>)}
          </ol>
          <CopyValue label="Redirect URI" value={data.redirectUri} />
        </li>

        <li>
          <h3 className="sso-guide__step-title">Paste what it gives you</h3>
          <div className="settings__form">
            <label className="settings__field">Issuer URL
              <input type="url" value={authority} placeholder={provider.issuerHint}
                onChange={e => { setAuthority(e.target.value); setTest(null); }} />
            </label>
            <label className="settings__field">Client ID
              <input type="text" value={clientId} onChange={e => setClientId(e.target.value)} />
            </label>
            <label className="settings__field">Client secret
              <input {...MASKED_SECRET} value={secret} placeholder={data.hasClientSecret ? 'Saved — leave blank to keep' : ''}
                onChange={e => setSecret(e.target.value)} />
            </label>
          </div>
        </li>

        <li>
          <h3 className="sso-guide__step-title">Test and turn on</h3>
          <div className="settings__form">
            <label className="settings__field">Button text
              <span className="sso-guide__button-preview">
                Continue with <input type="text" value={displayName} placeholder="SSO" onChange={e => setDisplayName(e.target.value)} />
              </span>
            </label>
            <div className="settings__form-actions">
              <button type="button" className="settings__btn settings__btn--quiet" disabled={!authority.trim() || testing} onClick={() => void runTest()}>
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              <button type="button" className="settings__btn" disabled={!complete || save.isPending} onClick={() => store(true)}>
                {save.isPending ? 'Saving…' : data.enabled ? 'Save' : 'Turn on SSO'}
              </button>
              {data.enabled && (
                <button type="button" className="settings__btn settings__btn--quiet" disabled={save.isPending} onClick={() => store(false)}>Turn off</button>
              )}
              {onDone && <button type="button" className="settings__btn settings__btn--quiet" onClick={onDone}>Cancel</button>}
            </div>
            {test && (test.ok
              ? <p className="settings__msg"><CheckCircle2 size={15} /> Found {test.issuer}</p>
              : <p className="settings__error"><XCircle size={15} /> {test.error}</p>)}
            {saved && <p className="settings__msg"><CheckCircle2 size={15} /> {saved}</p>}
            {save.isError && <p className="settings__error">{(save.error as Error).message}</p>}
          </div>
        </li>
      </ol>
    </div>
  );
}

// Pick the tab that matches a saved issuer, so reopening the page shows the right steps.
function guess(authority: string): ProviderId {
  const a = authority.toLowerCase();
  if (a.includes('/application/o/')) return 'authentik';
  if (a.includes('/realms/')) return 'keycloak';
  if (a.includes('accounts.google.com')) return 'google';
  if (a.includes('login.microsoftonline.com')) return 'entra';
  return authority ? 'other' : 'authentik';
}

/**
 * Settings → SSO. Configured: what's set, and Edit. Not yet: one button that
 * opens the guide.
 */
export default function SsoSettings() {
  const { data, isLoading, isError } = useOidcConfig();
  const [editing, setEditing] = useState(false);
  if (isLoading) return <LoadingBar label="Loading settings" />;
  if (isError || !data) return <p className="settings__error">Couldn’t load the SSO settings.</p>;
  if (editing) return <SsoGuide onDone={() => setEditing(false)} />;

  const configured = !!(data.authority || data.clientId);
  if (!configured) {
    return (
      <SettingGroup title="Single sign-on" id="oidc"
        footer={<button type="button" className="settings__btn" onClick={() => setEditing(true)}>Set up single sign-on</button>}>
        <SettingRow label="Status" value={null} empty="Not set up" hint="Authentik, Keycloak, Google, Microsoft Entra…" />
      </SettingGroup>
    );
  }
  return (
    <SettingGroup title="Single sign-on" id="oidc"
      footer={<button type="button" className="settings__btn settings__btn--quiet" onClick={() => setEditing(true)}>Edit</button>}>
      <SettingRow label="Status" value={data.enabled && data.ready ? 'On' : 'Off'} />
      <SettingRow label="Sign-in button" value={`Continue with ${data.displayName || 'SSO'}`} />
      <SettingRow label="Issuer" value={data.authority} />
      <SettingRow label="Client ID" value={data.clientId} hint={data.hasClientSecret ? 'Client secret saved' : 'No client secret'} />
      <SettingRow label="Redirect URI" value={data.redirectUri} />
    </SettingGroup>
  );
}
