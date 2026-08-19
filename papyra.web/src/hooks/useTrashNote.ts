import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Note } from '../types/note';
import { useToast } from '../lib/toastContext';
import { useConfirm } from '../lib/confirmContext';
import { useSettings } from './useSettings';

/**
 * Moving a note to Trash, in one place.
 *
 * This used to live twice — once on the card and once in the open editor — and
 * the two drifted apart in both directions that matter. The editor's copy never
 * offered an Undo, and it never noticed that Trash can be set to "Delete
 * immediately", so at that setting it deleted a note for good while saying
 * "moved to Trash". Deleting a note is the same decision wherever it is taken,
 * so it is written once and both entry points call this.
 *
 * Returns true when the note is gone (trashed or deleted) and false when the
 * user backed out, so a caller that needs to navigate away can tell the
 * difference.
 */
export function useTrashNote() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { data: settings } = useSettings();

  return useCallback(async (note: Pick<Note, 'id' | 'kind'>): Promise<boolean> => {
    const noun = note.kind === 'todo' ? 'List' : 'Note';

    const send = async (path: string, method = 'POST') => {
      const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}${path}`, { method });
      // A 404 means it is already gone, which is the outcome the caller wanted.
      if (!res.ok && res.status !== 404) throw new Error(`${method} ${path} failed: ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ['notes'] });
    };

    // Retention "immediate" means there is no Trash to fall back on: this really
    // is a delete, so it has to say so and ask first. While settings are still
    // loading the value is undefined, which takes the recoverable path — the
    // safe way to be wrong.
    if (settings?.trashRetentionDays === 0) {
      const ok = await confirm({
        title: 'Delete this note?',
        body: 'Trash is set to remove notes immediately, so there is nothing to restore from. This cannot be undone.',
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return false;
      await send('', 'DELETE');
      toast(`${noun} deleted for good.`);
      return true;
    }

    await send('/trash');
    toast(`${noun} moved to Trash.`, {
      label: 'Undo',
      onClick: () => void send('/untrash'),
    });
    return true;
  }, [queryClient, toast, confirm, settings?.trashRetentionDays]);
}
