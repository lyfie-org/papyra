// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../ToastProvider';
import JournalBin from './JournalBin';
import { erasedIn } from '../../lib/journalDay';
import type { JournalSummary } from '../../types/journal';

const day = (date: string, over: Partial<JournalSummary> = {}): JournalSummary => ({
  date, mood: null, tags: [], words: 12, hasMedia: false, locked: false, archived: false, trashed: false,
  cover: null, excerpt: null, updated: '2026-10-20T00:00:00Z', ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let calls: { url: string; method: string; body?: string }[];
let entries: JournalSummary[];

function mount(props: React.ComponentProps<typeof JournalBin>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><ToastProvider><JournalBin {...props} /></ToastProvider></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  entries = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });
    if (url.startsWith('/api/journal/bin')) return json({ entries });
    return json({}, 200);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('JournalBin', () => {
  it('draws nothing when nothing is set aside', async () => {
    const { container } = mount({ state: 'archived' });
    await waitFor(() => expect(calls.length).toBe(1));
    expect(container.querySelector('.journal-bin')).toBeNull();
  });

  it('lists archived days with their size, and brings one back through the journal write', async () => {
    entries = [day('2026-10-20', { archived: true }), day('2026-10-02', { archived: true, locked: true })];
    mount({ state: 'archived' });
    expect(await screen.findByRole('link', { name: 'October 20, 2026' })).toBeTruthy();
    expect(screen.getByText('12 words')).toBeTruthy();
    expect(screen.getByText('Locked')).toBeTruthy(); // a locked day shows no size

    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0]);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/journal/2026-10-20' && c.body === JSON.stringify({ archived: false }))).toBe(true));
    expect(await screen.findByText('October 20, 2026 is back in the journal.')).toBeTruthy();
  });

  it('says how long a trashed day is kept, and restores it through the notes route', async () => {
    const trashedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    entries = [day('2026-10-20', { trashed: true, trashedAt })];
    mount({ state: 'trashed', retentionDays: 30 });
    expect(await screen.findByText(/erased in \d+ days/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/notes/journal-2026-10-20/untrash')).toBe(true));
  });

  it('keeps a failed restore on screen and says so', async () => {
    entries = [day('2026-10-20', { archived: true })];
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.startsWith('/api/journal/bin')) return json({ entries });
      return json({ error: 'Nope.', code: 'x' }, 409);
    });
    mount({ state: 'archived' });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Nope.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'October 20, 2026' })).toBeTruthy();
  });
});

describe('erasedIn', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  it('counts the days a trashed day has left', () => {
    expect(erasedIn('2026-10-24T12:00:00Z', 30, now)).toBe('erased in 29 days');
    expect(erasedIn('2026-09-26T12:00:00Z', 30, now)).toBe('erased tomorrow');
    expect(erasedIn('2026-08-01T12:00:00Z', 30, now)).toBe('erased soon');
  });
  it('says nothing when it is kept until the person decides', () => {
    expect(erasedIn('2026-10-24T12:00:00Z', -1, now)).toBeNull();
    expect(erasedIn(null, 30, now)).toBeNull();
    expect(erasedIn('2026-10-24T12:00:00Z', undefined, now)).toBeNull();
  });
});
