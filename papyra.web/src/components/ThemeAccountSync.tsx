import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth, type AuthUser } from '../hooks/useAuth';
import { useTheme, type ThemePreference } from '../hooks/useTheme';

async function saveTheme(theme: ThemePreference): Promise<void> {
  await fetch('/api/auth/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
  }).catch(() => { /* best effort: the local choice still applies */ });
}

/**
 * Keeps the theme on the account, not just in this browser. Signing in anywhere
 * opens in the account's theme; picking one here (toggle or Settings) saves it
 * back, so the next sign-in elsewhere follows. An account that never chose one
 * adopts whatever this browser was already showing.
 *
 * Renders nothing. Mount once per signed-in session, keyed by user id.
 */
export default function ThemeAccountSync() {
  const { user } = useAuth();
  const { preference, setPreference } = useTheme();
  const queryClient = useQueryClient();
  // What the account and this browser last agreed on.
  const synced = useRef<ThemePreference | null>(null);
  const server = (user?.theme ?? null) as ThemePreference | null;

  useEffect(() => {
    if (!user) return;
    const remember = (theme: ThemePreference) => {
      synced.current = theme;
      queryClient.setQueryData<{ state: string; user: AuthUser | null }>(['auth'], old =>
        old?.user ? { ...old, user: { ...old.user, theme } } : old);
    };

    if (synced.current === null) {
      if (server) {
        synced.current = server;
        if (server !== preference) setPreference(server);
      } else {
        remember(preference);
        void saveTheme(preference);
      }
      return;
    }
    if (preference !== synced.current) {
      // Picked here: the account follows.
      remember(preference);
      void saveTheme(preference);
    } else if (server && server !== synced.current) {
      // Changed on another device and seen on the next /me: this browser follows.
      synced.current = server;
      setPreference(server);
    }
  }, [user, server, preference, setPreference, queryClient]);

  return null;
}
