import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Note } from '../types/note';
import { putNote } from '../lib/notesApi';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'queued';

// Draft = the editable surface of a note. Tags/color/pinned ride along unchanged
// so a body/title save never clobbers frontmatter the editor doesn't touch.
export interface Draft {
  title: string;
  body: string;
}

const DEBOUNCE_MS = 1500;

// Tracks isDirty and debounces a PUT 1.5s after the last edit. No Save button —
// the disk is the source of truth, so a save just flushes the draft through the
// atomic markdown engine and re-validates the notes cache.
export function useAutoSave(note: Note, getDraft: () => Draft) {
  const [status, setStatus] = useState<SaveStatus>('idle');
  // isDirty drives caret protection: a remote update may only overwrite the
  // editor while the local draft is clean (see Sprint 5.2 conflict handling).
  const [isDirty, setIsDirty] = useState(false);
  const queryClient = useQueryClient();

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last values flushed to disk — guards against redundant PUTs (e.g. the editor
  // normalising markdown on open shouldn't masquerade as a user edit). Also the
  // baseline used to recognise our own write echoing back through the cache.
  const saved = useRef<Draft>({ title: note.title, body: note.body });

  const flush = useCallback(async () => {
    const draft = getDraft();
    if (draft.title === saved.current.title && draft.body === saved.current.body) {
      setIsDirty(false);
      return; // nothing actually changed
    }

    setStatus('saving');
    // putNote parks the write in the offline outbox rather than throwing when
    // the API is unreachable, so a disconnection never costs the user keystrokes.
    const outcome = await putNote(
      note.id,
      {
        title: draft.title,
        tags: note.tags,
        color: note.color,
        pinned: note.pinned,
        archived: note.archived,
        kind: note.kind,
        body: draft.body,
      },
      note.updated,
    );

    saved.current = draft;
    setIsDirty(false);
    setStatus(outcome === 'queued' ? 'queued' : 'saved');
    // Our own write is logged in the Write-Ring server-side (no broadcast echo),
    // so refresh the grid's snapshot ourselves. A queued write refreshes too —
    // the read path merges the outbox back over the server snapshot.
    queryClient.invalidateQueries({ queryKey: ['notes'] });
  }, [getDraft, note.id, note.tags, note.color, note.pinned, note.archived, note.kind, note.updated, queryClient]);

  // Mark dirty: reset the debounce window on every keystroke (reset-on-new).
  const bump = useCallback(() => {
    setIsDirty(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush();
    }, DEBOUNCE_MS);
  }, [flush]);

  // Re-baseline to a known-on-disk draft without writing (used when the editor
  // adopts a remote update). Cancels any pending save and clears the dirty flag.
  const reset = useCallback((draft: Draft) => {
    if (timer.current) clearTimeout(timer.current);
    saved.current = draft;
    setIsDirty(false);
    setStatus('idle');
  }, []);

  // Flush any pending edit on unmount (e.g. the editor modal closing) so closing
  // a note never drops the last keystrokes. flush is a no-op when already clean,
  // so the redundant call after an explicit close is harmless. Held in a ref so
  // this runs only on the real unmount, not whenever flush's identity changes.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      void flushRef.current();
    }
  }, []);

  return { status, isDirty, bump, reset, flush, savedRef: saved };
}
