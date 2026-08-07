import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// App settings (currently just trash retention). -1 = keep forever, 0 = purge
// immediately (trashing becomes a permanent delete), else N days.
export interface Settings {
  trashRetentionDays: number;
}

export const RETENTION_OPTIONS = [
  { value: -1, label: 'Keep forever' },
  { value: 0, label: 'Delete immediately' },
  { value: 3, label: 'After 3 days' },
  { value: 7, label: 'After 7 days' },
  { value: 30, label: 'After 30 days' },
  { value: 60, label: 'After 60 days' },
] as const;

async function fetchSettings(): Promise<Settings> {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error(`GET /api/settings failed: ${res.status}`);
  return res.json();
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (next: Settings) => {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(`PUT /api/settings failed: ${res.status}`);
      return res.json() as Promise<Settings>;
    },
    onSuccess: (data) => queryClient.setQueryData(['settings'], data),
  });
}
