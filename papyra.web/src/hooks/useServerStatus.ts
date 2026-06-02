import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NOTES_KEY } from './useNotes';

export type ServerStatus = 'online' | 'offline' | 'checking';

const POLL_ONLINE_MS  = 30_000;
const POLL_OFFLINE_MS = 10_000;
const TIMEOUT_MS      = 5_000;
const HEALTH_PATH     = '/health';

type QueryStatus = 'success' | 'error' | 'pending';

export function useServerStatus(): ServerStatus {
  const queryClient = useQueryClient();
  const [healthStatus, setHealthStatus]   = useState<ServerStatus>('checking');
  const [notesQueryStatus, setNotesQueryStatus] = useState<QueryStatus>(
    () => (queryClient.getQueryState(NOTES_KEY)?.status ?? 'pending'),
  );

  // Subscribe reactively to notes query cache changes
  useEffect(() => {
    const notesKeyStr = JSON.stringify(NOTES_KEY);
    return queryClient.getQueryCache().subscribe((event) => {
      if (JSON.stringify(event.query.queryKey) === notesKeyStr) {
        setNotesQueryStatus(event.query.state.status);
      }
    });
  }, [queryClient]);

  // Health-endpoint poll — fills the gap before notes query first settles,
  // and gives a direct signal independent of query retry logic.
  useEffect(() => {
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout>;
    const baseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

    const schedule = (isOnline: boolean) => {
      timerId = setTimeout(check, isOnline ? POLL_ONLINE_MS : POLL_OFFLINE_MS);
    };

    const check = async () => {
      try {
        const res = await fetch(`${baseUrl}${HEALTH_PATH}`, {
          method: 'GET',
          cache: 'no-store',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (cancelled) return;
        const online = res.ok;
        setHealthStatus(online ? 'online' : 'offline');
        schedule(online);
      } catch {
        if (cancelled) return;
        setHealthStatus('offline');
        schedule(false);
      }
    };

    const onFocus = () => { clearTimeout(timerId); check(); };
    check();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearTimeout(timerId);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // Notes query outcome is the most accurate real-world signal.
  // Health poll covers the initial "checking" window.
  if (notesQueryStatus === 'success') return 'online';
  if (notesQueryStatus === 'error')   return 'offline';
  return healthStatus;
}
