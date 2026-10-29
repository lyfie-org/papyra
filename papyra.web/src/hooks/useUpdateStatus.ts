import { useQuery } from '@tanstack/react-query';
import { useAuth } from './useAuth';

/** What the server knows about a newer Papyra (admins only; see Storage/UpdateCheck.cs). */
export interface UpdateStatus {
  /** False on a build with no release number (a development build). */
  enabled: boolean;
  current: string;
  available: boolean;
  latest: string | null;
  url: string | null;
  checkedUtc: string | null;
  /** Everything the daily check sends, so the popup can show it rather than describe it. */
  sends: { id: string | null; version: string; arch: string; os: string };
}

const KEY = ['update-status'] as const;

/** The update status for an admin; null for everyone else (they are never asked). */
export function useUpdateStatus() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const query = useQuery<UpdateStatus>({
    queryKey: KEY,
    enabled: isAdmin,
    // The server asks once a day; looking now and then is enough.
    staleTime: 10 * 60_000,
    refetchInterval: 60 * 60_000,
    queryFn: async () => {
      const res = await fetch('/api/admin/update');
      if (!res.ok) throw new Error(`GET /api/admin/update failed: ${res.status}`);
      return res.json();
    },
  });
  return { status: isAdmin ? query.data ?? null : null };
}
