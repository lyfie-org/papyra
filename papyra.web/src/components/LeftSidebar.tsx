import { NavLink } from 'react-router-dom';
import { FileText, Archive, Trash } from '@phosphor-icons/react';
import { useServerStatus } from '../hooks/useServerStatus';
import { useLayout } from '../context/LayoutContext';
import { useOfflineQueue } from '../context/OfflineQueueContext';
import './LeftSidebar.css';

const links = [
  { to: '/',        label: 'Notes',   icon: FileText, end: true  },
  { to: '/archive', label: 'Archive', icon: Archive,  end: false },
  { to: '/trash',   label: 'Trash',   icon: Trash,    end: false },
] as const;

const APP_VERSION = 'internal-dev';

export default function LeftSidebar() {
  const serverStatus = useServerStatus();
  const { isMobileNavOpen, closeMobileNav } = useLayout();
  const { pendingCount, isSyncing } = useOfflineQueue();
  const isOnline   = serverStatus === 'online';
  const isChecking = serverStatus === 'checking';

  return (
    <>
      {/* Backdrop — mobile only, tapping it closes the drawer */}
      {isMobileNavOpen && (
        <div
          className="left-sidebar__backdrop"
          onClick={closeMobileNav}
          aria-hidden="true"
        />
      )}

      <aside className={`left-sidebar${isMobileNavOpen ? ' left-sidebar--open' : ''}`}>
        <nav aria-label="Main navigation">
          <ul className="left-sidebar__nav" role="list">
            {links.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  onClick={closeMobileNav}
                  className={({ isActive }) =>
                    ['left-sidebar__link', isActive ? 'left-sidebar__link--active' : '']
                      .filter(Boolean).join(' ')
                  }
                >
                  <Icon size={18} aria-hidden="true" />
                  <span className="left-sidebar__label">{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="left-sidebar__status" aria-live="polite">
          <div className="left-sidebar__status-left">
            <span
              className={[
                'left-sidebar__status-dot',
                isOnline   ? 'left-sidebar__status-dot--online'   : '',
                isChecking ? 'left-sidebar__status-dot--checking' : '',
              ].filter(Boolean).join(' ')}
              aria-hidden="true"
            />
            <span className="left-sidebar__status-label">
              {isChecking ? 'Connecting…' : isOnline ? 'Server Online' : 'Server Offline'}
            </span>
          </div>
          <div className="left-sidebar__status-right">
            {(pendingCount > 0 || isSyncing) && (
              <span
                className={`left-sidebar__sync-badge${isSyncing ? ' left-sidebar__sync-badge--syncing' : ''}`}
                title={isSyncing ? 'Syncing changes…' : `${pendingCount} change${pendingCount !== 1 ? 's' : ''} pending`}
              >
                {isSyncing ? '↑' : pendingCount}
              </span>
            )}
            <span className="left-sidebar__status-version">{APP_VERSION}</span>
          </div>
        </div>
      </aside>
    </>
  );
}
