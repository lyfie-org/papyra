import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export type LogLevel = 'error' | 'warning' | 'info';

export interface LogEntry {
  id: string;
  timeUtc: string;
  level: LogLevel;
  /** A class name ("TrashPurgeService"), or "Browser". */
  source: string;
  message: string;
  exception: { type: string; message: string; stack: string } | null;
}

interface LogPage {
  retentionHours: number;
  entries: LogEntry[];
  hasMore: boolean;
}

export const LOGS_KEY = ['logs'] as const;

/** Choices for "Keep logs for", in hours (the server accepts only these). */
export const LOG_RETENTION_OPTIONS = [
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 336, label: '14 days' },
  { hours: 720, label: '30 days' },
] as const;

/**
 * The instance log, newest first, a page at a time ("Load more" asks for what
 * came before the oldest entry shown). Admin-only — mounted behind that check.
 */
export function useLogs(level: LogLevel | null) {
  return useInfiniteQuery({
    queryKey: [...LOGS_KEY, level],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<LogPage> => {
      const params = new URLSearchParams({ limit: '100' });
      if (level) params.set('level', level);
      if (pageParam) params.set('before', pageParam);
      const res = await fetch(`/api/logs?${params}`);
      if (!res.ok) throw new Error(`GET /api/logs failed: ${res.status}`);
      return res.json();
    },
    getNextPageParam: (last) => (last.hasMore ? last.entries.at(-1)?.timeUtc ?? null : null),
  });
}

export function useSetLogRetention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (hours: number) => {
      const res = await fetch('/api/logs/retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours }),
      });
      if (!res.ok) throw new Error('Couldn’t save the setting.');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: LOGS_KEY }),
  });
}

export function useClearLogs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/logs', { method: 'DELETE' });
      if (!res.ok) throw new Error('Couldn’t clear the logs.');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: LOGS_KEY }),
  });
}
