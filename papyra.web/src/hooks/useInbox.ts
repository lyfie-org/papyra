import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// One block another user pinged you with. `text` is null when the source note
// has since been deleted or locked — the grant is block-scoped, so there is
// nothing else to fall back to and the entry says so plainly.
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

/** Count of entries the recipient hasn't looked at yet — the sidebar badge. */
export function useUnreadInboxCount(): number {
  const { data } = useInbox();
  return (data ?? []).filter((e) => !e.readUtc).length;
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
