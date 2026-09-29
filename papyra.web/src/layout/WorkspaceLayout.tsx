import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Menu, StickyNote, ListTodo, Archive, Settings, Trash2, ShieldCheck, LockOpen,
  User, LogOut, Sun, Moon, Layers, Sparkles, CircleQuestionMark, Users,
} from 'lucide-react';
import ChatPanel from '../components/ChatPanel';
import SearchBar from '../components/SearchBar';
import HelpSheet from '../components/HelpSheet';
import { useTheme } from '../hooks/useTheme';
import { backgroundPage, rememberPage } from '../lib/noteLink';
import ErrorBoundary from '../components/ErrorBoundary';
import ErrorPanel from '../components/ErrorPanel';
import NoteEditorPage from '../pages/NoteEditorPage';
import { useRealLocation } from '../lib/realLocation';
import { clearSessionData } from '../lib/session';
import { AI_ENABLED } from '../lib/features';
import { useSignalR } from '../hooks/useSignalR';
import SidebarImportProgress from '../components/SidebarImportProgress';
import { useAuth } from '../hooks/useAuth';
import { useSyncEngine } from '../hooks/useSync';
import NotificationBell from '../components/NotificationBell';
import logo from '../assets/papyra_logo.png';
import Avatar from '../components/Avatar';
import './WorkspaceLayout.css';
import { APP_VERSION_LABEL } from '../lib/appInfo';
import { useServerVersion, versionLabel } from '../lib/serverVersion';
import { useToast } from '../lib/toastContext';
import VaultOpenPill from '../components/VaultOpenPill';
import { useVaultOpen } from '../hooks/useVault';

// Settings deliberately lives with Trash at the foot of the rail, not in this
// list — the top group is "places your notes are", the bottom group is app
// chrome.
const NAV_ITEMS = [
  { to: '/', label: 'Notes', icon: StickyNote, end: true },
  { to: '/todo', label: 'To Do', icon: ListTodo, end: false },
  { to: '/shared-with-me', label: 'Shared with me', icon: Users, end: false },
  { to: '/collections', label: 'Collections', icon: Layers, end: false },
  { to: '/vault', label: 'Vault', icon: ShieldCheck, end: false },
  { to: '/archive', label: 'Archive', icon: Archive, end: false },
] as const;

/** Shown under the connection status so a self-hoster can see what they're running. */

