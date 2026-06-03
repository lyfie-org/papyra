import client from './client';
import type { UpdateSettingsRequest, UserSettings, UserStats } from '../types';

export async function getSettings(): Promise<UserSettings> {
  const { data } = await client.get<UserSettings>('/api/user/settings');
  return data;
}

export async function updateSettings(patch: UpdateSettingsRequest): Promise<UserSettings> {
  const { data } = await client.put<UserSettings>('/api/user/settings', patch);
  return data;
}

export async function getStats(): Promise<UserStats> {
  const { data } = await client.get<UserStats>('/api/user/stats');
  return data;
}

export async function archiveNote(noteId: string): Promise<void> {
  await client.patch(`/api/notes/${noteId}/archive`);
}

export async function restoreNote(noteId: string): Promise<void> {
  await client.patch(`/api/notes/${noteId}/restore`);
}

export async function trashNote(noteId: string): Promise<void> {
  await client.patch(`/api/notes/${noteId}/trash`);
}

export async function restoreFromTrash(noteId: string): Promise<void> {
  await client.patch(`/api/notes/${noteId}/restore-trash`);
}

export async function getSharedNotes() {
  const { data } = await client.get('/notes/shared');
  return data;
}
