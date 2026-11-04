import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// The accounts-and-settings backup (Settings → Instance backup, administrators).
// Notes are not in it; those are the files, or each account's own backup. The
// passphrase and the git token are write-only: the server says whether one is
// saved, never what it is, so a blank field on save means "keep what you have".

export interface InstanceCopy { name: string; bytes: number; modifiedUtc: string }

export interface InstanceBackupStatus {
  passphraseSet: boolean;
  local: boolean;
  keep: number;
  gitRemote: string;
  gitBranch: string;
  gitTokenSet: boolean;
  lastLocalUtc: string | null;
  lastGitUtc: string | null;
  lastError: string | null;
  copies: InstanceCopy[];
}

export interface InstanceBackupWrite {
  /** Omit to keep the saved passphrase. */
  passphrase?: string;
  local: boolean;
  keep: number;
  /** Blank turns the git copy off. */
  gitRemote: string;
  gitBranch: string;
  /** Omit to keep the saved token. */
  gitToken?: string;
}

/** What a checked backup holds, before anything is replaced. */
export interface InstanceRestoreSummary {
  restoreId: string;
  users: number;
  createdUtc: string | null;
  schema: string | null;
}

export type RestoreSource =
  | { kind: 'file'; file: File }
  | { kind: 'git'; remoteUrl: string; branch: string; token: string };

export const INSTANCE_BACKUP_KEY = ['instance-backup'] as const;

async function parse<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json().catch(() => null) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error ?? fallback);
  return data as T;
}

export function useInstanceBackup() {
  return useQuery({
    queryKey: INSTANCE_BACKUP_KEY,
    queryFn: async () => parse<InstanceBackupStatus>(await fetch('/api/instance-backup'), 'Couldn’t load the instance backup settings.'),
  });
}

export function useSaveInstanceBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: InstanceBackupWrite) => parse<InstanceBackupStatus>(
      await fetch('/api/instance-backup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      'Couldn’t save the settings.',
    ),
    onSuccess: status => qc.setQueryData(INSTANCE_BACKUP_KEY, status),
  });
}

/** Run the daily pass now: a local copy and/or a push to git, as set up. */
export function useRunInstanceBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => parse<InstanceBackupStatus>(
      await fetch('/api/instance-backup/run', { method: 'POST' }), 'The backup didn’t run.'),
    onSuccess: status => qc.setQueryData(INSTANCE_BACKUP_KEY, status),
  });
}

/** The multipart body both restore routes take. */
export function restoreForm(source: RestoreSource, passphrase: string, currentPassword?: string): FormData {
  const form = new FormData();
  form.append('kind', source.kind);
  form.append('passphrase', passphrase);
  if (currentPassword !== undefined) form.append('currentPassword', currentPassword);
  if (source.kind === 'file') {
    form.append('file', source.file, source.file.name);
  } else {
    form.append('remoteUrl', source.remoteUrl);
    form.append('branch', source.branch);
    form.append('token', source.token);
  }
  return form;
}

/**
 * Check a backup without changing anything live (an administrator, on a running
 * Papyra). Resolves with what it holds, or rejects with a message to show.
 */
export async function stageInstanceRestore(form: FormData): Promise<InstanceRestoreSummary> {
  return parse(await fetch('/api/instance-backup/restore/stage', { method: 'POST', body: form }), 'That backup couldn’t be read.');
}

/** Replace this server's accounts and settings with the staged backup. The server stops itself afterwards. */
export async function applyInstanceRestore(restoreId: string): Promise<void> {
  await parse(await fetch('/api/instance-backup/restore/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restoreId }),
  }), 'The restore didn’t start.');
}

/**
 * After a restore the server stops itself and starts on the restored data. Wait
 * for that: it must be seen going away and then answering again. 'stopped' means
 * it never came back (no restart policy, or a development run), so the person
 * has to start it.
 */
export async function waitForRestart(signal: AbortSignal): Promise<'back' | 'stopped'> {
  const deadline = Date.now() + 3 * 60_000;
  let wentDown = false;
  while (Date.now() < deadline && !signal.aborted) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const res = await fetch('/health', { cache: 'no-store' });
      if (res.ok && wentDown) return 'back';
    } catch {
      wentDown = true;
    }
  }
  return 'stopped';
}
