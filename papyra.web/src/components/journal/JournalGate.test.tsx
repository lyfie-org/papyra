// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../ToastProvider';
import { writeLocal } from '../../lib/localStore';
import JournalGate from './JournalGate';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let enabled: boolean;
let puts: string[];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/journal/2026-09-14']}>
          <Routes>
            <Route element={<JournalGate />}>
              <Route path="journal/:date" element={<p>A day of the journal</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  enabled = true;
  puts = [];
  writeLocal('papyra-journal-off', null);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== '/api/journal/settings') return json({}, 404);
    if (init?.method === 'PUT') {
      puts.push(init.body as string);
      enabled = JSON.parse(init.body as string).enabled;
    }
    return json({ settings: { enabled }, pinSet: true });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); writeLocal('papyra-journal-off', null); });

describe('JournalGate', () => {
  it('lets the journal’s pages through while it is on', async () => {
    mount();
    expect(await screen.findByText('A day of the journal')).toBeTruthy();
    expect(screen.queryByText('The journal is off')).toBeNull();
  });

  it('shows a quiet "off" page for a stale link, and turning it on opens the day', async () => {
    enabled = false;
    mount();
    expect(await screen.findByRole('heading', { name: 'The journal is off' })).toBeTruthy();
    expect(screen.getByText(/Your days are safe in your folder/)).toBeTruthy();
    expect(screen.queryByText('A day of the journal')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Turn it on' }));
    expect(await screen.findByText('A day of the journal')).toBeTruthy();
    expect(puts).toEqual([JSON.stringify({ enabled: true })]);
  });

  it('remembers on this device that it is off, so the page does not flash open while loading', async () => {
    enabled = false;
    mount();
    await screen.findByRole('heading', { name: 'The journal is off' });
    await waitFor(() => expect(localStorage.getItem('papyra-journal-off')).toBe('1'));
  });
});
