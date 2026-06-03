import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  changeUserRole, createUser, getAdminSettings, listRoles,
  listUsers, toggleRegistration, toggleEmailVerification,
  updateRole, saveSmtpSettings, testSmtp,
} from '../api/admin';
import type { AdminCreateUserRequest, RoleModel, SmtpSettingsRequest } from '../types';

export const ADMIN_USERS_KEY    = ['admin', 'users']    as const;
export const ADMIN_ROLES_KEY    = ['admin', 'roles']    as const;
export const ADMIN_SETTINGS_KEY = ['admin', 'settings'] as const;

export function useAdminUsers() {
  return useQuery({
    queryKey: ADMIN_USERS_KEY,
    queryFn:  listUsers,
    staleTime: 30 * 1000,
  });
}

export function useAdminRoles() {
  return useQuery({
    queryKey: ADMIN_ROLES_KEY,
    queryFn:  listRoles,
    staleTime: 60 * 1000,
  });
}

export function useChangeUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ username, role }: { username: string; role: string }) =>
      changeUserRole(username, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ADMIN_USERS_KEY }),
  });
}

export function useUpdateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, patch }: { name: string; patch: Partial<Omit<RoleModel, 'name'>> }) =>
      updateRole(name, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ADMIN_ROLES_KEY }),
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: AdminCreateUserRequest) => createUser(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: ADMIN_USERS_KEY }),
  });
}

export function useAdminSettings() {
  return useQuery({
    queryKey: ADMIN_SETTINGS_KEY,
    queryFn:  getAdminSettings,
    staleTime: 30 * 1000,
  });
}

export function useToggleRegistration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: toggleRegistration,
    onSuccess:  (updated) => qc.setQueryData(ADMIN_SETTINGS_KEY, updated),
  });
}

export function useToggleEmailVerification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: toggleEmailVerification,
    onSuccess:  (updated) => qc.setQueryData(ADMIN_SETTINGS_KEY, updated),
  });
}

export function useSaveSmtp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: SmtpSettingsRequest) => saveSmtpSettings(req),
    onSuccess:  (updated) => qc.setQueryData(ADMIN_SETTINGS_KEY, updated),
  });
}

export function useTestSmtp() {
  return useMutation({
    mutationFn: (toAddress?: string) => testSmtp(toAddress),
  });
}
