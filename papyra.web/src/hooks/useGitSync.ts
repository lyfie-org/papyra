import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// Git backup of the signed-in person's own vault. Per account: each person has
// their own remote, token and schedule, and nobody can see or change another's.
export interface GitConfig {
  remoteUrl: string;
  branch: string;
  hasToken: boolean;
  conflict: boolean;
  lastSyncUtc: string | null;
  lastError: string | null;
  /** 'encrypted': every file sealed, unlocked by the account password. */
  mode: 'plain' | 'encrypted';
}

export interface GitConfigWrite {
  remoteUrl: string;
  branch: string;
  // Omitted (undefined) leaves the stored token untouched, so saving the form
  // without retyping a token doesn't wipe it.
  token?: string;
  /** Omitted keeps the current mode. */
  mode?: 'plain' | 'encrypted';
  /** The account password — required to turn encryption on. */
  password?: string;
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
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(data?.error ?? `PUT /api/git failed: ${res.status}`);
      }
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

export type GitProbe =
  | { ok: true; empty: boolean; branches: string[] }
  | { ok: false; error: string };

/** Try an address + token without saving them (the setup guide's check step). */
export async function probeGitRemote(remoteUrl: string, token?: string): Promise<GitProbe> {
  const res = await fetch('/api/git/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remoteUrl, branch: 'main', token: token || undefined }),
  });
  const data = await res.json().catch(() => null) as (GitProbe & { error?: string }) | null;
  if (!res.ok) return { ok: false, error: data?.error ?? 'Couldn’t check that repository.' };
  return data ?? { ok: false, error: 'Couldn’t check that repository.' };
}

export interface BackupSummary {
  version: number;
  legacy: boolean;
  counts: { notes: number; todos: number; vault: number; media: number };
  account: { username?: string; name?: string; email?: string; timeZone?: string; theme?: string } | null;
}

export type GitRestoreResult =
  | { ok: true; restored: number; summary: BackupSummary }
  | { ok: false; error: string; code?: string };

/**
 * Replace the signed-in account's notes, media and settings with a git backup
 * (plain or encrypted), and by default keep backing up to it.
 */
export async function restoreFromGit(req: {
  remoteUrl: string; branch?: string; token?: string; password?: string;
  keepSyncing?: boolean; accountPassword?: string;
}): Promise<GitRestoreResult> {
  const res = await fetch('/api/backups/restore-git', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keepSyncing: true, ...req }),
  });
  const data = await res.json().catch(() => null) as
    ({ restored: number; summary: BackupSummary } & { error?: string; code?: string }) | null;
  if (!res.ok || !data) return { ok: false, error: data?.error ?? 'The restore didn’t work.', code: data?.code };
  return { ok: true, restored: data.restored, summary: data.summary };
}
