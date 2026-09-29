import { useRef, useState } from 'react';
import { Check, CheckCircle2, Copy, Plus, Upload, XCircle } from 'lucide-react';
import SettingRow, { SettingGroup } from './SettingRow';
import LoadingBar from './LoadingBar';
import {
  useDeleteSsoProvider, useOidcConfig, useSaveSsoDisplay, useSaveSsoProvider,
  type SsoKind, type SsoProvider,
} from '../hooks/useInstanceConfig';
import { useConfirm } from '../lib/confirmContext';
import { MASKED_SECRET } from '../lib/autofill';
import { ICON_CHOICES, KIND_ICON, iconLabel } from '../lib/ssoIcons';
import { SsoIcon } from './SsoIcon';
import './SsoGuide.css';

interface Kind {
  id: SsoKind;
  name: string;
  /** Where to click, in order. */
  steps: string[];
  issuerHint: string;
}

const KINDS: Kind[] = [
  {
    id: 'authentik', name: 'Authentik',
    steps: [
      'Applications → Applications → Create with provider.',
      'Choose OAuth2/OpenID. Name it Papyra, client type Confidential.',
      'Add the redirect URI below, then Finish.',
      'Keep scopes openid, email, profile and Subject mode “hashed user ID” (the defaults).',
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

/**
 * How a provider identity becomes a Papyra account — the server side is
 * OnTokenValidated in Program.cs. Worth stating: SSO never creates accounts.
 */
const ACCOUNT_RULES = [
  'Existing accounts only — SSO never creates one. Add people under Administration first.',
  'First sign-in through a provider matches its email to the Papyra account’s email, then remembers that provider’s user id (sub).',
  'No roles or groups needed: admin rights stay in Papyra.',
  'Keep sub stable, and don’t let people change their own email in the provider.',
];

const MAX_ICON_BYTES = 64 * 1024;

/**
 * The id the server will give a new provider — same rule as SsoProviders.NewId,
 * so the redirect URI can be shown before the first save.
 */
function predictId(name: string, taken: string[]): string {
  const used = new Set([...taken, 'oidc']);
  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 24) slug = slug.slice(0, 24).replace(/^-+|-+$/g, '');
  if (!slug) slug = 'sso';
  let candidate = slug;
  for (let n = 2; used.has(candidate); n++) candidate = `${slug}-${n}`;
  return candidate;
}

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
 * One provider's setup, the way GitHub walks you through an OAuth app: pick the
 * provider, do a few things there (with the values to paste right beside
 * them), paste three things back, choose how it looks, test, turn on.
 */
export function SsoGuide({ provider, taken, redirectUriPrefix, onDone }: {
  /** Editing this one; absent = adding a new provider. */
  provider?: SsoProvider;
  /** Ids already in use, to predict a new one's redirect URI. */
  taken: string[];
  redirectUriPrefix: string;
  onDone: () => void;
}) {
  const save = useSaveSsoProvider();
  const [kind, setKind] = useState<SsoKind>(provider?.kind ?? 'authentik');
  const [authority, setAuthority] = useState(provider?.authority ?? '');
  const [clientId, setClientId] = useState(provider?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [nameEdit, setName] = useState<string | null>(provider ? provider.displayName : null);
  const [hoverText, setHoverText] = useState(provider?.hoverText ?? '');
  const [icon, setIcon] = useState<string | null>(provider?.icon ?? null);
  const [iconData, setIconData] = useState<string | null>(provider?.iconData ?? null);
  const [iconError, setIconError] = useState<string | null>(null);
  const [test, setTest] = useState<null | { ok: boolean; error?: string; issuer?: string }>(null);
  const [testing, setTesting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const k = KINDS.find(x => x.id === kind) ?? KINDS[0];
  const name = nameEdit ?? (kind === 'other' ? '' : k.name);
  const redirectUri = provider?.redirectUri ?? `${redirectUriPrefix}${predictId(name, taken)}`;
  const hasSecret = !!provider?.hasClientSecret || secret.trim() !== '';
  const complete = name.trim() !== '' && authority.trim() !== '' && clientId.trim() !== '' && hasSecret;

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

  function pickFile(file: File | undefined) {
    setIconError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(file.type)) { setIconError('Use a PNG, JPEG, WebP, GIF or SVG.'); return; }
    if (file.size > MAX_ICON_BYTES) { setIconError('Keep it under 64 KB.'); return; }
    const reader = new FileReader();
    reader.onload = () => { setIconData(String(reader.result)); setIcon(null); };
    reader.readAsDataURL(file);
  }

  function store(enabled: boolean) {
    save.mutate({
      id: provider?.id,
      provider: {
        kind, displayName: name.trim(), authority: authority.trim(), clientId: clientId.trim(), enabled,
        clientSecret: secret.trim() === '' ? undefined : secret.trim(),
        icon, iconData, hoverText: hoverText.trim() || null,
      },
    }, { onSuccess: onDone });
  }

  const chosen = iconData ? 'upload' : icon ?? 'default';

  return (
    <div className="sso-guide">
      <ol className="sso-guide__steps">
        <li>
          <h3 className="sso-guide__step-title">Your provider</h3>
          <div className="settings__segment" role="radiogroup" aria-label="Identity provider">
            {KINDS.map(p => (
              <button key={p.id} type="button" role="radio" aria-checked={p.id === kind}
                className={`settings__segment-btn${p.id === kind ? ' is-active' : ''}`}
                onClick={() => { setKind(p.id); setTest(null); }}>
                {p.name}
              </button>
            ))}
          </div>
        </li>

        <li>
          <h3 className="sso-guide__step-title">In {kind === 'other' ? 'your provider' : k.name}</h3>
          <ol className="sso-guide__howto">
            {k.steps.map(step => <li key={step}>{step}</li>)}
          </ol>
          <CopyValue label="Redirect URI" value={redirectUri} />
          {!provider && <p className="settings__hint">It ends with this provider’s name — rename it below first if you want a different one.</p>}
        </li>

        <li>
          <h3 className="sso-guide__step-title">Who can sign in</h3>
          <ul className="sso-guide__howto">
            {ACCOUNT_RULES.map(rule => <li key={rule}>{rule}</li>)}
          </ul>
        </li>

        <li>
          <h3 className="sso-guide__step-title">Paste what it gives you</h3>
          <div className="settings__form">
            <label className="settings__field">Issuer URL
              <input type="url" value={authority} placeholder={k.issuerHint}
                onChange={e => { setAuthority(e.target.value); setTest(null); }} />
            </label>
            <label className="settings__field">Client ID
              <input type="text" value={clientId} onChange={e => setClientId(e.target.value)} />
            </label>
            <label className="settings__field">Client secret
              <input {...MASKED_SECRET} value={secret} placeholder={provider?.hasClientSecret ? 'Saved — leave blank to keep' : ''}
                onChange={e => setSecret(e.target.value)} />
            </label>
          </div>
        </li>

        <li>
          <h3 className="sso-guide__step-title">How it looks on the sign-in page</h3>
          <div className="settings__form">
            <label className="settings__field">Name
              <span className="sso-guide__button-preview">
                Continue with <input type="text" value={name} maxLength={40} placeholder="SSO" onChange={e => setName(e.target.value)} />
              </span>
            </label>
            <label className="settings__field">Hover text
              <input type="text" value={hoverText} maxLength={80} placeholder={`Continue with ${name || 'SSO'}`}
                onChange={e => setHoverText(e.target.value)} />
            </label>
            <div className="settings__field" role="radiogroup" aria-label="Icon">
              Icon
              <div className="sso-guide__icons">
                <button type="button" role="radio" aria-checked={chosen === 'default'} title={`Default (${iconLabel(KIND_ICON[kind])})`}
                  className={`sso-guide__icon${chosen === 'default' ? ' is-active' : ''}`}
                  onClick={() => { setIcon(null); setIconData(null); }}>
                  <SsoIcon kind={kind} size={20} />
                  <span className="sso-guide__icon-note">Default</span>
                </button>
                {ICON_CHOICES.map(key => (
                  <button key={key} type="button" role="radio" aria-checked={chosen === key} title={iconLabel(key)}
                    aria-label={iconLabel(key)}
                    className={`sso-guide__icon${chosen === key ? ' is-active' : ''}`}
                    onClick={() => { setIcon(key); setIconData(null); }}>
                    <SsoIcon kind="other" icon={key} size={20} />
                  </button>
                ))}
                <button type="button" role="radio" aria-checked={chosen === 'upload'} title="Upload your own"
                  className={`sso-guide__icon${chosen === 'upload' ? ' is-active' : ''}`}
                  onClick={() => fileRef.current?.click()}>
                  {iconData ? <SsoIcon kind={kind} iconData={iconData} size={20} /> : <Upload size={18} aria-hidden="true" />}
                  <span className="sso-guide__icon-note">Upload</span>
                </button>
                <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  onChange={e => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
              </div>
              {iconError && <span className="settings__error" role="alert">{iconError}</span>}
            </div>
          </div>
        </li>

        <li>
          <h3 className="sso-guide__step-title">Test and turn on</h3>
          <div className="settings__form">
            <div className="settings__form-actions">
              <button type="button" className="settings__btn settings__btn--quiet" disabled={!authority.trim() || testing} onClick={() => void runTest()}>
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              <button type="button" className="settings__btn" disabled={!complete || save.isPending} onClick={() => store(true)}>
                {save.isPending ? 'Saving…' : provider?.enabled ? 'Save' : 'Turn on'}
              </button>
              <button type="button" className="settings__btn settings__btn--quiet" disabled={!name.trim() || save.isPending} onClick={() => store(false)}>
                {provider?.enabled ? 'Turn off' : 'Save, keep off'}
              </button>
              <button type="button" className="settings__btn settings__btn--quiet" onClick={onDone}>Cancel</button>
            </div>
            {test && (test.ok
              ? <p className="settings__msg"><CheckCircle2 size={15} /> Found {test.issuer}</p>
              : <p className="settings__error"><XCircle size={15} /> {test.error}</p>)}
            {save.isError && <p className="settings__error">{(save.error as Error).message}</p>}
          </div>
        </li>
      </ol>
    </div>
  );
}

/**
 * Settings → SSO. The providers people can sign in with (any number), how the
 * sign-in page shows them, and a guide to add another.
 */
export default function SsoSettings() {
  const { data, isLoading, isError } = useOidcConfig();
  const saveDisplay = useSaveSsoDisplay();
  const remove = useDeleteSsoProvider();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  if (isLoading) return <LoadingBar label="Loading settings" />;
  if (isError || !data) return <p className="settings__error">Couldn’t load the SSO settings.</p>;

  const taken = data.providers.map(p => p.id);
  if (editing) {
    return (
      <SsoGuide
        key={editing}
        provider={editing === 'new' ? undefined : data.providers.find(p => p.id === editing)}
        taken={taken}
        redirectUriPrefix={data.redirectUriPrefix}
        onDone={() => setEditing(null)}
      />
    );
  }

  async function drop(p: SsoProvider) {
    if (!(await confirm({
      title: `Remove ${p.displayName}?`,
      body: 'Its button leaves the sign-in page. People keep their accounts and can still sign in any other way; adding it back links them again by email.',
      confirmLabel: 'Remove',
      destructive: true,
    }))) return;
    remove.mutate(p.id);
  }

  return (
    <>
      <SettingGroup title="Single sign-on" id="oidc"
        footer={<button type="button" className="settings__btn settings__btn--quiet" onClick={() => setEditing('new')}>
          <Plus size={15} /> Add a provider
        </button>}>
        {data.providers.length === 0 && (
          <SettingRow label="Providers" value={null} empty="None yet" hint="Authentik, Keycloak, Google, Microsoft Entra… — add as many as you like." />
        )}
        {data.providers.map(p => (
          <div key={p.id} className="setting-row"><div className="setting-row__line">
            <span className="sso-row__icon"><SsoIcon kind={p.kind} icon={p.icon} iconData={p.iconData} size={18} /></span>
            <div className="setting-row__text">
              <span className="setting-row__value">
                {p.displayName} · {p.ready ? 'On' : p.enabled ? 'Incomplete' : 'Off'}
              </span>
              <span className="setting-row__hint sso-row__uri">{p.redirectUri}</span>
            </div>
            <button type="button" className="setting-row__action" onClick={() => setEditing(p.id)}>Edit</button>
            <button type="button" className="setting-row__action" onClick={() => void drop(p)}>Remove</button>
          </div></div>
        ))}
        {data.providers.length > 0 && (
          <SettingRow label="Accounts" value="Existing only" hint="Linked by email on first sign-in, then by each provider’s user id (sub)" />
        )}
      </SettingGroup>

      {data.providers.length > 0 && (
        <SettingGroup title="On the sign-in page" id="oidc-display">
          <div className="setting-row"><div className="setting-row__line">
            <div className="setting-row__text">
              <span className="setting-row__value">{data.display === 'icons' ? 'A row of icons' : 'A button for each'}</span>
              <span className="setting-row__hint">Icons show their hover text on hover.</span>
            </div>
            <div className="settings__segment" role="radiogroup" aria-label="Show providers as">
              {(['buttons', 'icons'] as const).map(d => (
                <button key={d} type="button" role="radio" aria-checked={data.display === d}
                  className={`settings__segment-btn${data.display === d ? ' is-active' : ''}`}
                  disabled={saveDisplay.isPending}
                  onClick={() => saveDisplay.mutate(d)}>
                  {d === 'buttons' ? 'Buttons' : 'Icons'}
                </button>
              ))}
            </div>
          </div></div>
        </SettingGroup>
      )}
    </>
  );
}