export default function WorkspaceLayout() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const serverStatus = useSignalR();
  const vaultOpen = useVaultOpen();

  // Connectivity + outbox telemetry. The dot now answers the question a
  // local-first app actually has to answer — "is my writing safe?" — not just
  // whether a socket happens to be up.
  const sync = useSyncEngine();

  // The server came back running a newer release than this tab's bundle: show
  // the server's version and offer the reload that actually picks it up.
  const server = useServerVersion();
  const versionText = server.version ? versionLabel(server.version) : APP_VERSION_LABEL;
  const { toast } = useToast();
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!server.stale || !server.version || announced.current === server.version) return;
    announced.current = server.version;
    toast(`Papyra was updated to ${versionLabel(server.version)}.`, { label: 'Reload', onClick: () => window.location.reload() });
  }, [server.stale, server.version, toast]);
  const offline = serverStatus === 'offline' || !sync.online;
  const syncTone = sync.syncing
    ? 'syncing'
    : sync.pending > 0 ? 'pending' : offline ? 'offline' : 'online';
  // The pill has a 220px rail to live in, so it says one short word and leaves
  // the explanation to the tooltip — a long label used to spill past its edge.
  const syncLabel = sync.authRequired && sync.pending > 0
    ? 'Sign in'
    : sync.syncing
      ? 'Syncing'
      : sync.pending > 0
        ? `${sync.pending} queued`
        : offline ? 'Offline' : 'Online';
  const syncTitle = sync.authRequired
    ? `Your session expired while ${sync.pending} edit(s) were queued. They are still saved on this device — sign in again and they will upload.`
    : offline
      ? (sync.pending > 0
        ? `Offline — ${sync.pending} edit(s) saved on this device, uploading when the server is reachable.`
        : 'Offline — Papyra is running from this device. Edits are saved here and upload when the server is reachable.')
      : sync.pending > 0 ? `${sync.pending} edit(s) waiting to upload` : 'Connected to your vault';


  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  function go(to: string) { setMenuOpen(false); navigate(to); }

  async function logout() {
    setMenuOpen(false);
    await fetch('/api/auth/logout', { method: 'POST' });
    // Every client-side store the last user touched — query cache, offline
    // cache, pending writes. See clearSessionData for why each one matters.
    await clearSessionData(queryClient);
    queryClient.setQueryData(['auth'], { state: 'login', user: null });
    navigate('/login', { replace: true });
  }

  return (
    <div className={`workspace${collapsed ? ' workspace--collapsed' : ''}`}>
      <header className="workspace__navbar">
        <div className="workspace__brand">
          <button
            type="button"
            className="workspace__sidebar-toggle"
            onClick={() => setCollapsed(c => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
          >
            <Menu size={18} />
          </button>
          {/* The brand is the way home: Notes is the home page. A plain link, so
              middle-click / open-in-new-tab work as people expect. */}
          <Link to="/" className="workspace__home" aria-label="Papyra — go to Notes">
            <img className="workspace__logo" src={logo} alt="" aria-hidden="true" />
            <span className="workspace__wordmark" aria-hidden="true">Papyra</span>
          </Link>
        </div>
        <SearchBar />

        <div className="workspace__nav-actions">
          <VaultOpenPill />
          <button
            type="button"
            className="workspace__theme-toggle"
            onClick={() => setHelpOpen(true)}
            aria-label="How Papyra works"
            title="How Papyra works"
          >
            <CircleQuestionMark size={18} />
          </button>
          {/* The assistant is held back for a later release — see lib/features.ts. */}
          {AI_ENABLED && (
            <button
              type="button"
              className="workspace__theme-toggle"
              onClick={() => setChatOpen(o => !o)}
              aria-label="Ask your notes"
              title="Ask your notes"
              aria-expanded={chatOpen}
            >
              <Sparkles size={18} />
            </button>
          )}
          <NotificationBell />
          <ThemeToggle />
          <div className="workspace__avatar-wrap" ref={menuRef}>
            <button
              type="button"
              className="workspace__avatar"
              aria-label="Account menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(o => !o)}
            >
              <Avatar name={user?.name || user?.username} size={38} />
            </button>
            {menuOpen && (
              <div className="workspace__avatar-menu" role="menu">
                <div className="workspace__avatar-who" aria-hidden="true">
                  <Avatar name={user?.name || user?.username} size={44} />
                  <div className="workspace__avatar-names">
                    <span className="workspace__avatar-name">{user?.name || user?.username}</span>
                    <span className="workspace__avatar-handle">@{user?.username}</span>
                  </div>
                </div>
                <div className="workspace__avatar-sep" />
                <button type="button" role="menuitem" onClick={() => go('/settings?tab=profile')}>
                  <User size={15} /> Profile
                </button>
                <button type="button" role="menuitem" onClick={() => go('/settings')}>
                  <Settings size={15} /> Settings
                </button>
                <div className="workspace__avatar-sep" />
                <button type="button" role="menuitem" onClick={() => void logout()}>
                  <LogOut size={15} /> Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="workspace__body">
        <nav className="workspace__sidebar" aria-label="Primary">
          <ul>
            {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  title={to === '/vault' && vaultOpen ? 'Vault — open on this device' : label}
                  aria-label={to === '/vault' && vaultOpen ? 'Vault (open)' : undefined}
                  className={({ isActive }) => `workspace__nav-link${isActive ? ' workspace__nav-link--active' : ''}`}
                >
                  {to === '/vault' && vaultOpen ? (
                    // The vault item says when it's open, from any page — a
                    // sage dot on an open lock, and "Open" beside the name.
                    <>
                      <span className="workspace__nav-icon workspace__vault-icon">
                        <LockOpen size={18} aria-hidden="true" />
                        <span className="workspace__vault-dot" aria-hidden="true" />
                      </span>
                      <span className="workspace__nav-label">{label}</span>
                      <span className="workspace__vault-tag workspace__nav-label">Open</span>
                    </>
                  ) : (
                    <>
                      <Icon className="workspace__nav-icon" size={18} />
                      <span className="workspace__nav-label">{label}</span>
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>

          <div className="workspace__sidebar-bottom">
            <SidebarImportProgress />
            <NavLink
              to="/trash"
              title="Trash"
              className={({ isActive }) =>
                `workspace__nav-link${isActive ? ' workspace__nav-link--active' : ''}`
              }
            >
              <Trash2 className="workspace__nav-icon" size={18} />
              <span className="workspace__nav-label">Trash</span>
            </NavLink>

            <NavLink
              to="/settings"
              title="Settings"
              className={({ isActive }) =>
                `workspace__nav-link${isActive ? ' workspace__nav-link--active' : ''}`
              }
            >
              <Settings className="workspace__nav-icon" size={18} />
              <span className="workspace__nav-label">Settings</span>
            </NavLink>

            {/* Connection + build in one quiet badge; it opens Settings → About. */}
            <footer className="workspace__sidebar-footer">
              <Link
                to="/settings?tab=about"
                className={`workspace__build workspace__build--${syncTone}`}
                title={`${syncTitle}
Papyra ${versionText}${server.stale ? ' — reload to finish updating' : ''} — about this Papyra`}
                aria-label={`${syncTitle}. Papyra ${versionText}. About this Papyra.`}
              >
                <span
                  className={`workspace__status-dot workspace__status-dot--${syncTone}`}
                  aria-hidden="true"
                />
                <span className="workspace__status-label workspace__nav-label" role="status">
                  {syncLabel}
                </span>
                <span className="workspace__build-sep workspace__nav-label" aria-hidden="true" />
                <span className="workspace__version workspace__nav-label">{versionText}</span>
              </Link>
            </footer>
          </div>
        </nav>

        <main className="workspace__desk">
          <OriginTracker />
          <DeskScrollReset />
          {/* A crash in one page or one note stays there: the shell, the
              sidebar and the way out keep working. */}
          <DeskPage />
          <NoteOverlay />
        </main>
      </div>

      {AI_ENABLED && chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
      {helpOpen && <HelpSheet onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

// The only part of the shell that shows the theme. Reading the theme context
// here rather than in the layout keeps a theme switch from re-rendering the
// whole workspace — and with it every card on the desk.
function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'light' ? 'dark' : 'light';
  return (
    <button
      type="button"
      className="workspace__theme-toggle"
      onClick={toggleTheme}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
    </button>
  );
}

// Remembers the page a note is opened from, so closing the note returns there
// (see noteLink.ts). Renders nothing; it is the one subscriber to the location
// that cards would otherwise each need.
function OriginTracker() {
  const location = useLocation();
  useEffect(() => { rememberPage(location); }, [location]);
  return null;
}

// A new page starts at its top. The desk is one scroller shared by every page,
// so it kept the last page's offset: leave Settings half-way down and Notes
// opened half-way down too. The location here is the page behind any open note
// (see App), so opening and closing a note leaves the desk where it was.
function DeskScrollReset() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.delete('open'); // ?open= overlays a shared note; the page underneath stays put
  params.delete('comment'); // ?comment= jumps to a thread in the open note
  params.delete('s');    // Settings' jump-to-section scrolls on its own
  const page = `${location.pathname}?${params.toString()}`;
  const ref = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    ref.current?.closest('.workspace__desk')?.scrollTo({ top: 0 });
  }, [page]);
  return <span ref={ref} hidden />;
}

// The open note, over whatever page it was opened from. App keeps rendering that
// page as the main route while the URL is /note/:id (see backgroundPage), so
// opening a list from To Do no longer flashes the Notes desk in behind it.
function NoteOverlay() {
  const real = useRealLocation();
  const navigate = useNavigate();
  const match = real ? matchPath('/note/:id', real.pathname) : null;
  if (!match?.params.id) return null;
  return (
    <ErrorBoundary resetKey={match.params.id} fallback={(info) => (
      <div className="workspace__note-crash" role="dialog" aria-modal="true" aria-label="This note couldn’t open">
        <div className="workspace__note-crash-box">
          <ErrorPanel info={{ ...info, title: 'This note couldn’t open' }} variant="dialog" actions={[
            { label: 'Close note', onClick: () => { const bg = backgroundPage(); navigate(bg.pathname + bg.search); }, primary: true },
            { label: 'Reload', onClick: () => window.location.reload() },
          ]} />
        </div>
      </div>
    )}>
      <NoteEditorPage key={match.params.id} id={match.params.id} />
    </ErrorBoundary>
  );
}

// The routed page, behind a boundary that resets when you navigate away.
function DeskPage() {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary resetKey={pathname} fallback={(info, reset) => (
      <ErrorPanel info={info} variant="inline" actions={[
        { label: 'Try again', onClick: reset, primary: true },
        { label: 'Reload', onClick: () => window.location.reload() },
      ]} />
    )}>
      <Outlet />
    </ErrorBoundary>
  );
}
