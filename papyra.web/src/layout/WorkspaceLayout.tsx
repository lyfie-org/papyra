import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Menu, StickyNote, ListTodo, Tags, Archive, Settings, Trash2,
  User, Shield, LogOut, Sun, Moon, Share2, Layers, Sparkles,
} from 'lucide-react';
import ChatPanel from '../components/ChatPanel';
import { useTheme } from '../hooks/useTheme';
import { useSignalR } from '../hooks/useSignalR';
import { useAuth } from '../hooks/useAuth';
import logo from '../assets/papyra_logo.png';
import './WorkspaceLayout.css';

const NAV_ITEMS = [
  { to: '/', label: 'Notes', icon: StickyNote, end: true },
  { to: '/todo', label: 'To Do', icon: ListTodo, end: false },
  { to: '/categories', label: 'Categories', icon: Tags, end: false },
  { to: '/collections', label: 'Collections', icon: Layers, end: false },
  { to: '/shared-with-me', label: 'Shared', icon: Share2, end: false },
  { to: '/archive', label: 'Archive', icon: Archive, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
] as const;

export default function WorkspaceLayout() {
  const { theme, toggleTheme } = useTheme();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const serverStatus = useSignalR();

  const isAdmin = user?.role === 'Admin';
  const initial = (user?.name || user?.username || 'P').trim().charAt(0).toUpperCase();

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
          <img className="workspace__logo" src={logo} alt="" aria-hidden="true" />
          <span className="workspace__wordmark">Papyra</span>
        </div>
        <div className="workspace__nav-actions">
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
          <button
            type="button"
            className="workspace__theme-toggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
            title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          >
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <div className="workspace__avatar-wrap" ref={menuRef}>
            <button
              type="button"
              className="workspace__avatar"
              aria-label="Account menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(o => !o)}
            >
              <span aria-hidden="true">{initial}</span>
            </button>
            {menuOpen && (
              <div className="workspace__avatar-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => go('/settings?tab=profile')}>
                  <User size={15} /> Profile
                </button>
                <button type="button" role="menuitem" onClick={() => go('/settings')}>
                  <Settings size={15} /> Settings
                </button>
                {isAdmin && (
                  <button type="button" role="menuitem" onClick={() => go('/settings?tab=admin')}>
                    <Shield size={15} /> Administration
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
                </NavLink>
              </li>
            ))}
          </ul>

          <div className="workspace__sidebar-bottom">
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

            <footer className="workspace__sidebar-footer">
              <span
                className={`workspace__status-dot workspace__status-dot--${serverStatus}`}
                aria-hidden="true"
              />
              <span className="workspace__status-label workspace__nav-label">
                {serverStatus === 'online' ? 'Server Online' : 'Server Offline'}
              </span>
            </footer>
          </div>
        </nav>

        <main className="workspace__desk">
          <Outlet />
        </main>
      </div>

      {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
    </div>
  );
}
