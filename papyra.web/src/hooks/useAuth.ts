import { useQuery } from '@tanstack/react-query';

export interface AuthUser {
  id: number;
  username: string;
  name: string;
  email: string;
  role: string;
  /**
   * An admin created or reset this account, so its password is one somebody else
   * chose. The API refuses everything but signing out and setting a new password
   * until it clears, and the workspace guard routes here on it rather than
   * letting every request on the page fail.
   */
  mustChangePassword?: boolean;
}

// 'setup' = no admin yet (428 → /setup); 'login' = unauthenticated (401 → /login);
// 'authed' = a valid session; 'error' = the server is unreachable.
export type AuthState = 'loading' | 'authed' | 'login' | 'setup' | 'error';

interface AuthProbe {
  state: Exclude<AuthState, 'loading'>;
  user: AuthUser | null;
}

async function probeAuth(): Promise<AuthProbe> {
  const res = await fetch('/api/auth/me');
  if (res.status === 428) return { state: 'setup', user: null };
  if (res.status === 401) return { state: 'login', user: null };
  if (!res.ok) return { state: 'error', user: null };
  return { state: 'authed', user: (await res.json()) as AuthUser };
}

export function useAuth() {
  const query = useQuery({
    queryKey: ['auth'],
    queryFn: probeAuth,
    // 401 and 428 are answers, not failures — probeAuth returns them as state and
    // never throws. The only thing left to retry is an unreachable server, which
    // is exactly what happens when the app loads while the server is still
    // starting: without this the whole app sat on "Couldn't reach the server"
    // until someone reloaded by hand.
    retry: 2,
    retryDelay: attempt => Math.min(1000 * 2 ** attempt, 4000),
  });
  const state: AuthState = query.isLoading ? 'loading' : (query.data?.state ?? 'error');
  return { state, user: query.data?.user ?? null, retry: () => void query.refetch() };
}
