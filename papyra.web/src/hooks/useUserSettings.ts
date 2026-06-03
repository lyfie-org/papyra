import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSettings, getStats, updateSettings } from '../api/userApi';
import type { UpdateSettingsRequest } from '../types';

export const SETTINGS_KEY = ['user', 'settings'] as const;
export const STATS_KEY    = ['user', 'stats']    as const;

export function useUserSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn:  getSettings,
    staleTime: 60 * 1000,
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdateSettingsRequest) => updateSettings(req),
    onSuccess: (data) => qc.setQueryData(SETTINGS_KEY, data),
  });
}

export function useUserStats() {
  return useQuery({
    queryKey: STATS_KEY,
    queryFn:  getStats,
    staleTime: 30 * 1000,
  });
}
