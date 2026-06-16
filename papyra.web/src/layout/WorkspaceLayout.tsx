import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { useSignalR } from '../hooks/useSignalR';
import logo from '../assets/papyra_logo.png';
import './WorkspaceLayout.css';

const NAV_ITEMS = [
  { to: '/', label: 'Notes', end: true },
  { to: '/todo', label: 'To Do', end: false },
  { to: '/categories', label: 'Categories', end: false },
  { to: '/profile', label: 'Profile', end: false },
  { to: '/settings', label: 'Settings', end: false },
] as const;

export default function WorkspaceLayout() {
  const { theme, toggleTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const serverStatus = useSignalR();

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
            ☰
          </button>
          <img className="workspace__logo" src={logo} alt="" aria-hidden="true" />
          <span className="workspace__wordmark">Papyra</span>
        </div>
        <div className="workspace__nav-actions">
          <button
            type="button"
            className="workspace__theme-toggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          >
            {theme === 'light' ? 'Dark mode' : 'Light mode'}
          </button>
          <NavLink to="/profile" className="workspace__avatar" aria-label="Profile">
            <span aria-hidden="true">P</span>
          </NavLink>
        </div>
      </header>

      <div className="workspace__body">
        <nav className="workspace__sidebar" aria-label="Primary">
          <ul>
            {NAV_ITEMS.map(item => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `workspace__nav-link${isActive ? ' workspace__nav-link--active' : ''}`
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <footer className="workspace__sidebar-footer">
            <span
              className={`workspace__status-dot workspace__status-dot--${serverStatus}`}
              aria-hidden="true"
            />
            <span className="workspace__status-label">
              {serverStatus === 'online' ? 'Server Online' : 'Server Offline'}
            </span>
          </footer>
        </nav>

        <main className="workspace__desk">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
