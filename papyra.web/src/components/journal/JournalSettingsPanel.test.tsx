// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '../ConfirmProvider';
import { ToastProvider } from '../ToastProvider';
import JournalSettingsPanel from './JournalSettingsPanel';
import type { JournalPrefs } from '../../types/journal';

const prefs = (over: Partial<JournalPrefs> = {}): JournalPrefs => ({
  dayStartsAt: 0, lockNewEntries: false, promptsOn: true, hideStreak: false,
  reminderOn: false, reminderTime: null, defaultTemplate: null, ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let calls: { url: string; method: string; body?: string }[];
let current: { settings: JournalPrefs; pinSet: boolean };
let lockAllReply: () => Response;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider><ConfirmProvider><JournalSettingsPanel /></ConfirmProvider></ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  current = { settings: prefs(), pinSet: true };
  lockAllReply = () => json({ locked: 3 });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });
    if (url === '/api/journal/settings' && method === 'GET') return json(current);
    if (url === '/api/journal/settings' && method === 'PUT') {
      current = { ...current, settings: { ...current.settings, ...JSON.parse(init!.body as string) } };
      return json(current);
    }
    if (url === '/api/journal/lock-all') return lockAllReply();
    return json({}, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('JournalSettingsPanel', () => {
  it('shows the day boundary at rest and saves a new one on request', async () => {
    mount();
    expect(await screen.findByText('Midnight')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'A new day starts at' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.body === JSON.stringify({ dayStartsAt: 3 }))).toBe(true));
    expect(await screen.findByText('3:00 am')).toBeTruthy();
  });

  it('flips prompts and the streak straight away', async () => {
    mount();
    fireEvent.click(await screen.findByRole('switch', { name: /Writing prompts/ }));
    fireEvent.click(screen.getByRole('switch', { name: /Hide the streak/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      JSON.stringify({ promptsOn: false }), JSON.stringify({ hideStreak: true }),
    ]));
  });

  it('holds back locking until there is a vault PIN, and says where to set one', async () => {
    current = { settings: prefs(), pinSet: false };
    mount();
    const lockNew = await screen.findByRole('switch', { name: /Lock new days/ });
    expect((lockNew as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Set a vault PIN in Security first.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Lock all…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks before locking every day, then says how many it locked', async () => {
    mount();
    await screen.findByText('Midnight');
    fireEvent.click(screen.getByRole('button', { name: 'Lock all…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lock all days' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lock them all' }));
    expect(await screen.findByText('Locked 3 days.')).toBeTruthy();
    expect(calls.filter((c) => c.url === '/api/journal/lock-all')).toHaveLength(1);
  });

  it('does nothing when the confirmation is turned down', async () => {
    mount();
    await screen.findByText('Midnight');
    fireEvent.click(screen.getByRole('button', { name: 'Lock all…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lock all days' }));
    const dialog = await screen.findByRole('button', { name: 'Lock them all' });
    fireEvent.click(screen.getAllByRole('button', { name: /cancel/i }).at(-1) ?? dialog);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Lock them all' })).toBeNull());
    expect(calls.some((c) => c.url === '/api/journal/lock-all')).toBe(false);
  });

  it('reports a refusal instead of pretending it worked', async () => {
    lockAllReply = () => json({ error: 'Set a vault PIN before locking entries.', code: 'pin_not_set' }, 409);
    mount();
    await screen.findByText('Midnight');
    fireEvent.click(screen.getByRole('button', { name: 'Lock all…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lock all days' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lock them all' }));
    expect(await screen.findByText('Set a vault PIN before locking entries.')).toBeTruthy();
  });
});
