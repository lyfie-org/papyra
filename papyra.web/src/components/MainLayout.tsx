import { NavLink, Outlet } from 'react-router-dom';
import { BookOpen, House, Moon, GearSix, ShieldCheck, Sun } from '@phosphor-icons/react';
import { useTheme } from '../hooks/useTheme';
import './MainLayout.css';

const navLinks = [
  { to: '/',         label: 'Home',     icon: House,       end: true  },
  { to: '/settings', label: 'Settings', icon: GearSix,     end: false },
  { to: '/admin',    label: 'Admin',    icon: ShieldCheck, end: false },
];

export default function MainLayout() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="layout-shell">
      <nav className="main-nav">
        {/* Brand — icon + wordmark */}
        <span className="main-nav__brand" aria-label="Papyra home">
          <BookOpen className="main-nav__brand-icon" size={22} aria-hidden="true" weight="regular" />
          Papyra
        </span>

        <ul className="main-nav__links" role="list">
          {navLinks.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  ['main-nav__link', isActive ? 'main-nav__link--active' : ''].join(' ').trim()
                }
              >
                <Icon size={16} aria-hidden="true" />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>

        {/* Theme toggle — pushed to far right */}
        <button
          className="nav-theme-toggle"
          onClick={toggleTheme}
          aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          title={theme === 'light' ? 'Dark mode' : 'Light mode'}
        >
          {theme === 'light'
            ? <Moon size={18} aria-hidden="true" />
            : <Sun  size={18} aria-hidden="true" />}
        </button>
      </nav>

      <main className="main-content">
        <Outlet />
      </main>

      <footer className="main-footer">
        <span className="main-footer__text">
          Papyra&nbsp;
          <span className="main-footer__sep">//</span>
          &nbsp;Zero-DB Markdown Suite.&nbsp;
          <span className="main-footer__em">Crafted with local control.</span>
        </span>
      </footer>
    </div>
  );
}
