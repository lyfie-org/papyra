// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { writeLocal } from '../lib/localStore';
import NavOrderSetting from './NavOrderSetting';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let enabled: boolean;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><NavOrderSetting /></QueryClientProvider>);
}

beforeEach(() => {
  enabled = true;
  writeLocal('papyra-journal-off', null);
  writeLocal('papyra-nav-order', null);
  vi.stubGlobal('fetch', vi.fn(async () => json({ settings: { enabled }, pinSet: true })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  writeLocal('papyra-journal-off', null);
  writeLocal('papyra-nav-order', null);
});

describe('NavOrderSetting', () => {
  it('lists the three places while the journal is on', async () => {
    mount();
    expect(await screen.findByLabelText('Move Journal up')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('leaves the journal out while it is off, and reordering the others keeps its saved slot', async () => {
    enabled = false;
    writeLocal('papyra-nav-order', JSON.stringify(['journal', 'notes', 'todo']));
    mount();
    await waitFor(() => expect(screen.queryByLabelText('Move Journal up')).toBeNull());
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    fireEvent.click(screen.getByLabelText('Move Notes down'));
    // Notes and To Do swapped; the journal stays first, where it was.
    expect(JSON.parse(localStorage.getItem('papyra-nav-order')!)).toEqual(['journal', 'todo', 'notes']);
  });
});
