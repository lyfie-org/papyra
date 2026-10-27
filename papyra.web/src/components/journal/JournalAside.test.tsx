// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../ToastProvider';
import JournalAside from './JournalAside';
import { createJournalBridge } from '../../lib/journalBridge';
import type { Note } from '../../types/note';

const note = (over: Partial<Note> & Pick<Note, 'id' | 'title'>): Note => ({
  tags: [], color: null, pinned: false, archived: false, kind: 'note', trashed: false,
  updated: '2026-10-01T00:00:00Z', body: '', ...over,
});

const NOTES: Note[] = [
  note({ id: 'kyoto', title: 'Kyoto trip', updated: '2026-10-20T00:00:00Z' }),
  note({ id: 'old', title: 'Old idea', updated: '2026-01-01T00:00:00Z' }),
  note({ id: 'bin', title: 'In the bin', trashed: true }),
  note({ id: 'vault', title: 'Locked thing', secure: true }),
  note({ id: 'groceries', title: 'Groceries', kind: 'todo', body: '- [ ] milk\n- [x] bread\n- [ ] eggs' }),
  note({ id: 'done', title: 'All done', kind: 'todo', body: '- [x] everything' }),
];

function setup(opts: { writable?: boolean; attach?: boolean } = {}) {
  const bridge = createJournalBridge();
  const insertLink = vi.fn();
  const insertTodo = vi.fn();
  const carryOver = vi.fn(async () => 2);
  if (opts.attach !== false) bridge.attach({ insertLink, insertTodo, carryOver });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['notes'], NOTES);
  // Wide layout: the panel is open, not folded into a <details>.
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('1100'), media: q, addEventListener: () => {}, removeEventListener: () => {},
  }));
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ToastProvider><JournalAside bridge={bridge} date="2026-10-25" writable={opts.writable ?? true} /></ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { bridge, insertLink, insertTodo, carryOver };
}

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(cleanup);

describe('JournalAside', () => {
  it('lists the to-dos with something still open, and how much', () => {
    setup();
    expect(screen.getByText('Groceries')).toBeTruthy();
    expect(screen.getByText('2 open')).toBeTruthy();
    expect(screen.queryByText('All done')).toBeNull();
  });

  it('offers recent notes, never one in the bin or locked', () => {
    setup();
    expect(screen.getByText('Kyoto trip')).toBeTruthy();
    expect(screen.queryByText('In the bin')).toBeNull();
    expect(screen.queryByText('Locked thing')).toBeNull();
  });

  it('puts a link in the page on a tap', () => {
    const { insertLink } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Link Kyoto trip' }));
    expect(insertLink).toHaveBeenCalledWith('Kyoto trip');
  });

  it('says "Linked" for what the page already links to, and lists it under Linked today', async () => {
    const { bridge } = setup();
    act(() => bridge.setDraft('Dreaming of [[Kyoto trip]] and [[2026-09-14]]'));
    const done = screen.getByRole('button', { name: 'Linked Kyoto trip' }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    const chips = screen.getAllByRole('link').filter((a) => a.className.includes('chip')).map((a) => a.textContent);
    expect(chips).toEqual(['Kyoto trip', 'Sep 14']);
  });

  it('cannot link while the day is read-only or the page is not ready', () => {
    setup({ writable: false });
    expect((screen.getByRole('button', { name: 'Link Kyoto trip' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    setup({ attach: false });
    expect((screen.getByRole('button', { name: 'Link Kyoto trip' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('brings unticked items forward and says how many', async () => {
    const { carryOver } = setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Bring forward/ })); });
    expect(carryOver).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Brought forward 2 items.')).toBeTruthy();
  });
});

describe('JournalAside: embedding a to-do', () => {
  it('offers Embed for a to-do (not a note), and puts its live list in the page', () => {
    const { insertTodo } = setup();
    expect(screen.queryByRole('button', { name: 'Embed Kyoto trip' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Embed Groceries' }));
    expect(insertTodo).toHaveBeenCalledWith('Groceries');
  });

  it('says "Embedded" once the page shows that list', () => {
    const { bridge } = setup();
    act(() => bridge.setDraft('Plans\n\n![[Groceries#^checklist]]\n'));
    expect((screen.getByRole('button', { name: 'Embedded Groceries' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
