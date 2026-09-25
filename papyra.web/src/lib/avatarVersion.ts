import { useSyncExternalStore } from 'react';

// A tiny app-wide counter bumped whenever the signed-in user's picture changes.
//
// Avatar URLs are stable (`/api/auth/avatar`), so after an upload the browser
// kept serving the cached old picture everywhere except the one component that
// did the upload — the header still showed the previous face until a reload.
// Every <Avatar> reads this and appends it to its URL, so one bump refreshes
// them all.

let version = 0;
const listeners = new Set<() => void>();

export function bumpAvatarVersion(): void {
  version = Date.now();
  for (const l of listeners) l();
}

export function useAvatarVersion(): number {
  return useSyncExternalStore(
    (onChange) => { listeners.add(onChange); return () => { listeners.delete(onChange); }; },
    () => version,
    () => version,
  );
}
