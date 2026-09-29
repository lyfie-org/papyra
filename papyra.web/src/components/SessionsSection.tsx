import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor } from 'lucide-react';
import LoadingBar from './LoadingBar';
import { useConfirm } from '../lib/confirmContext';
import { parseUtc } from '../lib/vault';
import './SessionsSection.css';

interface Session {
  id: number;
  label: string;
  method: string;
  remember: boolean;
  ip: string | null;
  createdUtc: string;
  lastSeenUtc: string;
  current: boolean;
}

/**
 * Settings → Security → Signed-in devices: every browser signed in to this
 * account, and a way to sign any of them out (it ends on its next request).
 */
export default function SessionsSection() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<Session[]>({
    queryKey: ['sessions'],
    queryFn: async () => {
      const res = await fetch('/api/auth/sessions');
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    },
  });

  async function end(s: Session) {
    if (!(await confirm({
      title: 'Sign out this device?',
      body: `${s.label} will need to sign in again.`,
      confirmLabel: 'Sign out',
      destructive: true,
    }))) return;
    await fetch(`/api/auth/sessions/${s.id}`, { method: 'DELETE' });
    await queryClient.invalidateQueries({ queryKey: ['sessions'] });
  }

  async function endOthers() {
    if (!(await confirm({
      title: 'Sign out everywhere else?',
      body: 'Every other device will need to sign in again, and remembered devices will ask for a code.',
      confirmLabel: 'Sign out others',
      destructive: true,
    }))) return;
    await fetch('/api/auth/sessions/revoke-others', { method: 'POST' });
    await queryClient.invalidateQueries({ queryKey: ['sessions'] });
  }

  const others = (data ?? []).filter(s => !s.current).length;

  return (
    <>
      <h2 id="signed-in-devices" className="settings__subhead">Signed-in devices</h2>
      {isLoading && <LoadingBar label="Loading devices" />}
      {data && (
        <ul className="sessions">
          {data.map(s => (
            <li key={s.id} className="sessions__row">
              <Monitor size={18} aria-hidden="true" className="sessions__icon" />
              <span className="sessions__text">
                <span className="sessions__label">
                  {s.label}{s.current && <span className="sessions__here"> · this device</span>}
                </span>
                <span className="sessions__meta">
                  {s.current ? 'Active now' : `Last active ${parseUtc(s.lastSeenUtc).toLocaleString()}`}
                  {s.ip ? ` · ${s.ip}` : ''}{s.remember ? ' · remembered' : ''}
                </span>
              </span>
              {!s.current && (
                <button type="button" className="settings__link settings__link--danger" onClick={() => void end(s)}>
                  <LogOut size={13} /> Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {others > 0 && (
        <button type="button" className="settings__btn settings__btn--quiet" onClick={() => void endOthers()}>
          <LogOut size={15} /> Sign out all other devices
        </button>
      )}
    </>
  );
}
