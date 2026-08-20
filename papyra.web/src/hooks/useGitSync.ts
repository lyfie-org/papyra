import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// Git mirroring config (admin, whole instance).
//
// Worth knowing before touching any of this: the mirrored repository is the
// entire users/ directory, so a sync pushes EVERY tenant's notes and media to
// this one remote — not only the signed-in admin's vault. The API documents it
// on the endpoint; the Sync tab states it in the UI, which is where an admin
// actually is when they paste a remote URL.
export interface GitConfig {
  remoteUrl: string;
  branch: string;
  hasToken: boolean;
  conflict: boolean;
  lastSyncUtc: string | null;
  lastError: string | null;
}

export interface GitConfigWrite {
  remoteUrl: string;
  branch: string;
  // Omitted (undefined) leaves the stored token untouched, so saving the form
  // without retyping a token doesn't wipe it.
  token?: string;
}

export interface GitSyncResult {
  status: string;   // 'pushed' | 'clean' | 'conflict'
  detail: string | null;
}

async function fetchGitConfig(): Promise<GitConfig> {
  const res = await fetch('/api/git');
  if (!res.ok) throw new Error(`GET /api/git failed: ${res.status}`);
  return res.json();
}

export function useGitConfig(enabled = true) {
  return useQuery({ queryKey: ['git'], queryFn: fetchGitConfig, enabled });
}

export function useSaveGitConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (next: GitConfigWrite) => {
      const res = await fetch('/api/git', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`PUT /api/git failed: ${res.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['git'] }),
  });
}

export function useRunGitSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<GitSyncResult> => {
      const res = await fetch('/api/git/sync', { method: 'POST' });
      if (!res.ok) throw new Error(`POST /api/git/sync failed: ${res.status}`);
      return res.json();
    },
    // The run updates lastSyncUtc / lastError / conflict server-side.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['git'] }),
  });
}
