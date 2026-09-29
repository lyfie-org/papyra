import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  User as UserIcon, Palette, Database, Info, Camera,
  Sun, Moon, Monitor, Upload, Download, KeyRound, Copy, Trash2, Lock, ShieldAlert,
  Fingerprint, CheckCircle2, GitBranch, AlertTriangle, Bell, Mail, KeySquare, Send, UserPlus,
  Sparkles, Play, Cog, LockOpen, Eye, LogOut, X, Users,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { useDismiss } from '../hooks/useDismiss';
import { useGitConfig, useSaveGitConfig } from '../hooks/useGitSync';
import {
  useSmtpConfig, useSaveSmtpConfig,
  useSendTestEmail, useInviteUser,
} from '../hooks/useInstanceConfig';
import NotificationSettings from '../components/NotificationSettings';
import UsersPanel from './ManageUsersPage';
import GitSetupGuide from '../components/GitSetupGuide';
import {
  useAiConfig, useSaveAiConfig, useAiStatus, useAiModels, usePullModel,
  type AiConfig, type PullProgress,
} from '../hooks/useAi';
import { useWebAuthnDevices } from '../hooks/useWebAuthnDevices';
import { useVault } from '../hooks/useVault';
import VaultUnlock from '../components/VaultUnlock';
import VaultPinForm from '../components/VaultPinForm';
import { parseUtc } from '../lib/vault';
import { useJobs, useRunJob, type Job } from '../hooks/useJobs';
import {
  choiceFor, endpointLabel, friendlyModelName, providerLabel, sameModel,
} from '../lib/aiModels';
import { hasPlatformAuthenticator, isWebAuthnAvailable } from '../lib/webauthn';
import { useAuth, type AuthUser } from '../hooks/useAuth';
import { useNotes } from '../hooks/useNotes';
import { useTheme, type ThemePreference } from '../hooks/useTheme';
import { setAlwaysShowEditorToolbar, useAlwaysShowEditorToolbar } from '../hooks/useEditorToolbar';
import { clearSessionData } from '../lib/session';
import { AI_ENABLED } from '../lib/features';
import { useConfirm } from '../lib/confirmContext';
import { useToast } from '../lib/toastContext';
import AvatarCropper from '../components/AvatarCropper';
import KnowledgeHeatmap from '../components/KnowledgeHeatmap';
import DayNotesOverlay from '../components/DayNotesOverlay';
import Avatar from '../components/Avatar';
import { bumpAvatarVersion, useAvatarVersion } from '../lib/avatarVersion';
import { useSettings, useUpdateSettings, RETENTION_OPTIONS } from '../hooks/useSettings';
import { useImportStatus, importSummary, IMPORT_STATUS_KEY, type ImportStatus } from '../hooks/useImportStatus';
import './SettingsPage.css';
import LoadingBar from '../components/LoadingBar';
import AboutPanel from '../components/AboutPanel';
import ExportDialog from '../components/ExportDialog';
import DeleteAccountSection from '../components/DeleteAccountSection';
import CodeField from '../components/CodeField';
import { requestEmailCode } from '../lib/emailCode';
import SsoSettings from '../components/SsoGuide';
import AccountDetails from '../components/AccountDetails';
import SettingRow, { SettingGroup } from '../components/SettingRow';
import SessionsSection from '../components/SessionsSection';
import AuthenticatorSection from '../components/AuthenticatorSection';
import { fetchWithProgress } from '../lib/progress';
import { MASKED_SECRET, NO_AUTOFILL } from '../lib/autofill';

type Tab = 'profile' | 'appearance' | 'notifications' | 'security' | 'data' | 'keys' | 'sync'
  | 'users' | 'sso' | 'email' | 'ai' | 'jobs' | 'about';

// Two groups. The first is yours — it changes what happens to you, and everyone
// sees it. "Administration" changes the whole instance and only admins see it;
// the heading keeps the two from reading as the same kind of setting.
const NAV: { id: Tab; label: string; icon: typeof UserIcon; adminOnly?: boolean }[] = [
  { id: 'profile', label: 'Profile', icon: UserIcon },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'security', label: 'Security', icon: Fingerprint },
  { id: 'data', label: 'Data & Storage', icon: Database },
  { id: 'keys', label: 'API Keys', icon: KeyRound },
  { id: 'sync', label: 'Backup', icon: GitBranch },
  { id: 'about', label: 'About', icon: Info },
  { id: 'users', label: 'Users', icon: Users, adminOnly: true },
  { id: 'sso', label: 'SSO', icon: KeySquare, adminOnly: true },
  { id: 'email', label: 'Email', icon: Mail, adminOnly: true },
  { id: 'ai', label: 'AI', icon: Sparkles, adminOnly: true },
  { id: 'jobs', label: 'Jobs', icon: Cog, adminOnly: true },
];

// The AI tab is hidden while the assistant is held back for a later release.
// Filtering here also closes the back door: `?tab=ai` is no longer a valid tab,
// so the panel cannot be reached by typing the URL.
const VISIBLE_NAV = NAV.filter(n => n.id !== 'ai' || AI_ENABLED);

/**
 * Scrolls to the heading named by `?s=`, so a search result can land on one
 * section rather than the top of a long tab.
 *
 * Several tabs render a "Loading…" placeholder while their config arrives, so
 * the heading often does not exist on the first paint. Retry across a few frames
 * instead of giving up, and stop once found or once the budget runs out.
 */
function useScrollToSection(section: string | null, tab: Tab) {
  useEffect(() => {
    if (!section) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    const settle = () => {
      const el = document.getElementById(section);
      if (!el) return;
      el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      // Move focus too, so a keyboard or screen-reader user arrives where the
      // sighted user is looking. Headings aren't focusable by default.
      el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
    };

    settle();
    // A tab that is still fetching renders a placeholder, so the heading often
    // does not exist yet — and when its real content lands, the panel grows and
    // throws away whatever scroll position we had. Re-aim on every DOM change
    // for a few seconds rather than scrolling once and hoping.
    const observer = new MutationObserver(settle);
    observer.observe(document.body, { childList: true, subtree: true });
    const stop = setTimeout(() => observer.disconnect(), 5000);

    return () => { observer.disconnect(); clearTimeout(stop); };
  }, [section, tab]);
}

export default function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') as Tab | null;
  const valid = VISIBLE_NAV.find(n => n.id === requested && (!n.adminOnly || isAdmin));
  const tab: Tab = valid?.id ?? 'profile';
  // Clearing `s` on a manual tab click stops a stale section from being chased
  // after the user has navigated somewhere else themselves.
  // (The desk scrolls back to the top on its own: the tab is in the URL, and a
  // new URL is a new page — see DeskScrollReset.)
  const setTab = (t: Tab) => setParams(t === 'profile' ? {} : { tab: t }, { replace: true });
  useScrollToSection(params.get('s'), tab);

  // On a phone the sections are one swipeable row; keep the active pill in
  // view (scrollLeft only — scrollIntoView would also scroll the page).
  const railRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const rail = railRef.current;
    const active = rail?.querySelector<HTMLElement>('.is-active');
    if (!rail || !active || rail.scrollWidth <= rail.clientWidth) return;
    rail.scrollTo({ left: active.offsetLeft - (rail.clientWidth - active.offsetWidth) / 2, behavior: 'smooth' });
  }, [tab]);

  return (
    <section className="settings">
      <div className="settings__shell">
        <div className="settings__side">
          <h1 className="page-title settings__title">Settings</h1>
          <nav className="settings__rail" aria-label="Settings sections" ref={railRef}>
            {VISIBLE_NAV.filter(n => !n.adminOnly).map(item => (
              <RailItem key={item.id} item={item} active={tab === item.id} onSelect={setTab} />
            ))}
            {isAdmin && (
              <>
                <p className="settings__rail-group" aria-hidden="true">Administration</p>
                {VISIBLE_NAV.filter(n => n.adminOnly).map(item => (
                  <RailItem key={item.id} item={item} active={tab === item.id} onSelect={setTab} />
                ))}
              </>
            )}
          </nav>
        </div>

        <div className="settings__content">
          {tab === 'profile' && <ProfileTab user={user} />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'security' && <SecurityTab />}
          {tab === 'data' && <DataTab />}
          {tab === 'keys' && <KeysTab />}
          {tab === 'sync' && <SyncTab />}
          {tab === 'users' && isAdmin && <UsersPanel />}
          {tab === 'sso' && isAdmin && <SsoTab />}
          {tab === 'email' && isAdmin && <EmailTab />}
          {tab === 'ai' && isAdmin && AI_ENABLED && <AiTab />}
          {tab === 'jobs' && isAdmin && <JobsTab />}
          {tab === 'about' && <AboutPanel />}
        </div>
      </div>
    </section>
  );
}

