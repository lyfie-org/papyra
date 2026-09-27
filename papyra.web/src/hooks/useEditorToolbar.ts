import { useSyncExternalStore } from 'react';

// "Always show the formatting toolbar" — a personal, per-device preference like
// the theme, so it lives in localStorage rather than the instance-wide settings.
// Without it a note opens with the toolbar hidden and the footer's toggle shows
// it for that note; with it every note opens with the toolbar already showing.

const LS_KEY = 'papyra-editor-toolbar';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === 'always';
  } catch {
    return false;
  }
}

let alwaysShow = read();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changed it: follow along.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== LS_KEY) return;
    alwaysShow = read();
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function setAlwaysShowEditorToolbar(next: boolean): void {
  alwaysShow = next;
  try {
    if (next) localStorage.setItem(LS_KEY, 'always');
    else localStorage.removeItem(LS_KEY);
  } catch {
    // Storage blocked (private mode): the choice still holds for this session.
  }
  listeners.forEach((l) => l());
}

/** Whether every note should open with the formatting toolbar showing. */
export function useAlwaysShowEditorToolbar(): boolean {
  return useSyncExternalStore(subscribe, () => alwaysShow, () => false);
}
