// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../ToastProvider';
import TodoEmbed from './TodoEmbed';
import { setSync } from '../../lib/syncStatus';
import type { Note } from '../../types/note';

const todo = (over: Partial<Note> = {}): Note => ({
  id: 'groceries', title: 'Groceries', tags: [], color: null, pinned: false, archived: false, kind: 'todo',
  trashed: false, updated: '2026-10-01T00:00:00Z', body: '- [ ] milk\n- [x] bread\n- [ ] eggs', ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

function mount(notes: Note[], props: Partial<React.ComponentProps<typeof TodoEmbed>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData(['notes'], notes);
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ToastProvider>
          <TodoEmbed note="Groceries" status="resolved" content="- [ ] milk\n- [x] bread" {...props} />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { invalidate };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setSync({ online: true });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('TodoEmbed', () => {
  it('draws the real list from the cache, with how much is open', () => {
    mount([todo()]);
    expect(screen.getByRole('link', { name: 'Groceries' }).getAttribute('href')).toBe('/note/groceries');
    expect(screen.getByText('2 open')).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, true, false]);
    expect(boxes.every((b) => b.labels?.length === 1)).toBe(true); // each box is named by its item
  });

  it('ticks the to-do itself: names the item by place and text, and shows it at once', async () => {
    fetchMock.mockResolvedValue(json({ items: [
      { index: 0, text: 'milk', checked: true }, { index: 1, text: 'bread', checked: true }, { index: 2, text: 'eggs', checked: false }] }));
    const { invalidate } = mount([todo()]);

    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'milk' })); });

    const [url, init] = fetchMock.mock.calls.find((c) => String(c[0]).includes('/checklist/check'))!;
    expect(url).toBe('/api/notes/groceries/checklist/check');
    expect(JSON.parse(init.body)).toEqual({ index: 0, text: 'milk', checked: true });
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'milk' }) as HTMLInputElement).checked).toBe(true));
    expect(screen.getByText('1 open')).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notes'] });
  });

  it('shows the list as it is now when it moved on, and says so', async () => {
    fetchMock.mockResolvedValue(json({ code: 'stale', items: [{ index: 0, text: 'eggs', checked: false }] }, 409));
    mount([todo()]);
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'milk' })); });
    expect(await screen.findByText('That list changed — showing it as it is now.')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('puts the box back when the write fails', async () => {
    fetchMock.mockResolvedValue(json({}, 500));
    mount([todo()]);
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'milk' })); });
    expect(await screen.findByText('Couldn’t update the to-do.')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'milk' }) as HTMLInputElement).checked).toBe(false);
  });

  it('reads but does not tick while offline', () => {
    setSync({ online: false });
    mount([todo()]);
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.every((b) => b.disabled)).toBe(true);
    expect(screen.getAllByRole('status').some((s) => (s.textContent ?? '').includes('Offline'))).toBe(true);
  });

  it('says why a list can’t be shown: in the Trash, locked, or gone', () => {
    mount([todo({ trashed: true })], { status: 'unresolved', content: null });
    expect(screen.getByText('“Groceries” is in the Trash.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the Trash' }).getAttribute('href')).toBe('/trash');
    cleanup();
    mount([todo({ secure: true, body: '' })], { status: 'unresolved', content: null });
    expect(screen.getByText('“Groceries” is locked.')).toBeTruthy();
    cleanup();
    mount([], { status: 'unresolved', content: null });
    expect(screen.getByText('This to-do isn’t available.')).toBeTruthy();
  });

  it('falls back to what the server resolved while the desk is still loading', () => {
    mount([], { content: '- [ ] milk\n- [x] bread' });
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    // …but it can't tick a list it can't find on the desk.
    expect((screen.getAllByRole('checkbox') as HTMLInputElement[]).every((b) => b.disabled)).toBe(true);
  });
});