function RailItem({ item, active, onSelect }: {
  item: (typeof NAV)[number]; active: boolean; onSelect: (t: Tab) => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      className={`settings__rail-item${active ? ' is-active' : ''}`}
      aria-current={active}
      onClick={() => onSelect(item.id)}
    >
      <Icon size={17} /> {item.label}
    </button>
  );
}

/** The profile photo at full size, over a scrim. Click anywhere or Escape to close. */
function PhotoViewer({ name, onClose }: { name: string; onClose: () => void }) {
  const avatarVersion = useAvatarVersion();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="photo-viewer" role="dialog" aria-modal="true" aria-label={`${name}’s photo`} onClick={onClose}>
      {/* The same URL the profile's <Avatar> loads, so it is the same picture:
          a different query string was a different cache entry, and it could
          hold a previous upload. */}
      <img className="photo-viewer__img" src={avatarVersion ? `/api/auth/avatar?v=${avatarVersion}` : '/api/auth/avatar'} alt={`${name}’s profile photo`} />
      <button type="button" className="photo-viewer__close" aria-label="Close" autoFocus onClick={onClose}>
        <X size={20} />
      </button>
    </div>,
    document.body,
  );
}

// ── Profile ───────────────────────────────────────────────────────────────────
function ProfileTab({ user }: { user: AuthUser | null }) {
  const { data: notes } = useNotes();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  const avatarVersion = useAvatarVersion();
  // Whether there is a picture to remove. Probed rather than stored: the avatar
  // file is the source of truth, and it changes under us on upload/remove.
  const { data: hasPhoto } = useQuery({
    queryKey: ['avatar-exists', user?.id, avatarVersion],
    queryFn: async () => (await fetch(`/api/auth/avatar?v=${avatarVersion}`)).ok,
    enabled: !!user,
  });
  // The file the user picked, held while they frame it. Nothing is uploaded
  // until they say the crop is right.
  const [picking, setPicking] = useState<File | null>(null);
  // The photo's own menu (view / change / remove) and the full-size view.
  const [photoMenu, setPhotoMenu] = useState(false);
  const [viewing, setViewing] = useState(false);
  const photoMenuRef = useRef<HTMLDivElement | null>(null);
  useDismiss(photoMenuRef, photoMenu, () => setPhotoMenu(false));
  // The day whose notes are on screen. State, not a route and not a filter:
  // looking at what you wrote on a Tuesday should not move you anywhere.
  const [openDay, setOpenDay] = useState<string | null>(null);


  const noteCount = notes?.filter(n => !n.trashed).length ?? 0;
  const tagCount = new Set((notes ?? []).flatMap(n => n.tags ?? [])).size;

  async function removePhoto() {
    setPhotoMsg(null);
    const res = await fetch('/api/auth/avatar', { method: 'DELETE' });
    if (res.ok) bumpAvatarVersion();
    else setPhotoMsg('Couldn’t remove the photo.');
  }

  // The cropper hands back a square PNG; the file the user picked never leaves
  // the browser as-is, so what is stored is what they framed.
  async function uploadAvatar(square: Blob) {
    const form = new FormData();
    form.append('file', square, 'avatar.png');
    const res = await fetchWithProgress('/api/auth/avatar', { method: 'POST', body: form });
    if (!res.ok) {
      // Keep the cropper open so the framing isn't lost; let it show the error.
      const data = await res.json().catch(() => null);
      throw new Error(data?.error ?? 'upload failed');
    }
    setPicking(null);
    setPhotoMsg(null);
    bumpAvatarVersion();
  }


  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    await clearSessionData(queryClient);
    queryClient.setQueryData(['auth'], { state: 'login', user: null });
    navigate('/login', { replace: true });
  }

  return (
    <div className="settings__panel">
      <section className="profile-hero" aria-label="Your profile">
        <div className="profile-hero__photo-wrap" ref={photoMenuRef}>
          <button
            type="button"
            className="profile-hero__photo"
            onClick={() => (hasPhoto ? setPhotoMenu(o => !o) : fileRef.current?.click())}
            aria-label={hasPhoto ? 'Profile photo options' : 'Add a profile photo'}
            aria-haspopup={hasPhoto ? 'menu' : undefined}
            aria-expanded={hasPhoto ? photoMenu : undefined}
          >
            <Avatar name={user?.name || user?.username} size={120} />
            <span className="profile-hero__overlay" aria-hidden="true">
              <Camera size={20} />
              <span>{hasPhoto ? 'Edit' : 'Add photo'}</span>
            </span>
          </button>
          {photoMenu && hasPhoto && (
            <div className="profile-hero__menu" role="menu" aria-label="Profile photo">
              <button type="button" role="menuitem" className="profile-hero__menu-item"
                onClick={() => { setPhotoMenu(false); setViewing(true); }}>
                <Eye size={15} /> View photo
              </button>
              <button type="button" role="menuitem" className="profile-hero__menu-item"
                onClick={() => { setPhotoMenu(false); fileRef.current?.click(); }}>
                <Camera size={15} /> Change photo
              </button>
              <button type="button" role="menuitem" className="profile-hero__menu-item profile-hero__menu-item--danger"
                onClick={() => { setPhotoMenu(false); void removePhoto(); }}>
                <Trash2 size={15} /> Remove photo
              </button>
            </div>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) setPicking(f);
            // Clear it, or choosing the same file twice fires no change event.
            e.target.value = '';
          }}
        />
        {picking && (
          <AvatarCropper
            file={picking}
            onCancel={() => setPicking(null)}
            onCropped={square => uploadAvatar(square)}
          />
        )}
        {viewing && <PhotoViewer name={user?.name || user?.username || ''} onClose={() => setViewing(false)} />}
        <div className="profile-hero__who">
          <h1 className="profile-hero__name">{user?.name || user?.username}</h1>
          <p className="profile-hero__handle">
            @{user?.username}
            <span className="profile-hero__role">{user?.role}</span>
          </p>
          {photoMsg && <p className="settings__error" role="alert">{photoMsg}</p>}
        </div>
        {/* Up here, apart from every form below: a stray click near "Update
            password" used to land on it and end the session. */}
        <button type="button" className="profile-hero__signout" onClick={() => void logout()}>
          <LogOut size={15} /> Sign out
        </button>
      </section>

      <div className="settings__stats">
        <div className="settings__stat"><span className="settings__stat-num">{noteCount}</span> notes</div>
        <div className="settings__stat"><span className="settings__stat-num">{tagCount}</span> tags</div>
      </div>

      <h2 id="activity" className="settings__subhead">Your writing, day by day</h2>
      <p className="settings__hint">Notes changed per day, last six months. Pick a day to see them.</p>
      <KnowledgeHeatmap selectedDay={openDay} onSelectDay={setOpenDay} />
      {openDay && (
        <DayNotesOverlay
          day={openDay}
          notes={(notes ?? []).filter(n => !n.trashed && n.updated.slice(0, 10) === openDay)}
          onClose={() => setOpenDay(null)}
        />
      )}

      <AccountDetails user={user} />

    </div>
  );
}

