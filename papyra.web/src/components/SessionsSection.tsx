import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor } from 'lucide-react';
import LoadingBar from './LoadingBar';
import RenameForm from './RenameForm';
import { SettingGroup } from './SettingRow';
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
  const [renaming, setRenaming] = useState<number | null>(null);
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
    <SettingGroup
      title="Signed-in devices"
      id="signed-in-devices"
      footer={others > 0 && (
        <button type="button" className="settings__btn settings__btn--quiet" onClick={() => void endOthers()}>
          <LogOut size={15} /> Sign out all other devices
        </button>
      )}
    >
      {isLoading && <div className="setting-row"><div className="setting-row__line"><LoadingBar label="Loading devices" /></div></div>}
      {(data ?? []).map(s => (
        <div key={s.id} className={`setting-row${renaming === s.id ? ' is-open' : ''}`}>
          <div className="setting-row__line">
            <Monitor size={18} aria-hidden="true" className="sessions__icon" />
            <div className="setting-row__text">
              <span className="setting-row__value">
                {s.label}{s.current && <span className="sessions__here"> · this device</span>}
              </span>
              <span className="setting-row__hint">
                {s.current ? 'Active now' : `Last active ${parseUtc(s.lastSeenUtc).toLocaleString()}`}
                {s.ip ? ` · ${s.ip.replace(/^::ffff:/, '')}` : ''}{s.remember ? ' · remembered' : ''}
              </span>
            </div>
            {renaming !== s.id && (
              <button type="button" className="setting-row__action" onClick={() => setRenaming(s.id)}>Rename</button>
            )}
            {!s.current && renaming !== s.id && (
              <button type="button" className="setting-row__action" onClick={() => void end(s)}>Sign out</button>
            )}
          </div>
          {renaming === s.id && (
            <div className="setting-row__editor">
              <RenameForm url={`/api/auth/sessions/${s.id}`} current={s.label} placeholder="e.g. Office laptop"
                onDone={async () => { await queryClient.invalidateQueries({ queryKey: ['sessions'] }); setRenaming(null); }}
                onCancel={() => setRenaming(null)} />
            </div>
          )}
        </div>
      ))}
    </SettingGroup>
  );
}
