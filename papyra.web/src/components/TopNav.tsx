import { useRef, useState } from 'react';
import { Moon, Sun, User, SquaresFour, Rows, MagnifyingGlass, List } from '@phosphor-icons/react';
import { useTheme } from '../hooks/useTheme';
import { useLayout } from '../context/LayoutContext';
import ProfileDropdown from './ProfileDropdown';
import papyraLogo from '../assets/papyra_logo.png';
import './TopNav.css';

export default function TopNav() {
  const { theme, toggleTheme } = useTheme();
  const { viewMode, setViewMode, toggleMobileNav, isMobileNavOpen, openSearch } = useLayout();

  const avatarRef = useRef<HTMLButtonElement>(null);
  const [profileOpen, setProfileOpen] = useState(false);

  return (
    <header className="top-nav">
      <button
        className="top-nav__burger"
        onClick={toggleMobileNav}
        aria-label={isMobileNavOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={isMobileNavOpen}
      >
        <List size={20} aria-hidden="true" />
      </button>

      <div className="top-nav__brand">
        <img
          src={papyraLogo}
          className="top-nav__logo-img"
          alt=""
          height={32}
          aria-hidden="true"
        />
        <span className="top-nav__wordmark" aria-label="Papyra">Papyra</span>
      </div>

      <div className="top-nav__actions">
        <button
          className="top-nav__search-btn"
          onClick={openSearch}
          aria-label="Search notes (Cmd+K)"
          title="Search (Cmd+K)"
        >
          <MagnifyingGlass size={18} aria-hidden="true" />
        </button>

        <button
          className={`top-nav__view-btn${viewMode === 'list' ? ' top-nav__view-btn--active' : ''}`}
          onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
          aria-label={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
          title={viewMode === 'grid' ? 'List view' : 'Grid view'}
          aria-pressed={viewMode === 'list'}
        >
          {viewMode === 'grid'
            ? <Rows size={18} aria-hidden="true" />
            : <SquaresFour size={18} aria-hidden="true" />}
        </button>

        <button
          className="top-nav__theme-btn"
          onClick={toggleTheme}
          aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          title={theme === 'light' ? 'Dark mode' : 'Light mode'}
        >
          {theme === 'light'
            ? <Moon size={18} aria-hidden="true" />
            : <Sun  size={18} aria-hidden="true" />}
        </button>

        <div className="top-nav__avatar-wrap">
          <button
            ref={avatarRef}
            className={`top-nav__avatar${profileOpen ? ' top-nav__avatar--active' : ''}`}
            onClick={() => setProfileOpen(v => !v)}
            aria-label="Open profile menu"
            aria-expanded={profileOpen}
            aria-haspopup="dialog"
          >
            <User size={18} aria-hidden="true" />
          </button>

          {profileOpen && (
            <ProfileDropdown
              triggerRef={avatarRef}
              onClose={() => setProfileOpen(false)}
            />
          )}
        </div>
      </div>
    </header>
  );
}
