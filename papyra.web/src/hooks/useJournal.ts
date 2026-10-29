import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteTemplate, fetchBin, fetchOnThisDay, fetchPrefs, fetchRange, fetchStats, fetchTemplates, fetchToday, saveTemplate, savePrefs,
} from '../lib/journalApi';
import type {
  JournalPrefsPatch, JournalRange, JournalStats, JournalSummary, JournalTemplate, JournalToday,
} from '../types/journal';

// Query keys all start with 'journal', so one invalidation (`['journal']`) refreshes
// every surface after a write, a sync or a restore.
export const JOURNAL_KEY = ['journal'] as const;

/** Today's page, the streak and the preferences in one trip. The server decides what today is. */
export function useJournalToday() {
  return useQuery<JournalToday>({
    queryKey: [...JOURNAL_KEY, 'today'],
    queryFn: fetchToday,
    // The date can roll over while a tab sits open; never trust an old answer for long.
    staleTime: 60_000,
    retry: 1,
  });
}

/** Summaries for a span of days — a month on the calendar, a year on the heatmap. */
export function useJournalRange(from: string, to: string) {
  return useQuery<JournalRange>({
    queryKey: [...JOURNAL_KEY, 'range', from, to],
    queryFn: () => fetchRange(from, to),
    staleTime: 10_000,
    retry: 1,
  });
}

export function useJournalStats() {
  return useQuery<JournalStats>({
    queryKey: [...JOURNAL_KEY, 'stats'],
    queryFn: fetchStats,
    staleTime: 15_000,
  });
}

export function useOnThisDay(date: string) {
  return useQuery<JournalSummary[]>({
    queryKey: [...JOURNAL_KEY, 'on-this-day', date],
    queryFn: () => fetchOnThisDay(date),
    staleTime: 5 * 60_000,
  });
}

export function useJournalPrefs() {
  return useQuery({
    queryKey: [...JOURNAL_KEY, 'prefs'],
    queryFn: fetchPrefs,
    staleTime: 60_000,
  });
}

export function useSaveJournalPrefs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: JournalPrefsPatch) => savePrefs(patch),
    onSuccess: (data) => {
      queryClient.setQueryData([...JOURNAL_KEY, 'prefs'], data);
      // The day boundary and the lock default feed today's page too.
      void queryClient.invalidateQueries({ queryKey: [...JOURNAL_KEY, 'today'] });
    },
  });
}

/** Days set aside (archived, in the Trash) or locked (the Vault page), newest first. */
export function useJournalBin(state: 'archived' | 'trashed' | 'locked') {
  return useQuery<JournalSummary[]>({
    queryKey: [...JOURNAL_KEY, 'bin', state],
    queryFn: () => fetchBin(state),
    staleTime: 10_000,
  });
}

export function useJournalTemplates() {
  return useQuery<{ templates: JournalTemplate[]; defaultTemplate: string | null }>({
    queryKey: [...JOURNAL_KEY, 'templates'],
    queryFn: fetchTemplates,
    staleTime: 60_000,
  });
}

export function useSaveTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: string }) => saveTemplate(name, body),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: [...JOURNAL_KEY, 'templates'] }); },
  });
}

export function useDeleteTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => deleteTemplate(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...JOURNAL_KEY, 'templates'] });
      void queryClient.invalidateQueries({ queryKey: [...JOURNAL_KEY, 'prefs'] });
    },
  });
}
