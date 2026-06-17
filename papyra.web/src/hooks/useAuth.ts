import { useQuery } from '@tanstack/react-query';

export interface AuthUser {
  id: number;
  username: string;
  name: string;
  email: string;
  role: string;
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
  const query = useQuery({ queryKey: ['auth'], queryFn: probeAuth, retry: false });
  const state: AuthState = query.isLoading ? 'loading' : (query.data?.state ?? 'error');
  return { state, user: query.data?.user ?? null };
}
