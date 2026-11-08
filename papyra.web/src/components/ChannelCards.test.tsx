// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from './ConfirmProvider';
import ChannelCards from './ChannelCards';
import { telegramPolling, type Destination } from '../hooks/useChannels';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const dest = (over: Partial<Destination> = {}): Destination => ({
  id: 1, channel: 'ntfy', kind: 'topic', label: 'ntfy · ntfy.sh', verified: true, enabled: true, privacyTier: 'minimal',
  state: 'connected', lastOkUtc: null, lastErrorUtc: null, lastError: null, pausedUtc: null, ...over,
});

let calls: { url: string; method: string; body?: unknown }[];
let available: string[];
let destinations: Destination[];
let replies: Record<string, () => Response>;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConfirmProvider><ChannelCards /></ConfirmProvider>
    </QueryClientProvider>,
  );
}

const rowFor = (label: string) =>
  screen.getByText(label, { selector: '.setting-row__label' }).closest('.setting-row') as HTMLElement;

beforeEach(() => {
  calls = [];
  available = ['discord', 'telegram', 'ntfy'];
  destinations = [];
  replies = {};
  telegramPolling.ms = 25;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    const key = `${method} ${url}`;
    if (replies[key]) return replies[key]();
    if (key === 'GET /api/auth/notifications') return json({ emailConfigured: true, hasAddress: true, channels: ['email'], groups: [], events: [], mention: true, share: true });
    if (key === 'GET /api/notifications/destinations') return json({ available, destinations });
    if (key === 'POST /api/notifications/destinations/ntfy') {
      destinations = [dest({ id: 7, state: 'unverified', verified: false })];
      return json({ id: 7, topic: body?.topic ?? 'papyra-abcdefghijklmnopqrstuvwx', subscribeUrl: 'https://ntfy.sh/x', weakTopic: (body?.topic ?? 'long-enough-topic').length < 12 });
    }
    if (key === 'POST /api/notifications/destinations/7/test') {
      destinations = destinations.map(d => ({ ...d, lastOkUtc: '2026-11-10T09:00:00Z' }));
      return json({ ok: true, error: null });
    }
    if (key === 'POST /api/notifications/destinations/7/confirm') {
      destinations = destinations.map(d => ({ ...d, verified: true, state: 'connected' }));
      return new Response(null, { status: 204 });
    }
    return json({}, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ChannelCards', () => {
  it('stays out of the way until an administrator has switched a chat service on', async () => {
    available = [];
    mount();
    await waitFor(() => expect(calls.some(c => c.url === '/api/notifications/destinations')).toBe(true));
    expect(screen.queryByText('Where to send')).toBeNull();
    expect(screen.queryByText('Email')).toBeNull();
  });

  it('lists email and each available service, all "Not set up" to begin with', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Where to send' })).toBeTruthy();
    expect(within(rowFor('Email')).getByText('To your account address')).toBeTruthy();
    for (const name of ['Discord', 'Telegram', 'ntfy']) {
      const row = rowFor(name);
      expect(within(row).getByText('Not set up')).toBeTruthy();
      expect(within(row).getByRole('button', { name: 'Set up' })).toBeTruthy();
    }
  });

  it('says so when mail is not set up on this Papyra', async () => {
    replies['GET /api/auth/notifications'] = () => json({ emailConfigured: false, hasAddress: true, channels: [], groups: [], events: [], mention: true, share: true });
    mount();
    expect(await within(await screen.findByRole('heading', { name: 'Where to send' }).then(() => rowFor('Email'))).findByText('Not set up on this Papyra')).toBeTruthy();
  });

  it('only shows a service that has been switched off if the person had already connected it', async () => {
    available = ['ntfy'];
    destinations = [dest({ id: 3, channel: 'discord', kind: 'webhook', label: 'Discord · channel' })];
    mount();
    await screen.findByRole('heading', { name: 'Where to send' });
    const row = rowFor('Discord');
    expect(await within(row).findByText('Discord · channel · switched off by an administrator')).toBeTruthy();
    expect(screen.queryByText('Telegram', { selector: '.setting-row__label' })).toBeNull();
  });

  describe('ntfy', () => {
    it('makes a random topic, tests it, and connects once the person says it arrived', async () => {
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(within(rowFor('ntfy')).getByRole('button', { name: 'Set up' }));
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

      expect(await screen.findByText('papyra-abcdefghijklmnopqrstuvwx')).toBeTruthy();
      expect(calls.find(c => c.method === 'POST' && c.url.endsWith('/ntfy'))?.body).toEqual({ topic: null });
      const yes = screen.getByRole('button', { name: 'Yes, it arrived' }) as HTMLButtonElement;
      expect(yes.disabled).toBe(true);                       // nothing to vouch for until a test went through

      fireEvent.click(screen.getByRole('button', { name: /Send a test/ }));
      expect(await screen.findByText('Sent. Look for it in ntfy.')).toBeTruthy();
      await waitFor(() => expect(yes.disabled).toBe(false));
      fireEvent.click(yes);

      await waitFor(() => expect(calls.some(c => c.url === '/api/notifications/destinations/7/confirm')).toBe(true));
      // The row now reads as connected, and the steps have folded away.
      expect(await within(rowFor('ntfy')).findByText('ntfy · ntfy.sh')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Yes, it arrived' })).toBeNull();
    });

    it('sends the topic the person chose, and warns when it is short', async () => {
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(within(rowFor('ntfy')).getByRole('button', { name: 'Set up' }));
      fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'abc' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

      expect(await screen.findByText(/short and easy to guess/)).toBeTruthy();
      expect(calls.find(c => c.method === 'POST' && c.url.endsWith('/ntfy'))?.body).toEqual({ topic: 'abc' });
    });

    it('shows the server’s reason when the topic is refused', async () => {
      replies['POST /api/notifications/destinations/ntfy'] = () => json({ error: 'ntfy isn’t turned on for this Papyra. Ask an administrator.' }, 409);
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(within(rowFor('ntfy')).getByRole('button', { name: 'Set up' }));
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect((await screen.findByRole('alert')).textContent).toContain('Ask an administrator');
    });

    it('lets an unfinished set-up be picked up again, and can show the topic', async () => {
      destinations = [dest({ id: 7, state: 'unverified', verified: false })];
      replies['GET /api/notifications/destinations/ntfy/7/address'] = () => json({ topic: 'papyra-mytopic12345678901234', subscribeUrl: 'https://ntfy.sh/x' });
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      const row = rowFor('ntfy');
      expect(await within(row).findByText('Not confirmed yet')).toBeTruthy();
      fireEvent.click(within(row).getByRole('button', { name: 'Finish' }));
      fireEvent.click(screen.getByRole('button', { name: 'Show my topic' }));
      expect(await screen.findByText('papyra-mytopic12345678901234')).toBeTruthy();
    });
  });

  describe('Discord', () => {
    it('turns away anything that is not a webhook address, with the steps to make one', async () => {
      replies['POST /api/notifications/destinations/discord/webhook'] = () =>
        json({ error: 'That isn’t a Discord webhook address. In Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.' }, 400);
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(within(rowFor('Discord')).getByRole('button', { name: 'Set up' }));
      expect(screen.getByText(/Use a private one/)).toBeTruthy();

      const field = screen.getByLabelText('Webhook address') as HTMLInputElement;
      expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
      fireEvent.change(field, { target: { value: 'https://example.com/nope' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect((await screen.findByRole('alert')).textContent).toContain('Copy Webhook URL');
    });

    it('connects a webhook, tests it and confirms it', async () => {
      replies['POST /api/notifications/destinations/discord/webhook'] = () => {
        destinations = [dest({ id: 7, channel: 'discord', kind: 'webhook', label: 'Discord · channel', state: 'unverified', verified: false })];
        return json({ id: 7, label: 'Discord · channel', kind: 'webhook', sharedWithChannel: true });
      };
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(within(rowFor('Discord')).getByRole('button', { name: 'Set up' }));
      fireEvent.change(screen.getByLabelText('Webhook address'), { target: { value: ' https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz ' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

      expect(await screen.findByText('Send a test to Discord. Did it arrive?')).toBeTruthy();
      expect(calls.find(c => c.url.endsWith('/discord/webhook'))?.body).toEqual({ url: 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz' });
      fireEvent.click(screen.getByRole('button', { name: /Send a test/ }));
      await screen.findByText('Sent. Look for it in Discord.');
      fireEvent.click(screen.getByRole('button', { name: 'Yes, it arrived' }));
      await waitFor(() => expect(calls.some(c => c.url === '/api/notifications/destinations/7/confirm')).toBe(true));
    });

    it('shows why a test did not go through', async () => {
      destinations = [dest({ id: 7, channel: 'discord', kind: 'webhook', label: 'Discord · channel', state: 'unverified', verified: false })];
      replies['POST /api/notifications/destinations/7/test'] = () =>
        json({ ok: false, error: 'The Discord webhook was deleted or changed. Make a new one in Discord and connect it again.' });
      mount();
      fireEvent.click(await within(await screen.findByRole('heading', { name: 'Where to send' }).then(() => rowFor('Discord'))).findByRole('button', { name: 'Finish' }));
      fireEvent.click(screen.getByRole('button', { name: /Send a test/ }));
      expect(await screen.findByText(/was deleted or changed/)).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Yes, it arrived' }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('Telegram', () => {
    it('gives a link to open, and turns into "connected" by itself when the person presses Start', async () => {
      replies['POST /api/notifications/destinations/telegram/link'] = () =>
        json({ url: 'https://t.me/PapyraBot?start=abcdefghij', expiresUtc: '2026-11-10T09:10:00Z', botUsername: 'PapyraBot' });
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(within(rowFor('Telegram')).getByRole('button', { name: 'Set up' }));
      fireEvent.click(screen.getByRole('button', { name: 'Get a link' }));

      const open = await screen.findByRole('link', { name: /Open Telegram/ });
      expect(open.getAttribute('href')).toBe('https://t.me/PapyraBot?start=abcdefghij');
      expect(open.getAttribute('rel')).toContain('noopener');
      expect(screen.getByText(/Waiting for you to press Start/)).toBeTruthy();

      // The person presses Start in Telegram: the next look finds the chat.
      destinations = [dest({ id: 9, channel: 'telegram', kind: 'chat', label: 'Telegram · @rahul' })];
      expect(await within(rowFor('Telegram')).findByText('Telegram · @rahul')).toBeTruthy();
      expect(screen.queryByRole('link', { name: /Open Telegram/ })).toBeNull();
      expect(within(rowFor('Telegram')).getByRole('button', { name: 'Manage' })).toBeTruthy();
    });

    it('says what is wrong when no link can be made', async () => {
      replies['POST /api/notifications/destinations/telegram/link'] = () => json({ error: 'Telegram isn’t turned on for this Papyra. Ask an administrator.' }, 409);
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(within(rowFor('Telegram')).getByRole('button', { name: 'Set up' }));
      fireEvent.click(screen.getByRole('button', { name: 'Get a link' }));
      expect((await screen.findByRole('alert')).textContent).toContain('isn’t turned on');
    });
  });

  describe('a connected place', () => {
    beforeEach(() => {
      destinations = [dest({ id: 5, channel: 'ntfy', label: 'ntfy · ntfy.sh' })];
      replies['PATCH /api/notifications/destinations/5'] = () => new Response(null, { status: 204 });
      replies['DELETE /api/notifications/destinations/5'] = () => new Response(null, { status: 204 });
      replies['POST /api/notifications/destinations/5/test'] = () => json({ ok: true, error: null });
    });

    async function open() {
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(within(rowFor('ntfy')).getByRole('button', { name: 'Manage' }));
    }

    it('switches off, and changes what it shows', async () => {
      await open();
      fireEvent.click(screen.getByRole('switch', { name: 'Send notifications here' }));
      fireEvent.click(screen.getByRole('radio', { name: /names and note titles/ }));
      await waitFor(() => expect(calls.filter(c => c.method === 'PATCH').map(c => c.body)).toEqual([
        { enabled: false }, { privacyTier: 'titles' },
      ]));
    });

    it('sends a test and reports it', async () => {
      await open();
      fireEvent.click(screen.getByRole('button', { name: /Send a test/ }));
      expect(await screen.findByText('Sent. Look for it in ntfy.')).toBeTruthy();
    });

    it('asks before disconnecting, and does nothing if turned down', async () => {
      await open();
      fireEvent.click(screen.getAllByRole('button', { name: /Disconnect/ })[0]);
      const dialogButtons = await screen.findAllByRole('button', { name: /Cancel/ });
      fireEvent.click(dialogButtons[dialogButtons.length - 1]);
      await waitFor(() => expect(screen.queryByText('Disconnect ntfy?')).toBeNull());
      expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    });

    it('disconnects once confirmed', async () => {
      await open();
      fireEvent.click(screen.getAllByRole('button', { name: /Disconnect/ })[0]);
      await screen.findByText('Disconnect ntfy?');
      const buttons = screen.getAllByRole('button', { name: 'Disconnect' });
      fireEvent.click(buttons[buttons.length - 1]);
      await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.url === '/api/notifications/destinations/5')).toBe(true));
    });

    it('explains a pause and turns the place back on', async () => {
      destinations = [dest({ id: 5, state: 'paused', pausedUtc: '2026-11-10T08:00:00Z', lastError: 'The webhook was deleted.' })];
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      const row = rowFor('ntfy');
      expect(within(row).getByText('Paused')).toBeTruthy();
      expect(within(row).getByText('The webhook was deleted.')).toBeTruthy();
      fireEvent.click(within(row).getByRole('button', { name: 'Manage' }));
      fireEvent.click(screen.getByRole('button', { name: 'Turn back on' }));
      await waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ enabled: true }));
    });

    it('shows a place that needs attention with what went wrong', async () => {
      destinations = [dest({ id: 5, state: 'attention', lastError: 'ntfy had a problem (500).' })];
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      expect(within(rowFor('ntfy')).getByText('Needs attention: ntfy had a problem (500).')).toBeTruthy();
    });
  });
});
