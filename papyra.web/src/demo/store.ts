// Demo state, persisted to localStorage.
//
// localStorage rather than IndexedDB on purpose: the whole vault is a few tens of
// kilobytes, and a synchronous read means the fetch interceptor can answer without
// being async-contaminated everywhere. It is also trivially resettable, which the
// banner's "Start over" needs.
//
// Nothing here ever leaves the browser.

import type { Note } from '../types/note';
import type { TagEntry as Category } from '../hooks/useTags';
import type { SmartCollection } from '../hooks/useCollections';
import type { AppNotification } from '../hooks/useNotifications';
import type { ChatMessage, ChatSessionSummary } from '../hooks/useChatSessions';
import type { OrderMap } from '../hooks/useNoteOrder';
import type { JournalPrefs, JournalTemplate } from '../types/journal';
import { SEED_CATEGORIES, SEED_COLLECTIONS, SEED_NOTIFICATIONS, SEED_NOTES } from './seed';
import { SEED_JOURNAL_PREFS, SEED_JOURNAL_TEMPLATES, seedJournal, type DemoDay } from './journalSeed';

const KEY = 'papyra-demo-vault';
/** Bump when the shape below changes so an old saved vault is replaced, not merged. */
const VERSION = 3; // 2: inbox → notifications · 3: the journal

export interface ChatSessionRecord extends ChatSessionSummary {
  messages: ChatMessage[];
}

export interface DemoState {
  version: number;
  notes: Note[];
  categories: Category[];
  collections: SmartCollection[];
  notifications: AppNotification[];
  order: OrderMap;
  settings: { trashRetentionDays: number };
  chatSessions: ChatSessionRecord[];
  /** Snapshots per note id, newest first. Seeded lazily on the first edit. */
  snapshots: Record<string, { id: string; timestamp: string; body: string }[]>;
  nextId: number;
  /** The journal: a record per written day, keyed `yyyy-MM-dd`. */
  journal: Record<string, DemoDay>;
  journalPrefs: JournalPrefs;
  journalTemplates: JournalTemplate[];
}

function fresh(): DemoState {
  return {
    version: VERSION,
    // Structured-cloned so a later mutation can never write back into the seed
    // module and survive a "Start over".
    notes: structuredClone(SEED_NOTES),
    categories: structuredClone(SEED_CATEGORIES),
    collections: structuredClone(SEED_COLLECTIONS),
    notifications: structuredClone(SEED_NOTIFICATIONS),
    order: {},
    settings: { trashRetentionDays: 30 },
    chatSessions: [],
    snapshots: {},
    nextId: 100,
    journal: seedJournal(),
    journalPrefs: { ...SEED_JOURNAL_PREFS },
    journalTemplates: structuredClone(SEED_JOURNAL_TEMPLATES),
  };
}

let state: DemoState = fresh();

export function loadState(): DemoState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoState;
      // A vault written by an older build is replaced rather than migrated —
      // this is a demo, and a half-migrated one would be worse than a fresh one.
      if (parsed.version === VERSION) state = parsed;
    }
  } catch {
    // Private browsing, disabled storage, corrupt JSON: fall back to the seed.
    // The demo still works, it just will not persist.
  }
  return state;
}

export function getState(): DemoState {
  return state;
}

export function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* quota or private mode — the session still works in memory */
  }
}

/** Mutate and persist in one step. */
export function mutate<T>(fn: (s: DemoState) => T): T {
  const result = fn(state);
  save();
  return result;
}

export function resetState(): void {
  state = fresh();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

export function nextId(): number {
  return mutate((s) => {
    s.nextId += 1;
    return s.nextId;
  });
}

/**
 * Recount the categories from the live notes.
 *
 * The server derives `count` on every read; doing the same here keeps the
 * Categories page honest as soon as a note is tagged, trashed or restored.
 */
export function recountCategories(s: DemoState): void {
  for (const cat of s.categories) {
    cat.count = s.notes.filter((n) => !n.trashed && n.tags.includes(cat.name)).length;
  }
}
