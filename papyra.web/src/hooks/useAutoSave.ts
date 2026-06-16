import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Note } from '../types/note';

export type SaveStatus = 'idle' | 'saving' | 'saved';

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
  const queryClient = useQueryClient();

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last values flushed to disk — guards against redundant PUTs (e.g. the editor
  // normalising markdown on open shouldn't masquerade as a user edit).
  const saved = useRef<Draft>({ title: note.title, body: note.body });

  const flush = useCallback(async () => {
    const draft = getDraft();
    if (draft.title === saved.current.title && draft.body === saved.current.body) {
      return; // nothing actually changed
    }

    setStatus('saving');
    const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: draft.title,
        tags: note.tags,
        color: note.color,
        pinned: note.pinned,
        body: draft.body,
      }),
    });
    if (!res.ok) throw new Error(`PUT /api/notes/${note.id} failed: ${res.status}`);

    saved.current = draft;
    setStatus('saved');
    // Our own write is logged in the Write-Ring server-side (no broadcast echo),
    // so refresh the grid's snapshot ourselves.
    queryClient.invalidateQueries({ queryKey: ['notes'] });
  }, [getDraft, note.id, note.tags, note.color, note.pinned, queryClient]);

  // Mark dirty: reset the debounce window on every keystroke (reset-on-new).
  const bump = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush();
    }, DEBOUNCE_MS);
  }, [flush]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { status, bump };
}