// ── Appearance ──────────────────────────────────────────────────────────────────
function AppearanceTab() {
  const { preference, setPreference } = useTheme();
  const alwaysShowToolbar = useAlwaysShowEditorToolbar();
  const options: { id: ThemePreference; label: string; icon: typeof Sun }[] = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'system', label: 'System', icon: Monitor },
  ];
  return (
    <div className="settings__panel">
      <h2 id="theme" className="settings__subhead">Theme</h2>
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

      <h2 id="formatting-toolbar" className="settings__subhead">Formatting toolbar</h2>
      <p className="settings__hint">Formatting tools above each note.</p>
      <label className="settings__field settings__field--inline">
        <input
          type="checkbox" role="switch" className="switch"
          checked={alwaysShowToolbar}
          onChange={e => setAlwaysShowEditorToolbar(e.target.checked)}
        />
        Always show the formatting toolbar
      </label>
    </div>
  );
}

// ── Security (vault PIN + biometric devices) ────────────────────────────────────
// Locked notes open with the vault PIN, which every vault must have; a device's
// built-in authenticator (Touch ID, Face ID, Windows Hello) is an optional
// shortcut on top. Adding or removing a device needs the vault open, so a
// borrowed session cannot quietly add its own fingerprint.
function SecurityTab() {
  const confirm = useConfirm();
  const { user } = useAuth();
  const { status, open, lock } = useVault();
  const { devices, enroll, revoke, enrolling, error, setError } = useWebAuthnDevices();
  const [name, setName] = useState('');
  const [addingDevice, setAddingDevice] = useState(false);
  // Whether this machine actually offers Touch ID / Windows Hello, so we can
  // explain an unavailable button instead of just disabling it.
  const [platformAvailable, setPlatformAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void hasPlatformAuthenticator().then(ok => { if (!cancelled) setPlatformAvailable(ok); });
    return () => { cancelled = true; };
  }, []);

  const s = status.data;
  const pinSet = !!s?.pinSet;
  const bio = s?.biometric;
  // The server knows why this address can't do biometrics (an IP, plain http);
  // the browser only knows whether it has the API.
  const problem = bio?.problem?.message
    ?? (!isWebAuthnAvailable() ? 'This browser can’t use biometric keys here. It needs HTTPS (or localhost).' : null);
  const canAddDevice = pinSet && !problem;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await enroll(name);
    if (ok) { setName(''); setAddingDevice(false); }
  }

  async function remove(device: { id: number; name: string }) {
    if (!(await confirm({
      title: 'Remove this passkey?',
      body: `“${device.name}” will no longer sign you in or unlock your vault. You can add it again later.`,
      confirmLabel: 'Remove',
      destructive: true,
    }))) return;
    await revoke(device.id);
  }

  return (
    <div className="settings__panel">
      {/* The whole picture in one line, so four kinds of "prove it's you" read as one plan. */}
      <p className="settings__hint">
        {user?.twoFactorLogin
          ? 'You sign in with your password and a code from your authenticator app. Sensitive changes ask for that code too.'
          : 'You sign in with your password. Sensitive changes ask for a code from your authenticator app.'}
        {' '}Locked notes open with your PIN.
      </p>

      <AuthenticatorSection />

      <SettingGroup
        title="Passkeys"
        id="biometric-unlock"
        footer={canAddDevice && !addingDevice && (
          <button type="button" className="settings__btn settings__btn--quiet" onClick={() => { setError(null); setAddingDevice(true); }}>
            <Fingerprint size={15} /> Add this device
          </button>
        )}
      >
        {devices.isLoading && <div className="setting-row"><div className="setting-row__line"><LoadingBar label="Loading devices" /></div></div>}
        {(devices.data ?? []).map(d => (
          <div key={d.id} className="setting-row">
            <div className="setting-row__line">
              <div className="setting-row__text">
                <span className="setting-row__value">
                  {d.name}{bio?.rpId && (d.rpId === bio.rpId || !d.rpId) && <span className="sessions__here"> · this address</span>}
                </span>
                <span className="setting-row__hint">
                  {d.rpId || 'any address'} · added {parseUtc(d.createdUtc).toLocaleDateString()}
                  {d.lastUsedUtc ? ` · last used ${parseUtc(d.lastUsedUtc).toLocaleDateString()}` : ''}
                </span>
              </div>
              <button type="button" className="setting-row__action" disabled={!open}
                title={open ? undefined : 'Unlock your vault to remove a passkey'} onClick={() => void remove(d)}>
                Remove
              </button>
            </div>
          </div>
        ))}
        {devices.data && devices.data.length === 0 && !addingDevice && (
          <div className="setting-row"><div className="setting-row__line"><div className="setting-row__text">
            <span className="setting-row__value is-empty">No passkeys</span>
            <span className="setting-row__hint">
              {!pinSet ? 'Set a locked-notes PIN first.' : problem ?? 'Sign in and unlock with Touch ID, Face ID or Windows Hello.'}
            </span>
          </div></div></div>
        )}
        {addingDevice && (
          <div className="setting-row is-open"><div className="setting-row__editor setting-row__editor--solo">
            {!open ? (
              <div className="settings__vault-unlock">
                <p className="settings__hint">Unlock your vault first.</p>
                <VaultUnlock onUnlocked={() => setError(null)} />
              </div>
            ) : (
              <form className="settings__form" onSubmit={submit}>
                {platformAvailable === false && (
                  <p className="settings__hint settings__hint--warn">
                    <ShieldAlert size={15} /><span>No built-in sensor found — a security key works too.</span>
                  </p>
                )}
                <label className="settings__field">Name
                  <input placeholder="e.g. Work laptop" value={name} maxLength={60} autoFocus disabled={enrolling}
                    onChange={e => { setName(e.target.value); setError(null); }} />
                </label>
                <div className="settings__form-actions">
                  <button type="submit" className="settings__btn" disabled={enrolling}>
                    <Fingerprint size={16} /> {enrolling ? 'Waiting for your device…' : 'Add'}
                  </button>
                  <button type="button" className="settings__btn settings__btn--quiet" onClick={() => setAddingDevice(false)}>Cancel</button>
                </div>
              </form>
            )}
            {error && <p className="settings__error" role="alert">{error}</p>}
          </div></div>
        )}
      </SettingGroup>

      <SettingGroup title="Locked notes" id="vault-pin">
        {status.isLoading && <div className="setting-row"><div className="setting-row__line"><LoadingBar label="Loading" /></div></div>}
        {s && (
          <SettingRow
            label="PIN"
            value={s.pinDisabled ? 'Switched off after too many wrong tries' : pinSet ? '••••••' : null}
            empty="Not set"
            hint={pinSet ? 'Opens locked notes. Separate from your password.' : undefined}
            action={pinSet && !s.pinDisabled ? 'Change' : 'Set up'}
          >
            {close => (
              <>
                <VaultPinForm onDone={close} />
                <div className="settings__form-actions">
                  <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Cancel</button>
                </div>
              </>
            )}
          </SettingRow>
        )}
        {pinSet && open && (
          <div className="setting-row"><div className="setting-row__line">
            <div className="setting-row__text">
              <span className="setting-row__value"><LockOpen size={14} /> Vault open on this device</span>
            </div>
            <button type="button" className="setting-row__action" onClick={() => void lock()}>Lock now</button>
          </div></div>
        )}
      </SettingGroup>

      <SessionsSection />

      <DeleteAccountSection />
    </div>
  );
}

