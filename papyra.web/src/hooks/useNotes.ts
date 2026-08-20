import { useQuery } from '@tanstack/react-query';
import type { Note } from '../types/note';
import { fetchNotesMerged } from '../lib/notesApi';

// Reads the in-memory vault snapshot from the API. The filesystem is the source of
// truth; this is just the cached mirror the grid renders. Offline, the service
// worker replays the last good response and any queued (unsynced) edits are
// merged over it, so the user always sees their own latest text.
export function useNotes() {
  return useQuery<Note[]>({
    queryKey: ['notes'],
    queryFn: fetchNotesMerged,
    // Offline the query function throws only on a cold cache-less boot; retrying
    // in a tight loop there would just spin.
    retry: 1,
  });
}
