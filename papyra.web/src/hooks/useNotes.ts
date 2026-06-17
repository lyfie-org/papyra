import { useQuery } from '@tanstack/react-query';
import type { Note } from '../types/note';

// Reads the in-memory vault snapshot from the API. The filesystem is the source of
// truth; this is just the cached mirror the grid renders.
async function fetchNotes(): Promise<Note[]> {
  const res = await fetch('/api/notes');
  if (!res.ok) throw new Error(`GET /api/notes failed: ${res.status}`);
  return res.json();
}

export function useNotes() {
  return useQuery({ queryKey: ['notes'], queryFn: fetchNotes });
}
