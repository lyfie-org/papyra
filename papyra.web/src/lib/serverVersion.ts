// The version the server is running, as opposed to APP_VERSION — the version of
// the bundle this tab loaded. They part ways when the server is upgraded while a
// tab stays open: the server goes away, comes back newer, and the tab would keep
// showing (and running) the old release until someone reloaded it.
//
// Read from /version.json, which the production build writes next to index.html
// (vite.config.ts). Absent in `pnpm dev`, where there is nothing to compare.

import { useSyncExternalStore } from 'react';
import { APP_VERSION } from './appInfo';

let serverVersion: string | null = null;
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const getVersion = () => serverVersion;

/** Ask the server which release it is running. Never throws; null when unknown. */
export async function checkServerVersion(): Promise<string | null> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return serverVersion;
    const { version } = (await res.json()) as { version?: unknown };
    if (typeof version === 'string' && version && version !== serverVersion) {
      serverVersion = version;
      listeners.forEach(fn => fn());
    }
  } catch {
    /* offline or not a production build — keep what we had */
  }
  return serverVersion;
}

/** The server's release, and whether this tab is running an older bundle. */
export function useServerVersion(): { version: string | null; stale: boolean } {
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);
  return { version, stale: isStale(version) };
}

export function isStale(version: string | null): boolean {
  return version !== null && APP_VERSION !== 'dev' && version !== APP_VERSION;
}

/** "v1.2.3", or "dev build" — the same shape as APP_VERSION_LABEL. */
export function versionLabel(version: string): string {
  return version === 'dev' ? 'dev build' : `v${version}`;
}
