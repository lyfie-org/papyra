import { useRef, useEffect, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { GearSix, Wrench, SignOut, Pencil, Lifebuoy } from '@phosphor-icons/react';
import { useAuth, useLogout } from '../hooks/useAuth';
import './ProfileDropdown.css';

interface ProfileDropdownProps {
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export default function ProfileDropdown({ triggerRef, onClose }: ProfileDropdownProps) {
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const { mutate: logout } = useLogout();
  const { data: auth } = useAuth();

  const displayName = auth?.name ?? auth?.username ?? '';
  const displayEmail = auth?.email ?? '';
  const initials = displayName
    .split(' ')
    .slice(0, 2)
    .map(s => s[0]?.toUpperCase() ?? '')
    .join('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (
        panelRef.current?.contains(e.target as Node) ||
        triggerRef.current?.contains(e.target as Node)
      ) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose, triggerRef]);

  useEffect(() => { panelRef.current?.focus(); }, []);

  const go = (path: string) => { navigate(path); onClose(); };

  return (
    <div
      ref={panelRef}
      className="profile-dropdown"
      role="dialog"
      aria-label="Profile menu"
      tabIndex={-1}
    >
      {/* ── Identity ─────────────────────────────────────────────────── */}
      <div className="pd-identity">
        <div className="pd-avatar">
          <span className="pd-avatar__initials">{initials}</span>
          <button className="pd-avatar__edit-pill" aria-label="Edit avatar">
            <Pencil size={9} aria-hidden="true" weight="regular" />
          </button>
        </div>
        <p className="pd-name">{displayName}</p>
        <p className="pd-email">{displayEmail}</p>
      </div>

      {/* ── Action pills ──────────────────────────────────────────────── */}
      <div className="pd-actions">
        <button className="pd-action-btn" onClick={() => go('/settings')}>
          <span className="pd-action-btn__icon"><GearSix size={14} aria-hidden="true" /></span>
          Account Settings
        </button>
        <button className="pd-action-btn" onClick={() => go('/admin')}>
          <span className="pd-action-btn__icon"><Wrench size={14} aria-hidden="true" weight="regular" /></span>
          Administration
        </button>
      </div>

      <hr className="pd-divider" />

      {/* ── Sign out ──────────────────────────────────────────────────── */}
      <button className="pd-signout" onClick={() => { onClose(); logout(undefined, { onSuccess: () => navigate('/login') }); }}>
        <SignOut size={15} aria-hidden="true" />
        Sign Out
      </button>

      <hr className="pd-divider" />

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <button className="pd-support">
        <Lifebuoy size={12} aria-hidden="true" />
        Support &amp; Feedback
      </button>
    </div>
  );
}
