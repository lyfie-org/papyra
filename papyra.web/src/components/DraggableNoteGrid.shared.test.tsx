// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Note } from '../types/note';
import type { IncomingShare } from '../hooks/useShares';
import type { OrderMap } from '../hooks/useNoteOrder';
import DraggableNoteGrid from './DraggableNoteGrid';

// Notes shared with you sort in among your own: a new share lands on top like a
// new note, the owner's edits never move it, and once dragged it stays put.

class RO { observe() {} unobserve() {} disconnect() {} }

const mk = (id: string, updated: string): Note => ({
  id, title: `Note ${id}`, tags: [], color: null, pinned: false, archived: false,
  kind: 'note', trashed: false, updated, body: 'body',
});

const share = (over: Partial<IncomingShare> = {}): IncomingShare => ({
  shareId: 7, noteId: 'a', owner: 'bea', title: 'Shared one', access: 'edit', excerpt: '', body: 'hi',
  color: null, updatedUtc: '2026-01-01T00:00:00Z', sharedUtc: '2026-01-10T00:00:00Z',
  requestPending: false, ...over,
});

let client: QueryClient;

function renderGrid(notes: Note[], shared: IncomingShare[], order: OrderMap = {}) {
  client.setQueryData(['notes'], notes);
  client.setQueryData(['noteOrder'], order);
  client.setQueryData(['settings'], { trashRetentionDays: 30 });
  client.setQueryData(['shares', 'summary'], []);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><DraggableNoteGrid notes={notes} shared={shared} /></MemoryRouter>
    </QueryClientProvider>,
  );
}

const titles = () => screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  vi.stubGlobal('ResizeObserver', RO);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('DraggableNoteGrid — shared notes', () => {
  it('a newly shared note comes first, ahead of older notes of yours', () => {
    renderGrid([mk('a', '2026-01-01T00:00:00Z'), mk('b', '2026-01-05T00:00:00Z')], [share()]);
    expect(titles()).toEqual(['Shared one', 'Note b', 'Note a']);
  });

  it('sorts by when it was shared, not by the owner’s later edits', () => {
    renderGrid([mk('b', '2026-01-20T00:00:00Z')], [share({ updatedUtc: '2026-02-01T00:00:00Z' })]);
    expect(titles()).toEqual(['Note b', 'Shared one']);
  });

  it('a shared note you dragged keeps that place', () => {
    renderGrid(
      [mk('a', '2026-01-01T00:00:00Z'), mk('b', '2026-01-05T00:00:00Z')],
      [share({ updatedUtc: '2026-03-01T00:00:00Z' })],
      { 'shared:7': { key: Date.parse('2026-01-03T00:00:00Z'), setAt: 1 } },
    );
    expect(titles()).toEqual(['Note b', 'Shared one', 'Note a']);
  });
});