// ── Data & Storage ───────────────────────────────────────────────────────────────
function DataTab() {
  const { data: settings, isLoading } = useSettings();
  const update = useUpdateSettings();
  const [provider, setProvider] = useState<'obsidian' | 'keep'>('obsidian');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const importRef = useRef<HTMLInputElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const queryClient = useQueryClient();
  // Server-tracked, so the bar is back when this tab remounts mid-import.
  const { data: importStatus } = useImportStatus();
  const importing = uploading || (!!importStatus && !importStatus.done);

  async function runImport(file: File) {
    setUploading(true);
    setImportMsg('Uploading…');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetchWithProgress(`/api/import/${provider}`, {
        method: 'POST', body: form,
        onProgress: (f) => setImportMsg(`Uploading… ${Math.round(f * 100)}%`),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        queryClient.setQueryData(IMPORT_STATUS_KEY, data as ImportStatus);
        setImportMsg(null);
      } else {
        setImportMsg(data?.error ?? 'Import failed.');
        // 409: one is already running — pick its bar up.
        if (res.status === 409) void queryClient.invalidateQueries({ queryKey: IMPORT_STATUS_KEY });
      }
    } finally {
      setUploading(false);
      if (importRef.current) importRef.current.value = '';
    }
  }

  const pct = importStatus && importStatus.total > 0
    ? Math.round((importStatus.processed / importStatus.total) * 100) : 0;

  return (
    <div className="settings__panel">
      <h2 id="import" className="settings__subhead">Import</h2>
      <p className="settings__hint">Re-importing never duplicates notes.</p>
      <div className="settings__row">
        <select className="settings__select" disabled={importing}
          value={importStatus && !importStatus.done ? importStatus.provider : provider}
          onChange={e => setProvider(e.target.value as 'obsidian' | 'keep')}>
          <option value="obsidian">Obsidian vault (.zip)</option>
          <option value="keep">Google Keep (.zip)</option>
        </select>
        <button type="button" className="settings__btn" disabled={importing}
          title={importing ? 'An import is already running' : undefined}
          onClick={() => importRef.current?.click()}>
          <Upload size={16} /> Choose archive
        </button>
        <input ref={importRef} type="file" accept=".zip" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) void runImport(f); }} />
      </div>
      {importStatus && !importStatus.done && (
        <div className="settings__import-progress" role="status">
          <div
            className="settings__progress-bar"
            role="progressbar"
            aria-label="Import progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            style={{ '--pct': `${pct}%` } as React.CSSProperties}
          />
          <span>
            {importStatus.total > 0
              ? `Importing ${importStatus.provider === 'keep' ? 'Google Keep' : 'Obsidian'} notes… ${importStatus.processed} of ${importStatus.total}`
              : 'Import queued…'}
          </span>
        </div>
      )}
      {importMsg && <p className="settings__msg">{importMsg}</p>}
      {!importMsg && importStatus?.done && <p className="settings__msg" role="status">{importSummary(importStatus)}</p>}

      <h2 id="export" className="settings__subhead">Export</h2>
      <p className="settings__hint">Every note as a zip of plain Markdown files.</p>
      <button type="button" className="settings__btn" onClick={() => setExporting(true)}>
        <Download size={16} /> Export all notes
      </button>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}

      <EncryptedBackupSection />

      <h2 id="trash-retention" className="settings__subhead">Trash auto-delete</h2>
      <p className="settings__hint">“Delete immediately” can’t be undone.</p>
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
  const confirm = useConfirm();
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
    if (!(await confirm({
      title: 'Restore this backup?',
      body: 'Every note and file you have now is replaced by the contents of the backup. Anything not in the backup is lost, and this cannot be undone.',
      confirmLabel: 'Replace everything',
      destructive: true,
    }))) return;
    setRestoreMsg('Restoring…');
    setRestoreBusy(true);
    try {
      const form = new FormData();
      form.append('password', restorePw);
      form.append('file', file);
      const res = await fetchWithProgress('/api/backups/restore', { method: 'POST', body: form });
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
    <SettingGroup title="Encrypted backup" id="encrypted-backup">
      <SettingRow label="Download" value="A sealed copy of every note and file" hint="Locked with your account password" action="Download">
        {close => (
          <form className="settings__form" onSubmit={async e => { await generate(e); }}>
            <label className="settings__field">Your password
              <input type="password" autoComplete="current-password" autoFocus value={exportPw}
                onChange={e => setExportPw(e.target.value)} required />
            </label>
            <p className="settings__hint">Lose the password and the backup can’t be opened.</p>
            {exportMsg && <p className="settings__msg">{exportMsg}</p>}
            <div className="settings__form-actions">
              <button type="submit" className="settings__btn" disabled={exportBusy || !exportPw}>
                <Lock size={16} /> {exportBusy ? 'Encrypting…' : 'Download'}
              </button>
              <button type="button" className="settings__btn settings__btn--quiet" onClick={() => { setExportMsg(null); close(); }}>Done</button>
            </div>
          </form>
        )}
      </SettingRow>
      <SettingRow label="Restore" value="Replace everything with a backup" action="Restore…" id="restore-backup">
        {close => (
          <div className="settings__form">
            <p className="settings__hint settings__hint--warn">
              <ShieldAlert size={15} />
              {/* One text run: the row is flex, so bare text and <strong> would split into columns. */}
              <span>Replaces <strong>all</strong> your notes and attachments.</span>
            </p>
            <label className="settings__field">The backup’s password
              <input {...MASKED_SECRET} autoFocus value={restorePw} onChange={e => setRestorePw(e.target.value)} />
            </label>
            {restoreMsg && <p className="settings__msg">{restoreMsg}</p>}
            <div className="settings__form-actions">
              <button type="button" className="settings__btn" disabled={restoreBusy || !restorePw}
                onClick={() => restoreRef.current?.click()}>
                <Upload size={16} /> Choose backup file
              </button>
              <button type="button" className="settings__btn settings__btn--quiet" onClick={() => { setRestoreMsg(null); close(); }}>Done</button>
            </div>
            <input ref={restoreRef} type="file" accept=".papyra-vault" hidden
              onChange={e => { const f = e.target.files?.[0]; if (f) void restore(f); e.target.value = ''; }} />
          </div>
        )}
      </SettingRow>
    </SettingGroup>
  );
}

// ── API Keys ──────────────────────────────────────────────────────────────────────
interface ApiKeyRow { id: number; name: string; prefix: string; createdUtc: string; lastUsedUtc: string | null }

function KeysTab() {
  const confirm = useConfirm();
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
  // A key reads and writes everything: the server asks for a code first.
  const { user } = useAuth();
  const [askCode, setAskCode] = useState(false);
  const [code, setCode] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, code }),
    });
    const data = await res.json().catch(() => null);
    setCode('');
    if (!res.ok) { setKeyError(data?.error ?? 'Couldn’t create the key.'); return; }
    setCreated(data.token);
    setName('');
    setAskCode(false);
    await queryClient.invalidateQueries({ queryKey: ['apiKeys'] });
  }

  async function revoke(id: number) {
    if (!(await confirm({
      title: 'Revoke this key?',
      body: 'Anything signed in with this key stops working straight away. You cannot un-revoke it — you would need to issue a new one.',
      confirmLabel: 'Revoke',
      destructive: true,
    }))) return;
    await fetch(`/api/keys/${id}`, { method: 'DELETE' });
    await queryClient.invalidateQueries({ queryKey: ['apiKeys'] });
  }

  async function copy() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ }
  }

  return (
    <div className="settings__panel">
      <p className="settings__hint">For scripts and integrations. Send as <code>X-API-Key</code> or <code>Authorization: Bearer</code>.</p>

      {created && (
        <div className="settings__token">
          <code className="settings__token-value">{created}</code>
          <button type="button" className="settings__btn" onClick={() => void copy()}>
            <Copy size={15} /> {copied ? 'Copied' : 'Copy'}
          </button>
          <span className="settings__hint">Shown once — store it now.</span>
        </div>
      )}

      <SettingGroup
        title="Personal access tokens"
        id="access-tokens"
        footer={!askCode && (
          <button type="button" className="settings__btn settings__btn--quiet" onClick={() => { setAskCode(true); setKeyError(null); setCreated(null); }}>
            <KeyRound size={15} /> New key
          </button>
        )}
      >
        {isLoading && <div className="setting-row"><div className="setting-row__line"><LoadingBar label="Loading API keys" /></div></div>}
        {(keys ?? []).map(k => (
          <div key={k.id} className="setting-row"><div className="setting-row__line">
            <div className="setting-row__text">
              <span className="setting-row__value">{k.name} <code className="settings__key-prefix">{k.prefix}…</code></span>
              <span className="setting-row__hint">
                Created {new Date(k.createdUtc).toLocaleDateString()} · {k.lastUsedUtc ? `last used ${new Date(k.lastUsedUtc).toLocaleDateString()}` : 'never used'}
              </span>
            </div>
            <button type="button" className="setting-row__action" onClick={() => void revoke(k.id)}>Revoke</button>
          </div></div>
        ))}
        {keys && keys.length === 0 && !askCode && (
          <div className="setting-row"><div className="setting-row__line"><div className="setting-row__text">
            <span className="setting-row__value is-empty">No keys</span>
          </div></div></div>
        )}
        {askCode && (
          <div className="setting-row is-open"><div className="setting-row__editor setting-row__editor--solo">
            <form className="settings__form" onSubmit={create}>
              <label className="settings__field">Name
                <input placeholder="e.g. CLI, backup script" value={name} autoFocus onChange={e => setName(e.target.value)} />
              </label>
              <CodeField
                value={code}
                onChange={c => { setCode(c); setKeyError(null); }}
                onEmail={user?.canEmailCode ? () => requestEmailCode('/api/auth/step-up/email') : undefined}
              />
              {keyError && <p className="settings__error" role="alert">{keyError}</p>}
              <div className="settings__form-actions">
                <button type="submit" className="settings__btn" disabled={code.length !== 6}><KeyRound size={15} /> Create key</button>
                <button type="button" className="settings__btn settings__btn--quiet" onClick={() => { setAskCode(false); setCode(''); setKeyError(null); }}>Cancel</button>
              </div>
            </form>
          </div></div>
        )}
      </SettingGroup>
    </div>
  );
}

