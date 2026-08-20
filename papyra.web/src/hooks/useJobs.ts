import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface JobRun {
  startedUtc: string;
  finishedUtc: string;
  ok: boolean;
  summary: string | null;
  error: string | null;
  durationMs: number;
}

export interface Job {
  id: string;
  name: string;
  description: string;
  kind: 'periodic' | 'continuous';
  /** Null for always-on work, which has no schedule. */
  intervalSeconds: number | null;
  running: boolean;
  canTrigger: boolean;
  lastRun: JobRun | null;
}

export const JOBS_KEY = ['jobs'] as const;

/**
 * What Papyra does in the background. Admin-only, so this is only ever mounted
 * behind that check — a non-admin gets a 403 and the query simply fails.
 *
 * Polled while the tab is open: a sweep started here finishes on the server, and
 * a screen that needed a manual refresh to show the outcome would be worse than
 * no screen at all.
 */
export function useJobs(enabled: boolean) {
  return useQuery({
    queryKey: JOBS_KEY,
    enabled,
    refetchInterval: 5_000,
    queryFn: async (): Promise<Job[]> => {
      const res = await fetch('/api/jobs');
      if (!res.ok) throw new Error(`GET /api/jobs failed: ${res.status}`);
      return res.json();
    },
  });
}

export function useRunJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<JobRun> => {
      const res = await fetch(`/api/jobs/${encodeURIComponent(id)}/run`, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? 'Couldn’t run that job.');
      return body as JobRun;
    },
    // The list carries the same outcome, so refresh rather than patch it in:
    // one source for what happened.
    onSettled: () => queryClient.invalidateQueries({ queryKey: JOBS_KEY }),
  });
}
