import client from './client';
import type { AdminUser, AdminCreateUserRequest, GlobalSettings, RoleModel, SmtpSettingsRequest } from '../types';

export async function listUsers(): Promise<AdminUser[]> {
  const { data } = await client.get<AdminUser[]>('/api/admin/users');
  return data;
}

export async function changeUserRole(username: string, role: string): Promise<AdminUser> {
  const { data } = await client.put<AdminUser>(`/api/admin/users/${username}/role`, { role });
  return data;
}

export async function listRoles(): Promise<RoleModel[]> {
  const { data } = await client.get<RoleModel[]>('/api/admin/roles');
  return data;
}

export async function updateRole(
  roleName: string,
  patch: Partial<Omit<RoleModel, 'name'>>,
): Promise<RoleModel> {
  const { data } = await client.put<RoleModel>(`/api/admin/roles/${roleName}`, patch);
  return data;
}

export async function createUser(req: AdminCreateUserRequest): Promise<AdminUser> {
  const { data } = await client.post<AdminUser>('/api/admin/users', req);
  return data;
}

export async function getAdminSettings(): Promise<GlobalSettings> {
  const { data } = await client.get<GlobalSettings>('/api/admin/settings');
  return data;
}

export async function toggleRegistration(): Promise<GlobalSettings> {
  const { data } = await client.post<GlobalSettings>('/api/admin/settings/toggle-registration');
  return data;
}

export async function toggleEmailVerification(): Promise<GlobalSettings> {
  const { data } = await client.post<GlobalSettings>('/api/admin/settings/toggle-email-verification');
  return data;
}

export async function saveSmtpSettings(req: SmtpSettingsRequest): Promise<GlobalSettings> {
  const { data } = await client.put<GlobalSettings>('/api/admin/settings/smtp', req);
  return data;
}

export async function testSmtp(toAddress?: string): Promise<{ success: boolean; error?: string }> {
  const { data } = await client.post('/api/admin/settings/smtp/test', { toAddress });
  return data;
}
