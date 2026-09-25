import { useQuery } from '@tanstack/react-query';

// A background import's state, as the server tracks it. The same shape arrives
// over SignalR ("ImportProgress") while the job runs and from GET
// /api/import/status on mount — so leaving Settings mid-import and coming back
// shows the bar again instead of offering to start a second import.
export interface ImportStatus {
  jobId: string;
  provider: 'obsidian' | 'keep' | string;
  processed: number;
  total: number;
  done: boolean;
  error?: string | null;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export const IMPORT_STATUS_KEY = ['importStatus'] as const;

async function fetchImportStatus(): Promise<ImportStatus | null> {
  const res = await fetch('/api/import/status');
  // 204 = never imported; anything else non-OK (the browser demo) = nothing to show.
  if (res.status === 204 || !res.ok) return null;
  return res.json();
}

export function useImportStatus() {
  return useQuery({
    queryKey: IMPORT_STATUS_KEY,
    queryFn: fetchImportStatus,
    // Always ask on mount: an import started in another tab has to show here too.
    staleTime: 0,
    // SignalR pushes every step; this slow poll only covers a dropped socket so a
    // running bar can never get stuck.
    refetchInterval: (query) => (query.state.data && !query.state.data.done ? 3000 : false),
  });
}

/** One sentence for a finished import, naming what was already there. */
export function importSummary(s: ImportStatus): string {
  if (s.error) return `Import failed: ${s.error}`;
  const parts: string[] = [];
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  parts.push(`${n(s.imported, 'new note')}`);
  if (s.updated) parts.push(`${n(s.updated, 'note')} updated to the imported version`);
  if (s.unchanged) parts.push(`${n(s.unchanged, 'note')} already here and identical — not imported again`);
  if (s.skipped) parts.push(`${s.skipped} skipped (trashed in the source or unreadable)`);
  return `Import finished: ${parts.join(', ')}.`;
}
