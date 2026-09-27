import { useSyncExternalStore } from 'react';
import type { Note } from '../types/note';

/**
 * Notes that exist only in this tab until the person changes something.
 *
 * "New note" used to PUT an empty note straight away, so opening one and
 * closing it again left an empty `.md` behind (plus a history entry and a sync
 * push). Now the editor opens on a draft held here; the first real change —
 * typing, a title, a colour, a pin — goes through the ordinary autosave, whose
 * PUT creates the file. Close it untouched and nothing was ever written.
 */
const drafts = new Map<string, Note>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Start a draft and return its id, ready to open at /note/:id. */
export function createDraft(kind: Note['kind'] = 'note', body = ''): string {
  const id = crypto.randomUUID();
  drafts.set(id, {
    id, title: '', tags: [], color: null, pinned: false, archived: false,
    kind, trashed: false, secure: false, body,
    // No server copy yet, so no base revision for the offline outbox to compare.
    updated: '',
  });
  emit();
  return id;
}

/**
 * Mirror a frontmatter change onto a draft, so a pin or colour picked before
 * the first save shows at once (the notes cache has no copy to patch yet).
 */
export function patchDraft(id: string, patch: Partial<Note>) {
  const draft = drafts.get(id);
  if (!draft) return;
  drafts.set(id, { ...draft, ...patch });
  emit();
}

/** Forget a draft — it was saved (the server copy takes over) or abandoned. */
export function discardDraft(id: string) {
  if (drafts.delete(id)) emit();
}

const holders = new Map<string, number>();

/**
 * Keep a draft alive while an editor has it open; returns the release. The
 * drop is deferred a tick so a remount of the same editor (React StrictMode's
 * mount → unmount → mount, a route re-render) picks the draft straight back up
 * instead of finding it gone.
 */
export function retainDraft(id: string): () => void {
  holders.set(id, (holders.get(id) ?? 0) + 1);
  return () => {
    const left = (holders.get(id) ?? 1) - 1;
    if (left > 0) { holders.set(id, left); return; }
    holders.delete(id);
    setTimeout(() => { if (!holders.has(id)) discardDraft(id); }, 0);
  };
}

export function useDraft(id: string): Note | undefined {
  return useSyncExternalStore(subscribe, () => drafts.get(id));
}
