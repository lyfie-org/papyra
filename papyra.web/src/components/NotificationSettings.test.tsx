// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NotificationSettings from './NotificationSettings';
import type { Destination } from '../hooks/useChannels';
import type { NotificationPrefs } from '../hooks/useInstanceConfig';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const dest = (over: Partial<Destination> = {}): Destination => ({
  id: 1, channel: 'ntfy', kind: 'topic', label: 'ntfy · ntfy.sh', verified: true, enabled: true, privacyTier: 'minimal',
  state: 'connected', lastOkUtc: null, lastErrorUtc: null, lastError: null, pausedUtc: null, ...over,
});

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  mention: true, share: true, emailConfigured: true, hasAddress: true,
  channels: ['email', 'discord', 'telegram', 'ntfy'], available: ['ntfy', 'discord'],
  groups: [{ id: 'security', label: 'Security & account' }, { id: 'collab', label: 'Other people' }],
  events: [
    { id: 'security.new_sign_in', group: 'security', label: 'New sign-in', description: 'A new device signed in.', critical: true, email: true, chat: {} },
    { id: 'collab.mention', group: 'collab', label: 'Mentions', description: 'Someone mentions you.', critical: false, email: true, chat: { discord: false, telegram: true, ntfy: true } },
  ],
  ...over,
});

let calls: { url: string; method: string; body?: unknown }[];
let current: NotificationPrefs;
let destinations: Destination[];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><NotificationSettings /></QueryClientProvider>);
}

beforeEach(() => {
  calls = [];
  current = prefs();
  destinations = [dest()];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === '/api/auth/notifications' && method === 'GET') return json(current);
    if (url === '/api/auth/notifications' && method === 'PUT') return new Response(null, { status: 204 });
    if (url === '/api/notifications/destinations') return json({ available: current.available, destinations });
    return json({}, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('NotificationSettings', () => {
  it('stays one column of email while no chat place is connected', async () => {
    destinations = [];
    mount();
    await screen.findByText('Mentions');
    expect(screen.getAllByText('Email').length).toBeGreaterThan(0);
    expect(screen.queryByText('ntfy')).toBeNull();
    expect(screen.queryByRole('switch', { name: /Mentions — / })).toBeNull();
  });

  it('adds a column for each place that is connected and confirmed', async () => {
    destinations = [dest(), dest({ id: 2, channel: 'discord', kind: 'webhook', verified: false, state: 'unverified' })];
    mount();
    await screen.findByText('Mentions');
    expect(await screen.findAllByText('ntfy')).not.toHaveLength(0);                       // connected: a column
    expect(screen.queryAllByText('Discord')).toHaveLength(0);                             // not confirmed yet: none
    const ntfy = await screen.findByRole('switch', { name: 'Mentions — ntfy' }) as HTMLInputElement;
    expect(ntfy.checked).toBe(true);
    expect(screen.queryByRole('switch', { name: 'Mentions — Discord' })).toBeNull();
    // Telegram is on, but the person has not connected it: no column.
    expect(screen.queryByRole('switch', { name: 'Mentions — Telegram' })).toBeNull();
  });

  it('drops the column of a service the administrator has switched off', async () => {
    current = prefs({ available: ['discord'] });
    mount();
    await screen.findByText('Mentions');
    await waitFor(() => expect(calls.some(c => c.url === '/api/notifications/destinations')).toBe(true));
    expect(screen.queryByRole('switch', { name: 'Mentions — ntfy' })).toBeNull();
  });

  it('keeps always-on notices email only: locked on, and no chat switch to promise otherwise', async () => {
    mount();
    await screen.findByRole('switch', { name: 'Mentions — ntfy' });
    const email = document.getElementById('notify-security.new_sign_in') as HTMLInputElement;
    expect(email.checked).toBe(true);
    expect(email.disabled).toBe(true);
    expect(screen.queryByRole('switch', { name: 'New sign-in — ntfy' })).toBeNull();
  });

  it('saves a chat switch for its own channel, and leaves email alone', async () => {
    mount();
    const chat = await screen.findByRole('switch', { name: 'Mentions — ntfy' }) as HTMLInputElement;
    fireEvent.click(chat);

    await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({
      events: [{ id: 'collab.mention', enabled: false, channel: 'ntfy' }],
    }));
    const email = document.getElementById('notify-collab.mention') as HTMLInputElement;
    expect(email.checked).toBe(true);
  });

  it('saves an email switch for email', async () => {
    mount();
    await screen.findByRole('switch', { name: 'Mentions — ntfy' });
    fireEvent.click(document.getElementById('notify-collab.mention') as HTMLInputElement);
    await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({
      events: [{ id: 'collab.mention', enabled: false, channel: 'email' }],
    }));
  });

  it('explains missing mail only when email is the only way', async () => {
    current = prefs({ emailConfigured: false });
    mount();
    // A chat place is connected, so "nothing is sent" would be untrue.
    await screen.findByRole('switch', { name: 'Mentions — ntfy' });
    expect(screen.queryByText('Email isn’t set up on this server yet.')).toBeNull();

    cleanup();
    destinations = [];
    mount();
    expect(await screen.findByText('Email isn’t set up on this server yet.')).toBeTruthy();
    expect(within(document.body).queryByRole('switch', { name: /Mentions — / })).toBeNull();
  });
});