// ── About ────────────────────────────────────────────────────────────────────────
// ── Jobs ─────────────────────────────────────────────────────────────────────
// What Papyra does while nobody is watching. Before this, "has the Trash been
// emptying?" was a question you answered by reading server logs on the host.

/** "every 6 hours", from a number of seconds. */
function everyPhrase(seconds: number): string {
  if (seconds % 86400 === 0) {
    const days = seconds / 86400;
    return days === 1 ? 'once a day' : `every ${days} days`;
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? 'every hour' : `every ${hours} hours`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'every minute' : `every ${minutes} minutes`;
}

/** "2 minutes ago", or a date once it stops being interesting. */
function agoPhrase(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

function JobsTab() {
  const { data: jobs, isLoading, isError } = useJobs(true);
  const run = useRunJob();
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function trigger(job: Job) {
    setBusyId(job.id);
    try {
      const result = await run.mutateAsync(job.id);
      toast(result.ok
        ? `${job.name}: ${result.summary ?? 'nothing needed doing'}`
        : `${job.name} failed — ${result.error}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Couldn’t run that job.');
    } finally {
      setBusyId(null);
    }
  }

  if (isLoading) return <div className="settings__panel"><LoadingBar label="Loading settings" /></div>;
  if (isError) return <div className="settings__panel"><p className="settings__error">Couldn’t load the list of jobs.</p></div>;

  const scheduled = (jobs ?? []).filter(j => j.kind === 'periodic');
  const onDemand = (jobs ?? []).filter(j => j.kind === 'manual');
  const alwaysOn = (jobs ?? []).filter(j => j.kind === 'continuous');

  const lastRunMeta = (job: Job) => (
    <>
      {job.lastRun && (
        <>
          <span aria-hidden="true">·</span>
          <span className={job.lastRun.ok ? undefined : 'jobs__failed'}>
            {job.lastRun.ok
              ? `Last run ${agoPhrase(job.lastRun.finishedUtc)}${job.lastRun.summary ? `: ${job.lastRun.summary}` : ' — nothing needed doing'}`
              : `Failed ${agoPhrase(job.lastRun.finishedUtc)}: ${job.lastRun.error}`}
          </span>
        </>
      )}
      {!job.lastRun && !job.running && (
        <>
          <span aria-hidden="true">·</span>
          <span>Hasn’t run since the server started</span>
        </>
      )}
    </>
  );

  const runButton = (job: Job) => (
    <button
      type="button"
      className="settings__btn"
      disabled={busyId === job.id || job.running}
      onClick={() => void trigger(job)}
    >
      <Play size={15} /> {busyId === job.id || job.running ? 'Running…' : 'Run now'}
    </button>
  );

  return (
    <div className="settings__panel">
      <h2 id="scheduled-jobs" className="settings__subhead">Housekeeping</h2>
      <p className="settings__hint">Run automatically. Start one now if you’d rather not wait.</p>

      <ul className="jobs">
        {scheduled.map(job => (
          <li key={job.id} className="jobs__item">
            <div className="jobs__text">
              <p className="jobs__name">{job.name}</p>
              <p className="jobs__desc">{job.description}</p>
              <p className="jobs__meta">
                <span>Runs {job.intervalSeconds ? everyPhrase(job.intervalSeconds) : 'on its own schedule'}</span>
                {lastRunMeta(job)}
              </p>
            </div>
            {runButton(job)}
          </li>
        ))}
      </ul>

      {onDemand.length > 0 && (
        <>
          <h2 id="on-demand-jobs" className="settings__subhead">On demand</h2>
          <p className="settings__hint">Run on demand.</p>
          <ul className="jobs">
            {onDemand.map(job => (
              <li key={job.id} className="jobs__item">
                <div className="jobs__text">
                  <p className="jobs__name">{job.name}</p>
                  <p className="jobs__desc">{job.description}</p>
                  <p className="jobs__meta">
                    <span>When you ask</span>
                    {lastRunMeta(job)}
                  </p>
                </div>
                {runButton(job)}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 id="always-on-jobs" className="settings__subhead">Always running</h2>
      <ul className="jobs">
        {alwaysOn.map(job => (
          <li key={job.id} className="jobs__item">
            <div className="jobs__text">
              <p className="jobs__name">{job.name}</p>
              <p className="jobs__desc">{job.description}</p>
            </div>
            <span className="jobs__on">On</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Git Sync ─────────────────────────────────────────────────────────────────────
// Admin-only. The panel leads with the blast radius because the setting reads
// like a personal backup and is not one: the mirrored repo is the whole users/
// directory, so a sync publishes every tenant's vault to whatever remote is
// typed here. That warning previously existed only in the API docs, which is
// not where an admin is standing when they paste a URL.
function SyncTab() {
  const { data, isLoading, isError } = useGitConfig();
  const save = useSaveGitConfig();

  // null means "not edited yet", so the field shows whatever the server holds
  // without an effect copying it into state (which would cascade a render on
  // every refetch). The token is never returned by the API, so it starts empty.
  const [remoteUrlEdit, setRemoteUrl] = useState<string | null>(null);
  const [branchEdit, setBranch] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);

  const remoteUrl = remoteUrlEdit ?? data?.remoteUrl ?? '';
  const branch = branchEdit ?? data?.branch ?? '';

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    save.mutate(
      { remoteUrl, branch, token: token.trim() === '' ? undefined : token },
      { onSuccess: () => { setToken(''); setSaved(true); } },
    );
  }

  if (isLoading) return <div className="settings__panel"><LoadingBar label="Loading settings" /></div>;
  if (isError) return <div className="settings__panel"><p className="settings__error">Couldn’t load the backup settings.</p></div>;

  return (
    <div className="settings__panel">
      <h2 id="git-backup" className="settings__subhead">Back up to GitHub</h2>
      <p className="settings__hint">An off-server copy of your notes, with full history.</p>

      <GitSetupGuide />

      <div className="settings__callout" role="note">
        <AlertTriangle size={18} aria-hidden="true" />
        <div>
          <strong>Anyone who can read the repository can read your notes.</strong>
          <p>
            Notes are stored as plain text, locked notes included. Keep it private.
          </p>
        </div>
      </div>

      <details className="settings__advanced">
        <summary>Another git host, or a different branch</summary>
        <p className="settings__hint">Any https Git host that takes a token as the password.</p>
        <form className="settings__form" onSubmit={submit}>
          <label className="settings__field">Repository address
            <input
              type="url"
              value={remoteUrl}
              placeholder="https://git.example.com/you/papyra-notes.git"
              onChange={e => setRemoteUrl(e.target.value)}
            />
          </label>
          <label className="settings__field">Branch
            <input type="text" value={branch} placeholder="main" onChange={e => setBranch(e.target.value)} />
          </label>
          <label className="settings__field">
            Access token {data?.hasToken && <span className="settings__hint">(one is saved — leave blank to keep it)</span>}
            <input
              {...MASKED_SECRET}
              value={token}
              placeholder={data?.hasToken ? '••••••••' : 'Personal access token'}
              onChange={e => setToken(e.target.value)}
            />
          </label>
          <div className="settings__form-actions">
            <button type="submit" className="settings__btn" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="settings__msg"><CheckCircle2 size={15} /> Saved</span>}
            {save.isError && <span className="settings__error">Couldn’t save.</span>}
          </div>
        </form>
      </details>
    </div>
  );
}

// ── Notifications (per user) ─────────────────────────────────────────────────────
function NotificationsTab() {
  return (
    <div className="settings__panel">
      <h2 id="email-notifications" className="settings__subhead">What Papyra tells you about</h2>
      <NotificationSettings />
    </div>
  );
}

// ── SSO (admin) ──────────────────────────────────────────────────────────────────
// OIDC used to be configurable only through appsettings.json, which a self-hoster
// running the published container can't reach. Saving here takes effect immediately:
// the server evicts the cached auth options rather than waiting for a restart.
function SsoTab() {
  return (
    <div className="settings__panel">
      <SsoSettings />
    </div>
  );
}

// ── Email / SMTP (admin) ─────────────────────────────────────────────────────────
function EmailTab() {
  const { data, isLoading, isError } = useSmtpConfig();
  const save = useSaveSmtpConfig();
  const test = useSendTestEmail();
  const invite = useInviteUser();

  const [edits, setEdits] = useState<Partial<SmtpForm>>({});
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [inviteUser, setInviteUser] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('User');
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);
  // Shown as a summary until someone chooses to change it.
  const [editing, setEditing] = useState(false);

  const v = <K extends keyof SmtpForm>(key: K): SmtpForm[K] =>
    (edits[key] ?? (data as SmtpForm | undefined)?.[key] ?? SMTP_DEFAULTS[key]) as SmtpForm[K];
  const set = <K extends keyof SmtpForm>(key: K, value: SmtpForm[K]) =>
    setEdits(prev => ({ ...prev, [key]: value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    save.mutate(
      {
        enabled: v('enabled'), host: v('host'), port: v('port'), useSsl: v('useSsl'),
        username: v('username'), fromAddress: v('fromAddress'), fromName: v('fromName'),
        publicUrl: v('publicUrl'),
        password: password.trim() === '' ? undefined : password,
      },
      { onSuccess: () => { setPassword(''); setSaved(true); setEdits({}); setEditing(false); } },
    );
  }

  function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteMsg(null);
    invite.mutate(
      { username: inviteUser.trim(), email: inviteEmail.trim(), role: inviteRole },
      {
        onSuccess: () => { setInviteUser(''); setInviteEmail(''); setInviteMsg('Invitation sent.'); },
        onError: (err) => setInviteMsg((err as Error).message),
      },
    );
  }

  if (isLoading) return <div className="settings__panel"><LoadingBar label="Loading settings" /></div>;
  if (isError) return <div className="settings__panel"><p className="settings__error">Couldn’t load the email configuration.</p></div>;

  const configured = !!data?.host;
  return (
    <div className="settings__panel">
      {editing ? (
        <>
          <h2 id="smtp" className="settings__subhead">Outbound email</h2>
          <form className="settings__form" onSubmit={submit}>
            <label className="settings__field settings__field--inline">
              <input type="checkbox" role="switch" className="switch" checked={v('enabled')} onChange={e => set('enabled', e.target.checked)} />
              Enable outbound email
            </label>

            <label className="settings__field">SMTP host
              <input type="text" value={v('host')} placeholder="smtp.example.com"
                onChange={e => set('host', e.target.value)} />
            </label>
            <label className="settings__field">Port
              <input type="number" min={1} max={65535} value={v('port')}
                onChange={e => set('port', Number(e.target.value))} />
            </label>
            <label className="settings__field settings__field--inline">
              <input type="checkbox" role="switch" className="switch" checked={v('useSsl')} onChange={e => set('useSsl', e.target.checked)} />
              Use TLS/SSL
            </label>
            <label className="settings__field">Username
              <input type="text" {...NO_AUTOFILL} value={v('username')} placeholder="Blank for a relay without sign-in" onChange={e => set('username', e.target.value)} />
            </label>
            <label className="settings__field">
              Password
              <input {...MASKED_SECRET} value={password}
                placeholder={data?.hasPassword ? 'Saved — leave blank to keep' : 'SMTP password'}
                onChange={e => setPassword(e.target.value)} />
            </label>
            <label className="settings__field">From address
              <input type="email" value={v('fromAddress')} placeholder="papyra@example.com"
                onChange={e => set('fromAddress', e.target.value)} />
            </label>
            <label className="settings__field">From name
              <input type="text" value={v('fromName')} placeholder="Papyra"
                onChange={e => set('fromName', e.target.value)} />
            </label>
            <label className="settings__field">Address for links in emails
              <input type="url" value={v('publicUrl')} placeholder="https://notes.example.com"
                onChange={e => set('publicUrl', e.target.value)} />
            </label>

            <div className="settings__form-actions">
              <button type="submit" className="settings__btn" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save email settings'}
              </button>
              <button type="button" className="settings__btn settings__btn--quiet" onClick={() => { setEdits({}); setPassword(''); setEditing(false); }}>Cancel</button>
              {save.isError && <span className="settings__error">{(save.error as Error).message}</span>}
            </div>
          </form>
        </>
      ) : (
        <SettingGroup
          title="Outbound email"
          id="smtp"
          footer={
            <button type="button" className={`settings__btn${configured ? ' settings__btn--quiet' : ''}`} onClick={() => { setSaved(false); setEditing(true); }}>
              {configured ? 'Edit' : 'Set up email'}
            </button>
          }
        >
          {!configured ? (
            <SettingRow label="Status" value={null} empty="Not set up" hint="For password resets, invites and notifications." />
          ) : (
            <>
              <SettingRow label="Status" value={data?.enabled ? 'On' : 'Off'} hint={saved ? 'Saved' : undefined} />
              <SettingRow label="Server" value={`${data?.host}:${data?.port}${data?.useSsl ? ' · TLS' : ''}`} />
              <SettingRow label="Signs in as" value={data?.username || 'No sign-in (relay)'}
                hint={data?.username ? (data?.hasPassword ? 'Password saved' : 'No password saved') : undefined} />
              <SettingRow label="Sends as" value={data?.fromAddress ? `${data?.fromName || 'Papyra'} <${data.fromAddress}>` : null} />
              <SettingRow label="Links in emails" value={data?.publicUrl || null} empty="This address" />
              <SettingRow label="Test" value="Send a test email" action="Send…" id="send-a-test">
                {close => (
                  <div className="settings__form">
                    <label className="settings__field">To
                      <input type="email" value={testTo} autoFocus placeholder="Blank = your own address"
                        onChange={e => setTestTo(e.target.value)} />
                    </label>
                    {test.isSuccess && <p className="settings__msg"><CheckCircle2 size={15} /> Sent to {test.data}</p>}
                    {test.isError && <p className="settings__error">{(test.error as Error).message}</p>}
                    <div className="settings__form-actions">
                      <button type="button" className="settings__btn" disabled={test.isPending} onClick={() => test.mutate(testTo)}>
                        <Send size={16} /> {test.isPending ? 'Sending…' : 'Send'}
                      </button>
                      <button type="button" className="settings__btn settings__btn--quiet" onClick={close}>Done</button>
                    </div>
                  </div>
                )}
              </SettingRow>
              <SettingRow label="Invite" value="Email someone a sign-up link" hint="Expires in 7 days" action="Invite…" id="invite">
                {close => (
                  <form className="settings__form" onSubmit={sendInvite}>
                    <label className="settings__field">Username
                      <input type="text" value={inviteUser} autoFocus onChange={e => setInviteUser(e.target.value)} />
                    </label>
                    <label className="settings__field">Email address
                      <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} />
                    </label>
                    <label className="settings__field">Role
                      <select className="settings__select" value={inviteRole} onChange={e => setInviteRole(e.target.value)}>
                        <option value="User">User</option>
                        <option value="Admin">Admin</option>
                      </select>
                    </label>
                    {inviteMsg && <p className="settings__msg">{inviteMsg}</p>}
                    <div className="settings__form-actions">
                      <button type="submit" className="settings__btn" disabled={invite.isPending}>
                        <UserPlus size={16} /> {invite.isPending ? 'Sending…' : 'Send invitation'}
                      </button>
                      <button type="button" className="settings__btn settings__btn--quiet" onClick={() => { setInviteMsg(null); close(); }}>Done</button>
                    </div>
                  </form>
                )}
              </SettingRow>
            </>
          )}
        </SettingGroup>
      )}
    </div>
  );
}

interface SmtpForm {
  enabled: boolean; host: string; port: number; useSsl: boolean;
  username: string; fromAddress: string; fromName: string; publicUrl: string;
}

const SMTP_DEFAULTS: SmtpForm = {
  enabled: false, host: '', port: 587, useSsl: true,
  username: '', fromAddress: '', fromName: '', publicUrl: '',
};

// What every Assistant row reads while the probe is still out. A dash or a
// default would be read as an answer; this cannot be mistaken for one.
const CHECKING = 'Checking…';

// ── AI assistant (admin) ─────────────────────────────────────────────────────────
// Two audiences share this panel, so it's ordered for the common one. Almost
// everybody wants a model on their own machine and nothing else: that's the top
// half, three cards, one click, no jargon and no model names. The small minority
// who want to spend money at OpenAI or Anthropic get the bottom half, folded away.
//
// Keys are write-only: blank means "keep the stored one", same as SSO and Email.
function AiTab() {
  const { data, isLoading, isError } = useAiConfig();
  // The probe has to reach the model runner and time out before it can answer,
  // which takes seconds. Until it does, every row below says so rather than
  // asserting a default — "Address: Not set" while an address is configured is
  // a wrong answer, and three seconds is long enough to read and act on.
  const { data: status, isPending: statusPending, refetch: refetchStatus } = useAiStatus();
  const { data: choices } = useAiModels();
  const save = useSaveAiConfig();

  const [edits, setEdits] = useState<Partial<AiConfig>>({});
  const [openAiKey, setOpenAiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [showCloud, setShowCloud] = useState(false);
  const [pulling, setPulling] = useState<string | null>(null);
  const [progress, setProgress] = useState<PullProgress | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);

  const pull = usePullModel(setProgress);
  // Switching to a model that is already here is a settings change, not a
  // download, so it gets its own (much shorter) busy state.
  const [switching, setSwitching] = useState<string | null>(null);

  async function switchToModel(model: string) {
    setSwitching(model);
    try {
      await save.mutateAsync({
        chatProvider: 'ollama',
        embedProvider: v('embedProvider'),
        ollamaBaseUrl: v('ollamaBaseUrl'),
        ollamaChatModel: model,
        ollamaEmbedModel: v('ollamaEmbedModel'),
        openAiBaseUrl: v('openAiBaseUrl'),
        openAiChatModel: v('openAiChatModel'),
        openAiEmbedModel: v('openAiEmbedModel'),
        anthropicChatModel: v('anthropicChatModel'),
      });
      await refetchStatus();
    } finally {
      setSwitching(null);
    }
  }

  // null/undefined means "not edited yet", so a field shows the server's value
  // without an effect copying it into state on every refetch.
  const v = <K extends keyof AiConfig>(key: K): AiConfig[K] =>
    (edits[key] ?? data?.[key] ?? AI_DEFAULTS[key]) as AiConfig[K];
  const set = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) =>
    setEdits(e => ({ ...e, [key]: value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    save.mutate({
      chatProvider: v('chatProvider'),
      embedProvider: v('embedProvider'),
      ollamaBaseUrl: v('ollamaBaseUrl'),
      ollamaChatModel: v('ollamaChatModel'),
      ollamaEmbedModel: v('ollamaEmbedModel'),
      openAiBaseUrl: v('openAiBaseUrl'),
      openAiChatModel: v('openAiChatModel'),
      openAiEmbedModel: v('openAiEmbedModel'),
      anthropicChatModel: v('anthropicChatModel'),
      openAiKey: openAiKey.trim() === '' ? undefined : openAiKey,
      anthropicKey: anthropicKey.trim() === '' ? undefined : anthropicKey,
    }, {
      onSuccess: () => { setOpenAiKey(''); setAnthropicKey(''); setSaved(true); },
    });
  }

  function install(model: string) {
    setPulling(model);
    setProgress(null);
    setPullError(null);
    pull.mutate(model, {
      onError: (e) => setPullError((e as Error).message),
      onSettled: () => { setPulling(null); setProgress(null); void refetchStatus(); },
    });
  }

  if (isLoading) return <div className="settings__panel"><LoadingBar label="Loading settings" /></div>;
  if (isError) return <div className="settings__panel"><p className="settings__error">Couldn’t load the assistant settings.</p></div>;

  const usingCloud = v('chatProvider') !== 'ollama';
  const installed = status?.installedModels ?? [];
  const activeModel = status?.chatModel;
  // The search model is not an answering model, and the curated three already
  // have cards of their own — this list is what is left.
  const otherInstalled = installed.filter(m =>
    !sameModel(m, v('ollamaEmbedModel')) && choiceFor(m, choices) === null);
  // Ollama reports "llama3.1:8b"; a bare name means the default tag.
  const isInstalled = (m: string) =>
    installed.some(i => i === m || i === `${m}:latest` || i.split(':')[0] === m.split(':')[0]);

  return (
    <div className="settings__panel">
      <h2 id="assistant" className="settings__subhead">Assistant</h2>
      <p className="settings__hint">Ask questions about your notes. Locked notes are never included.</p>

      <dl className="settings__details">
        <div>
          <dt>Status</dt>
          <dd>{statusPending ? CHECKING : (status?.ready ? 'Ready' : (status?.reason ?? 'Not set up yet'))}</dd>
        </div>
        <div>
          <dt>Answering</dt>
          <dd>
            {statusPending ? CHECKING : (
              <>
                {providerLabel(status?.chatProvider)}
                {status?.chatProvider === 'ollama' && ` · ${friendlyModelName(status?.chatModel, choices)}`}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>
            {statusPending
              ? CHECKING
              : endpointLabel(status?.chatProvider, v('ollamaBaseUrl'), v('openAiBaseUrl'))}
          </dd>
        </div>
        <div>
          <dt>Search</dt>
          <dd>
            {statusPending ? CHECKING : (status?.semanticSearchReady
              ? 'Searching by meaning as well as by word'
              : 'Words only — searching by meaning needs a search model')}
          </dd>
        </div>
      </dl>

      {/* The exact identifiers, folded away. Nobody choosing a model needs to
          read "mistral-nemo:12b", and anybody diagnosing one needs it exactly. */}
      <details className="settings__tech">
        <summary>Technical details</summary>
        <dl className="settings__details">
          <div><dt>Chat model</dt><dd><code>{statusPending ? '…' : (status?.chatModel || '—')}</code></dd></div>
          <div><dt>Search model</dt><dd><code>{statusPending ? '…' : (status?.embedModel || '—')}</code></dd></div>
          <div><dt>Chat provider</dt><dd><code>{statusPending ? '…' : (status?.chatProvider || '—')}</code></dd></div>
          <div><dt>Search provider</dt><dd><code>{status?.embedProvider || '—'}</code></dd></div>
          <div><dt>Local engine</dt><dd><code>{v('ollamaBaseUrl') || '—'}</code></dd></div>
        </dl>
      </details>

      {/* ── On this machine ──────────────────────────────────────────────── */}
      <h3 id="local-models" className="settings__subhead">On this machine</h3>
      <p className="settings__hint">Runs on your server — notes never leave it. Bigger is better, if it fits.</p>

      {status && !status.canPull && (
        <div className="settings__callout" role="note">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>The model engine isn’t running.</strong>
            <p>
              Downloads unavailable. With Docker, run <code>docker compose up -d</code> again.
            </p>
          </div>
        </div>
      )}

      <ul className="settings__models">
        {(choices ?? []).map(c => {
          const here = isInstalled(c.model);
          const active = here && activeModel === c.model;
          const busy = pulling === c.model;
          return (
            <li key={c.model} className={`settings__model${active ? ' is-active' : ''}`}>
              <div className="settings__model-head">
                <span className="settings__model-tier">{c.tier}</span>
                {active
                  ? <span className="settings__model-badge">In use</span>
                  : here && <span className="settings__model-badge">Downloaded</span>}
              </div>
              <p className="settings__model-blurb">{c.blurb}</p>
              <dl className="settings__model-specs">
                <div><dt>Size</dt><dd>{c.size}</dd></div>
                <div><dt>Memory needed</dt><dd>{c.memory}</dd></div>
              </dl>
              <button
                type="button"
                className="settings__btn"
                disabled={active || pulling !== null || switching !== null || !status?.canPull}
                onClick={() => (here ? void switchToModel(c.model) : install(c.model))}
              >
                {active ? 'In use'
                  : busy ? 'Downloading…'
                  : switching === c.model ? 'Switching…'
                  : here ? 'Use this one'
                  : 'Download'}
              </button>

              {busy && (
                <div className="settings__model-progress" role="status">
                  <div
                    className="settings__model-bar"
                    style={{ '--pct': `${progress && progress.total > 0
                      ? Math.round((progress.completed / progress.total) * 100) : 0}%` } as React.CSSProperties}
                  />
                  <span>
                    {progress?.phase === 'search'
                      ? 'Setting up search…'
                      : progress && progress.total > 0
                        ? `${Math.round((progress.completed / progress.total) * 100)}% downloaded`
                        : 'Starting…'}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {pullError && <p className="settings__error">{pullError}</p>}
      {pulling && (
        <p className="settings__hint">You can leave this page — the download continues.</p>
      )}


      {/* Models already on the machine, including any pulled outside Papyra.
          Switching between them is a settings change, not a download — the
          curated cards above are for getting a model in the first place. */}
      {otherInstalled.length > 0 && (
        <>
          <h3 id="installed-models" className="settings__subhead">Already on this machine</h3>
          <p className="settings__hint">Found on this server, not installed by Papyra.</p>
          <ul className="settings__installed">
            {otherInstalled.map(m => {
              const inUse = sameModel(m, activeModel);
              return (
                <li key={m} className="settings__installed-item">
                  <span className="settings__installed-name">
                    {friendlyModelName(m, choices)}
                    <code>{m}</code>
                  </span>
                  <button
                    type="button"
                    className="settings__btn"
                    disabled={inUse || switching !== null || usingCloud}
                    onClick={() => void switchToModel(m)}
                  >
                    {inUse ? 'In use' : switching === m ? 'Switching…' : 'Use this one'}
                  </button>
                </li>
              );
            })}
          </ul>
          {usingCloud && (
            <p className="settings__hint">Switch back to the local model to use one of these.</p>
          )}
        </>
      )}

      {/* ── Or use a paid service ────────────────────────────────────────── */}
      <h3 id="hosted-models" className="settings__subhead">Or use a paid service</h3>
      <p className="settings__hint">Faster, but note excerpts are sent to the provider, and it’s paid.</p>

      {!showCloud && !usingCloud ? (
        <button type="button" className="settings__btn settings__btn--ghost" onClick={() => setShowCloud(true)}>
          Set up OpenAI or Anthropic
        </button>
      ) : (
        <form className="settings__form" onSubmit={submit}>
          <label className="settings__field">Answer with
            <select value={v('chatProvider')} onChange={e => set('chatProvider', e.target.value)}>
              <option value="ollama">The model on this machine</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>

          {usingCloud && (
            <div className="settings__callout" role="note">
              <AlertTriangle size={18} aria-hidden="true" />
              <div>
                <strong>Your notes will leave this machine.</strong>
                <p>
                  Relevant excerpts are sent to{' '}{v('chatProvider') === 'openai' ? 'OpenAI' : 'Anthropic'}.
                </p>
              </div>
            </div>
          )}

          <label className="settings__field">
            OpenAI key {data?.hasOpenAiKey && <span className="settings__hint">(saved — leave blank to keep it)</span>}
            <input {...MASKED_SECRET} value={openAiKey}
              placeholder={data?.hasOpenAiKey ? '••••••••' : 'Paste your key'}
              onChange={e => setOpenAiKey(e.target.value)} />
          </label>
          <label className="settings__field">OpenAI model
            <input type="text" value={v('openAiChatModel')} placeholder="gpt-4o"
              onChange={e => set('openAiChatModel', e.target.value)} />
          </label>

          <label className="settings__field">
            Anthropic key {data?.hasAnthropicKey && <span className="settings__hint">(saved — leave blank to keep it)</span>}
            <input {...MASKED_SECRET} value={anthropicKey}
              placeholder={data?.hasAnthropicKey ? '••••••••' : 'Paste your key'}
              onChange={e => setAnthropicKey(e.target.value)} />
          </label>
          <label className="settings__field">Anthropic model
            <input type="text" value={v('anthropicChatModel')} placeholder="claude-opus-5"
              onChange={e => set('anthropicChatModel', e.target.value)} />
          </label>

          <details className="settings__advanced">
            <summary>Advanced</summary>
            <label className="settings__field">Search index built by
              <select value={v('embedProvider')} onChange={e => set('embedProvider', e.target.value)}>
                <option value="ollama">The model on this machine</option>
                <option value="openai">OpenAI</option>
              </select>
              <span className="settings__hint">
                Anthropic can’t do this part, so search always uses one of the other two.
              </span>
            </label>
            <label className="settings__field">Model engine address
              <input type="url" value={v('ollamaBaseUrl')} placeholder="http://localhost:11434"
                onChange={e => set('ollamaBaseUrl', e.target.value)} />
            </label>
            <label className="settings__field">OpenAI address
              <input type="url" value={v('openAiBaseUrl')} placeholder="https://api.openai.com/v1"
                onChange={e => set('openAiBaseUrl', e.target.value)} />
              <span className="settings__hint">Change this to use a compatible service.</span>
            </label>
          </details>

          <div className="settings__form-actions">
            <button type="submit" className="settings__btn" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="settings__msg"><CheckCircle2 size={15} /> Saved</span>}
            {save.isError && <span className="settings__error">{(save.error as Error).message}</span>}
          </div>
        </form>
      )}
    </div>
  );
}

const AI_DEFAULTS: AiConfig = {
  chatProvider: 'ollama', embedProvider: 'ollama',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaChatModel: 'mistral-nemo:12b', ollamaEmbedModel: 'nomic-embed-text',
  openAiBaseUrl: 'https://api.openai.com/v1',
  openAiChatModel: 'gpt-4o', openAiEmbedModel: 'text-embedding-3-small',
  anthropicChatModel: 'claude-opus-5',
  hasOpenAiKey: false, hasAnthropicKey: false,
};
