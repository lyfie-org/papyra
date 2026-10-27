import { useSyncExternalStore } from 'react';

/**
 * What the day's page and the panel beside it say to each other. The panel
 * ("Open to-dos", "Recent notes", "Linked today") lives outside the sheet, but
 * linking acts on the sheet's editor and "carry over" on its saved text — so the
 * sheet registers what it can do, and publishes what it has written, here.
 * Kept outside React state so typing never re-renders the panel except through
 * the one debounced `draft` update.
 */
export interface JournalBridgeActions {
  /** Put `[[target]]` (a note, a to-do or a day) in the page at the caret. */
  insertLink: (target: string) => void;
  /** Put the to-do's live checklist (`![[Title#^checklist]]`) in the page, as its own block. */
  insertTodo: (title: string) => void;
  /** Copy the latest earlier day's unticked items into this one. Resolves to how many were added. */
  carryOver: () => Promise<number>;
}

export interface JournalBridge {
  attach(actions: JournalBridgeActions): void;
  detach(): void;
  /** The text of the page as last reported (debounced). */
  setDraft(text: string): void;
  insertLink(target: string): void;
  insertTodo(title: string): void;
  carryOver(): Promise<number>;
  subscribe(listener: () => void): () => void;
  getDraft(): string;
  isAttached(): boolean;
}

export function createJournalBridge(): JournalBridge {
  let actions: JournalBridgeActions | null = null;
  let draft = '';
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  return {
    attach(next) { actions = next; emit(); },
    detach() { actions = null; draft = ''; emit(); },
    setDraft(text) { if (text !== draft) { draft = text; emit(); } },
    insertLink(target) { actions?.insertLink(target); },
    insertTodo(title) { actions?.insertTodo(title); },
    carryOver: async () => (actions ? actions.carryOver() : 0),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getDraft: () => draft,
    isAttached: () => actions !== null,
  };
}

/** The page's text, as the panel sees it. */
export function useBridgeDraft(bridge: JournalBridge): string {
  return useSyncExternalStore(bridge.subscribe, bridge.getDraft, bridge.getDraft);
}

export function useBridgeAttached(bridge: JournalBridge): boolean {
  return useSyncExternalStore(bridge.subscribe, bridge.isAttached, bridge.isAttached);
}
