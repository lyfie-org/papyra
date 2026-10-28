import { useSyncExternalStore } from 'react';

// Small per-device preferences (a collapsed section, the order of the sidebar) kept in
// localStorage, like the theme and the formatting-toolbar choice. A blocked store still
// holds for the session; another tab's change is followed.

const listeners = new Map<string, Set<() => void>>();
// What a blocked localStorage could not keep.
const session = new Map<string, string | null>();

function read(key: string): string | null {
  if (session.has(key)) return session.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Save a value (`null` forgets it) and tell every reader. */
export function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    session.delete(key);
  } catch {
    session.set(key, value);
  }
  listeners.get(key)?.forEach((l) => l());
}

function subscribe(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, set = new Set());
  set.add(listener);
  const onStorage = (e: StorageEvent) => { if (e.key === key) listener(); };
  window.addEventListener('storage', onStorage);
  return () => {
    set.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The stored string for `key`, live. */
export function useLocal(key: string): string | null {
  return useSyncExternalStore((l) => subscribe(key, l), () => read(key), () => null);
}
