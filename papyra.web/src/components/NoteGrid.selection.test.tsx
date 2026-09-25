// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { Note } from '../types/note';
import NoteGrid from './NoteGrid';

// Archive and Trash select like the desk: tick, then click-to-select, shift
// ranges, Escape — and in Trash a click must never restore or delete one card
// by accident while selecting.

const mk = (id: string, over: Partial<Note> = {}): Note => ({
  id, title: `Note ${id}`, tags: [], color: null, pinned: false, archived: false,
  kind: 'note', trashed: false, updated: '2026-01-01T00:00:00Z', body: 'body', ...over,
});

let client: QueryClient;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
  async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));

function Where() { return <output data-testid="where">{useLocation().pathname}</output>; }

function renderGrid(notes: Note[], variant: 'archived' | 'trashed', selectable = true) {
  client.setQueryData(['notes'], notes);
  client.setQueryData(['settings'], { trashRetentionDays: 30 });
  client.setQueryData(['shares', 'summary'], []);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="*" element={<><NoteGrid notes={notes} variant={variant} selectable={selectable} /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const bar = () => screen.queryByRole('toolbar');

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('NoteGrid — selection in the Archive', () => {
  const notes = [mk('a', { archived: true }), mk('b', { archived: true }), mk('c', { archived: true }), mk('live')];

  it('shows ticks only on archived cards, and a tick opens the Archive bar', () => {
    renderGrid(notes, 'archived');
    expect(screen.getAllByRole('button', { name: /^Select “/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Select “Note a”' }));
    expect(bar()?.getAttribute('aria-label')).toBe('1 note selected');
    expect(screen.getByRole('button', { name: 'Unarchive' })).toBeTruthy();
  });

  it('click selects instead of opening; shift selects the run', () => {
    renderGrid(notes, 'archived');
    fireEvent.click(screen.getByRole('button', { name: 'Select “Note a”' }));
    fireEvent.click(screen.getByText('Note c'), { shiftKey: true });
    expect(bar()?.getAttribute('aria-label')).toBe('3 notes selected');
    expect(screen.getByTestId('where').textContent).toBe('/');
  });

  it('Escape leaves the mode', () => {
    renderGrid(notes, 'archived');
    fireEvent.click(screen.getByRole('button', { name: 'Select “Note b”' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(bar()).toBeNull();
  });

  it('a grid that is not selectable has no ticks', () => {
    renderGrid(notes, 'archived', false);
    expect(screen.queryByRole('button', { name: /^Select “/ })).toBeNull();
  });
});

describe('NoteGrid — selection in Trash', () => {
  const notes = [mk('x', { trashed: true }), mk('y', { trashed: true })];

  it('while selecting, a card’s own restore/delete buttons select instead of acting', () => {
    renderGrid(notes, 'trashed');
    fireEvent.click(screen.getByRole('button', { name: 'Select “Note x”' }));
    const restoreY = screen.getByText('Note y').closest('.select-cell')!
      .querySelector<HTMLButtonElement>('[aria-label="Restore note"]')!;
    fireEvent.click(restoreY);
    expect(bar()?.getAttribute('aria-label')).toBe('2 notes selected');
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/untrash'))).toBe(false);
  });

  it('the Trash bar offers restore and delete forever', () => {
    renderGrid(notes, 'trashed');
    fireEvent.click(screen.getByRole('button', { name: 'Select “Note y”' }));
    const toolbar = within(bar()!);
    expect(toolbar.getByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(toolbar.getByRole('button', { name: 'Delete forever' })).toBeTruthy();
    expect(toolbar.queryByRole('button', { name: 'Pin' })).toBeNull();
  });

  it('Select all takes every card in Trash', () => {
    renderGrid(notes, 'trashed');
    fireEvent.click(screen.getByRole('button', { name: 'Select “Note x”' }));
    fireEvent.click(screen.getByRole('button', { name: /All 2/ }));
    expect(bar()?.getAttribute('aria-label')).toBe('2 notes selected');
  });
});
