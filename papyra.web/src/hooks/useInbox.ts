import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccessRequests } from './useShares';

// Someone mentioned you in one of their notes. Access is the whole note or
// nothing: `text`/`title` are filled only when the note is shared with you
// (`shareId`); otherwise the entry says who and when, and offers to ask.
export interface InboxEntry {
  id: number;
  noteId: string;
  blockId: string;
  from: string;
  receivedUtc: string;
  title: string | null;
  text: string | null;
  /** Null until the recipient has opened their inbox. Drives the sidebar badge. */
  readUtc: string | null;
  /** False once the note is deleted, trashed or locked. */
  available: boolean;
  /** The share that lets you open the note, when there is one. */
  shareId: number | null;
  access: 'view' | 'edit' | null;
  /** You asked the author for access and they haven't answered yet. */
  requestPending: boolean;
}

export const INBOX_KEY = ['inbox'] as const;

async function fetchInbox(): Promise<InboxEntry[]> {
  const res = await fetch('/api/inbox');
  if (!res.ok) throw new Error(`GET /api/inbox failed: ${res.status}`);
  return res.json();
}

export function useInbox() {
  return useQuery({ queryKey: INBOX_KEY, queryFn: fetchInbox });
}

/**
 * The sidebar badge: mentions not yet looked at, plus access requests waiting
 * on a decision — both are things only the inbox can clear.
 */
export function useUnreadInboxCount(): number {
  const { data } = useInbox();
  const { data: requests } = useAccessRequests();
  return (data ?? []).filter((e) => !e.readUtc).length + (requests?.length ?? 0);
}

/**
 * Mark everything read. Called when the inbox page mounts: having the list on
 * screen is what "read" means here, so the badge clears on view rather than
 * requiring the user to click each entry. Dismissal stays a separate, explicit
 * act — it revokes the grant, this only silences the badge.
 */
export function useMarkInboxRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/inbox/read', { method: 'POST' });
      if (!res.ok) throw new Error(`POST /api/inbox/read failed: ${res.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INBOX_KEY }),
  });
}
