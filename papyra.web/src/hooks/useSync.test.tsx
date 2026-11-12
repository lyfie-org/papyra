// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { writeLocal } from '../lib/localStore';

const state = { online: true, pending: 1, syncing: false, lastSyncedAt: null, conflicts: [], authRequired: false };
vi.mock('../lib/syncStatus', () => ({
  getSyncState: () => state,
  subscribeSync: () => () => {},
  setSync: vi.fn(),
  refreshPending: vi.fn(async () => 1),
}));
vi.mock('../lib/notesApi', () => ({ flushOutbox: vi.fn(async () => ({ synced: 0 })) }));
vi.mock('../lib/journalApi', async (original) => ({
  ...(await original<typeof import('../lib/journalApi')>()),
  flushJournalOutbox: vi.fn(async () => ({ synced: 0, conflicts: [] })),
}));
vi.mock('../lib/serverVersion', () => ({ checkServerVersion: vi.fn() }));

import { flushJournalOutbox } from '../lib/journalApi';
import { flushOutbox } from '../lib/notesApi';
import { useSyncEngine } from './useSync';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let enabled: boolean;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  enabled = true;
  vi.clearAllMocks();
  writeLocal('papyra-journal-off', null);
  vi.stubGlobal('fetch', vi.fn(async () => json({ settings: { enabled }, pinSet: true })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); writeLocal('papyra-journal-off', null); });

describe('useSyncEngine and the journal switch', () => {
  it('replays queued journal days while the journal is on', async () => {
    renderHook(() => useSyncEngine(), { wrapper });
    await waitFor(() => expect(flushJournalOutbox).toHaveBeenCalled());
  });

  it('leaves queued journal days where they are while the journal is off, but still replays notes', async () => {
    enabled = false;
    writeLocal('papyra-journal-off', '1'); // this device already knows
    renderHook(() => useSyncEngine(), { wrapper });
    await waitFor(() => expect(flushOutbox).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(flushJournalOutbox).not.toHaveBeenCalled();
  });
});
