import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type NotificationKind =
  | 'mention'
  | 'shared'
  | 'access_upgraded'
  | 'access_requested'
  | 'access_approved'
  | 'access_denied'
  | 'comment'
  | 'comment_reply'
  | 'comment_mention';

/**
 * One entry in the bell. What it may show of the note (title, the mentioning
 * line) is decided by the server against live shares, so a null `title` means
 * "you can't see this note", not "untitled".
 */
export interface AppNotification {
  id: number;
  kind: NotificationKind;
  createdUtc: string;
  readUtc: string | null;
  noteId: string;
  access: 'view' | 'edit' | null;
  actor: string;
  actorName: string | null;
  title: string | null;
  text: string | null;
  /** False once the note is deleted, trashed or locked. */
  available: boolean;
  /** The note is the caller's own (access requests on their notes). */
  mine: boolean;
  /** The caller's share of the note, when they have one. */
  shareId: number | null;
  shareAccess: 'view' | 'edit' | null;
  requestId: number | null;
  requestStatus: 'pending' | 'approved' | 'denied' | null;
  /** The caller has asked for access to this note and is still waiting. */
  requestPending: boolean;
  /** comment_* events: the thread to open the note at. */
  threadId?: number | null;
}

export const NOTIFICATIONS_KEY = ['notifications'] as const;

export function useNotifications() {
  return useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: async (): Promise<AppNotification[]> => {
      const res = await fetch('/api/notifications');
      if (!res.ok) throw new Error(`GET /api/notifications failed: ${res.status}`);
      return res.json();
    },
  });
}

/** Unread entries, plus access requests still waiting on me — the bell badge. */
export function useNotificationBadge(): number {
  const { data } = useNotifications();
  return (data ?? []).filter(n => !n.readUtc
    || (n.kind === 'access_requested' && n.requestStatus === 'pending')).length;
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/notifications/read', { method: 'POST' });
      if (!res.ok) throw new Error(`POST /api/notifications/read failed: ${res.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useDismissNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/notifications/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`DELETE notification failed: ${res.status}`);
    },
    onMutate: (id) => {
      queryClient.setQueryData<AppNotification[]>(NOTIFICATIONS_KEY, old => old?.filter(n => n.id !== id));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}
