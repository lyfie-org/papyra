import { useQuery } from '@tanstack/react-query';

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
