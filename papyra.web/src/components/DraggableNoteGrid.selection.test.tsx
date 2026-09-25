// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { Note } from '../types/note';
import DraggableNoteGrid from './DraggableNoteGrid';

// The grid end of multi-select, driven the way a person would: the tick, then
// clicks anywhere on cards, shift ranges, Escape — and the one thing selection
// mode must never do, which is open a note or tick a to-do item by accident.

class RO { observe() {} unobserve() {} disconnect() {} }

const mk = (id: string, over: Partial<Note> = {}): Note => ({
  id, title: `Note ${id}`, tags: [], color: null, pinned: false, archived: false,
  kind: 'note', trashed: false, updated: `2026-01-0${id.charCodeAt(0) % 9 + 1}T00:00:00Z`, body: 'body', ...over,
});

let client: QueryClient;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));

function Where() { return <output data-testid="where">{useLocation().pathname}</output>; }

function tree(notes: Note[], props: { todosOnly?: boolean } = {}) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="*" element={<><DraggableNoteGrid notes={notes} {...props} /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderGrid(notes: Note[], props: { todosOnly?: boolean } = {}) {
  client.setQueryData(['notes'], notes);
  client.setQueryData(['noteOrder'], {});
  client.setQueryData(['settings'], { trashRetentionDays: 30 });
  client.setQueryData(['shares', 'summary'], []);
  return render(tree(notes, props));
}

const tick = (title: string) => screen.getByRole('button', { name: `Select “${title}”` });
const untick = (title: string) => screen.getByRole('button', { name: `Deselect “${title}”` });
const bar = () => screen.queryByRole('toolbar');

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  vi.stubGlobal('ResizeObserver', RO);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('DraggableNoteGrid — selection', () => {
  it('the tick starts selection mode and brings up the bar', () => {
    renderGrid([mk('a'), mk('b')]);
    expect(bar()).toBeNull();
    fireEvent.click(tick('Note a'));
    expect(bar()?.getAttribute('aria-label')).toBe('1 note selected');
    expect(untick('Note a').getAttribute('aria-pressed')).toBe('true');
  });

  it('in selection mode a click on a card selects it instead of opening it', () => {
    renderGrid([mk('a'), mk('b')]);
    fireEvent.click(tick('Note a'));
    fireEvent.click(screen.getByText('Note b'));
    expect(screen.getByTestId('where').textContent).toBe('/');
    expect(bar()?.getAttribute('aria-label')).toBe('2 notes selected');
    // …and a second click deselects.
    fireEvent.click(screen.getByText('Note b'));
    expect(bar()?.getAttribute('aria-label')).toBe('1 note selected');
  });

  it('outside selection mode a click still opens the note', () => {
    renderGrid([mk('a')]);
    fireEvent.click(screen.getByText('Note a'));
    expect(screen.getByTestId('where').textContent).toBe('/note/a');
  });

  it('card buttons (pin, delete…) select instead of acting while selecting', () => {
    renderGrid([mk('a'), mk('b')]);
    fireEvent.click(tick('Note a'));
    const pinB = screen.getByText('Note b').closest('.dnd-card')!.querySelector<HTMLButtonElement>('[aria-label="Pin note"]')!;
    fireEvent.click(pinB);
    expect(bar()?.getAttribute('aria-label')).toBe('2 notes selected');
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/notes/'))).toBe(false);
  });

  it('shift-click selects the run between two cards', () => {
    const notes = ['a', 'b', 'c', 'd'].map((id) => mk(id));
    renderGrid(notes);
    const order = screen.getAllByRole('button', { name: /^Select “/ }).map((b) => b.getAttribute('aria-label'));
    fireEvent.click(tick(order[0]!.slice(8, -1)));
    fireEvent.click(screen.getByText(order[3]!.slice(8, -1)), { shiftKey: true });
    expect(bar()?.getAttribute('aria-label')).toBe('4 notes selected');
  });

  it('Escape and the ✕ both end the mode', () => {
    renderGrid([mk('a')]);
    fireEvent.click(tick('Note a'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(bar()).toBeNull();
    fireEvent.click(tick('Note a'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(bar()).toBeNull();
  });

  it('Select all takes every card on screen, pinned ones too', () => {
    renderGrid([mk('a', { pinned: true }), mk('b'), mk('c')]);
    fireEvent.click(tick('Note b'));
    fireEvent.click(screen.getByRole('button', { name: /All 3/ }));
    expect(bar()?.getAttribute('aria-label')).toBe('3 notes selected');
  });

  it('a selected note deleted elsewhere drops out of the selection', () => {
    const { rerender } = renderGrid([mk('a'), mk('b')]);
    fireEvent.click(tick('Note a'));
    fireEvent.click(tick('Note b'));
    act(() => { client.setQueryData(['notes'], [mk('b')]); });
    rerender(tree([mk('b')]));
    expect(bar()?.getAttribute('aria-label')).toBe('1 note selected');
  });

  it('on the To Do page, selecting never ticks a checklist item', () => {
    const list = mk('t', { kind: 'todo', title: 'Groceries', body: '- [ ] milk' });
    renderGrid([list], { todosOnly: true });
    fireEvent.click(tick('Groceries'));
    fireEvent.click(screen.getByRole('checkbox'));
    // The click selected/deselected the card — no PUT rewrote the list.
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(false);
    expect(bar()).toBeNull(); // second click on the same card deselected it
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
  });

  it('lists only to-dos on the To Do page and only notes on the desk', () => {
    const notes = [mk('n'), mk('t', { kind: 'todo', title: 'List t' })];
    renderGrid(notes, { todosOnly: true });
    expect(screen.queryByText('Note n')).toBeNull();
    expect(screen.getByText('List t')).toBeTruthy();
    cleanup();
    renderGrid(notes);
    expect(screen.getByText('Note n')).toBeTruthy();
    expect(screen.queryByText('List t')).toBeNull();
  });
});
