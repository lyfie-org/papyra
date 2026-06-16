import { useQuery } from '@tanstack/react-query';

// A sync-tool conflict copy shadowing a parent note, as listed by the API.
export interface Conflict {
  id: string;
  parentId: string;
  parentTitle: string;
  conflictTitle: string;
  detected: string;
}

async function fetchConflicts(): Promise<Conflict[]> {
  const res = await fetch('/api/conflicts');
  if (!res.ok) throw new Error(`GET /api/conflicts failed: ${res.status}`);
  return res.json();
}

// Lists unresolved conflict copies. The grid uses this to flag the parent notes
// that need attention; the SignalR bridge invalidates ['conflicts'] on change.
export function useConflicts() {
  return useQuery({ queryKey: ['conflicts'], queryFn: fetchConflicts });
}
