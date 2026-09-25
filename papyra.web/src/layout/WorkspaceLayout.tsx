import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Menu, StickyNote, ListTodo, Archive, Settings, Trash2, ShieldCheck,
  User, Shield, LogOut, Sun, Moon, Layers, Sparkles, CircleQuestionMark, Inbox,
} from 'lucide-react';
import ChatPanel from '../components/ChatPanel';
import SearchBar from '../components/SearchBar';
import HelpSheet from '../components/HelpSheet';
import { useTheme } from '../hooks/useTheme';
import { rememberPage } from '../lib/noteLink';
import NoteEditorPage from '../pages/NoteEditorPage';
import { useRealLocation } from '../lib/realLocation';
import { clearSessionData } from '../lib/session';
import { AI_ENABLED } from '../lib/features';
import { useSignalR } from '../hooks/useSignalR';
import SidebarImportProgress from '../components/SidebarImportProgress';
import { useAuth } from '../hooks/useAuth';
import { useSyncEngine } from '../hooks/useSync';
import { useUnreadInboxCount } from '../hooks/useInbox';
import logo from '../assets/papyra_logo.png';
import Avatar from '../components/Avatar';
import './WorkspaceLayout.css';

// Settings deliberately lives with Trash at the foot of the rail, not in this
// list — the top group is "places your notes are", the bottom group is app
// chrome.
const NAV_ITEMS = [
  { to: '/', label: 'Notes', icon: StickyNote, end: true },
  { to: '/todo', label: 'To Do', icon: ListTodo, end: false },
  { to: '/inbox', label: 'Inbox', icon: Inbox, end: false },
  { to: '/collections', label: 'Collections', icon: Layers, end: false },
  { to: '/vault', label: 'Vault', icon: ShieldCheck, end: false },
  { to: '/archive', label: 'Archive', icon: Archive, end: false },
] as const;

/** Shown under the connection status so a self-hoster can see what they're running. */
const APP_VERSION = '0.0.1';

export default function WorkspaceLayout() {
  const { user } = useAuth();
  const unreadInbox = useUnreadInboxCount();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const serverStatus = useSignalR();

  // Connectivity + outbox telemetry. The dot now answers the question a
  // local-first app actually has to answer — "is my writing safe?" — not just
  // whether a socket happens to be up.
  const sync = useSyncEngine();
  const offline = serverStatus === 'offline' || !sync.online;
  const syncTone = sync.syncing
    ? 'syncing'
    : sync.pending > 0 ? 'pending' : offline ? 'offline' : 'online';
  const syncLabel = sync.authRequired && sync.pending > 0
    ? `Sign in to sync ${sync.pending}`
    : sync.syncing
      ? 'Syncing…'
      : offline
        ? (sync.pending > 0 ? `Offline · ${sync.pending} to sync` : 'Offline · edits saved here')
        : sync.pending > 0 ? `${sync.pending} to sync` : 'Server Online';
  const syncTitle = sync.authRequired
    ? 'Your session expired while these edits were queued. They are still saved on this device — sign in again and they will upload.'
    : offline
    ? 'Papyra is running from this device. Your edits are saved locally and upload automatically when the server is reachable.'
    : sync.pending > 0 ? `${sync.pending} edit(s) waiting to upload` : 'Connected to your vault';

  const isAdmin = user?.role === 'Admin';

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
                {isAdmin && (
                  <button type="button" role="menuitem" onClick={() => go('/admin')}>
                    <Shield size={15} /> Manage Users
                  </button>
                )}
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
                  title={label}
                  className={({ isActive }) =>
                    `workspace__nav-link${isActive ? ' workspace__nav-link--active' : ''}`
                  }
                >
                  <Icon className="workspace__nav-icon" size={18} />
                  <span className="workspace__nav-label">{label}</span>
                  {to === '/inbox' && unreadInbox > 0 && (
                    <span
                      className="workspace__nav-badge"
                      aria-label={`${unreadInbox} unread`}
                    >
                      {unreadInbox > 99 ? '99+' : unreadInbox}
                    </span>
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

            <footer className="workspace__sidebar-footer" title={syncTitle}>
              <span className="workspace__status-row">
                <span
                  className={`workspace__status-dot workspace__status-dot--${syncTone}`}
                  aria-hidden="true"
                />
                <span className="workspace__status-label workspace__nav-label" role="status">
                  {syncLabel}
                </span>
              </span>
              <span className="workspace__version workspace__nav-label">v{APP_VERSION}</span>
            </footer>
          </div>
        </nav>

        <main className="workspace__desk">
          <OriginTracker />
          <Outlet />
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

// The open note, over whatever page it was opened from. App keeps rendering that
// page as the main route while the URL is /note/:id (see backgroundPage), so
// opening a list from To Do no longer flashes the Notes desk in behind it.
function NoteOverlay() {
  const real = useRealLocation();
  const match = real ? matchPath('/note/:id', real.pathname) : null;
  if (!match?.params.id) return null;
  return <NoteEditorPage key={match.params.id} id={match.params.id} />;
}
