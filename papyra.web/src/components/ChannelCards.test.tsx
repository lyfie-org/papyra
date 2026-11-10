// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
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

function Where() { const l = useLocation(); return <output data-testid="where">{l.search}</output>; }

function mount(url = '/settings?tab=notifications') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>
        <ConfirmProvider><ChannelCards /></ConfirmProvider>
        <Where />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

// One tile per service. Choosing a tile opens its panel; `choose` does that and returns the panel to look inside.
const tile = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });
const choose = (name: string) => { fireEvent.click(tile(name)); return within(screen.getByRole('tabpanel')); };
const where = () => screen.getByTestId('where').textContent;

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
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('shows a tile for email and each available service, in order, all "Not set up" to begin with', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Where to send' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map(t => t.querySelector('.service-tab__name')!.textContent)).toEqual(['Email', 'ntfy', 'Discord', 'Telegram']);
    expect(tile('Email').textContent).toContain('Connected');
    expect(within(screen.getByRole('tabpanel')).getByText('Email goes to your account address.')).toBeTruthy();
    for (const name of ['ntfy', 'Discord', 'Telegram']) {
      expect(tile(name).textContent).toContain('Not set up');
      expect(choose(name).getByRole('button', { name: 'Set up' })).toBeTruthy();
    }
  });

  it('says so when mail is not set up on this server', async () => {
    replies['GET /api/auth/notifications'] = () => json({ emailConfigured: false, hasAddress: true, channels: [], groups: [], events: [], mention: true, share: true });
    mount();
    await screen.findByRole('heading', { name: 'Where to send' });
    await waitFor(() => expect(tile('Email').textContent).toContain('Off on this server'));
    expect(within(screen.getByRole('tabpanel')).getByText('The administrator hasn’t set up email.')).toBeTruthy();
  });

  it('only shows a service that has been switched off if the person had already connected it', async () => {
    available = ['ntfy'];
    destinations = [dest({ id: 3, channel: 'discord', kind: 'webhook', label: 'Discord · channel' })];
    mount();
    await screen.findByRole('heading', { name: 'Where to send' });
    await waitFor(() => expect(tile('Discord').textContent).toContain('Off on this server'));
    expect(choose('Discord').getByText('An administrator turned this off for the whole server.')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /^Telegram/ })).toBeNull();
  });

  describe('ntfy', () => {
    it('makes a random topic, tests it, and connects once the person says it arrived', async () => {
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(choose('ntfy').getByRole('button', { name: 'Set up' }));
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
      // The tile now reads as connected, the steps have folded away, and what you can do with it is there instead.
      await waitFor(() => expect(tile('ntfy').textContent).toContain('Connected'));
      expect(screen.queryByRole('button', { name: 'Yes, it arrived' })).toBeNull();
      expect(screen.getByRole('switch', { name: 'Send notifications here' })).toBeTruthy();
    });

    it('sends the topic the person chose, and warns when it is short', async () => {
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(choose('ntfy').getByRole('button', { name: 'Set up' }));
      fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'abc' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

      expect(await screen.findByText(/short and easy to guess/)).toBeTruthy();
      expect(calls.find(c => c.method === 'POST' && c.url.endsWith('/ntfy'))?.body).toEqual({ topic: 'abc' });
    });

    it('shows the server’s reason when the topic is refused', async () => {
      replies['POST /api/notifications/destinations/ntfy'] = () => json({ error: 'ntfy isn’t turned on for this Papyra. Ask an administrator.' }, 409);
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(choose('ntfy').getByRole('button', { name: 'Set up' }));
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect((await screen.findByRole('alert')).textContent).toContain('Ask an administrator');
    });

    it('lets an unfinished set-up be picked up again, and can show the topic', async () => {
      destinations = [dest({ id: 7, state: 'unverified', verified: false })];
      replies['GET /api/notifications/destinations/ntfy/7/address'] = () => json({ topic: 'papyra-mytopic12345678901234', subscribeUrl: 'https://ntfy.sh/x' });
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      await waitFor(() => expect(tile('ntfy').textContent).toContain('Not set up'));
      const panel = choose('ntfy');
      expect(panel.getByText('Not confirmed yet. Send a test, then say it arrived.')).toBeTruthy();
      fireEvent.click(panel.getByRole('button', { name: 'Finish' }));
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
      fireEvent.click(choose('Discord').getByRole('button', { name: 'Set up' }));
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
      fireEvent.click(choose('Discord').getByRole('button', { name: 'Set up' }));
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
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(choose('Discord').getByRole('button', { name: 'Finish' }));
      fireEvent.click(screen.getByRole('button', { name: /Send a test/ }));
      expect(await screen.findByText(/was deleted or changed/)).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Yes, it arrived' }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('Discord direct messages', () => {
    const open = async () => {
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(choose('Discord').getByRole('button', { name: 'Set up' }));
    };
    const withBoth = () => {
      replies['GET /api/notifications/destinations'] = () => json({ available, discord: { webhook: true, dm: true }, destinations });
    };

    it('asks which way when both are open, with the private one first', async () => {
      withBoth();
      await open();
      const dm = screen.getByRole('radio', { name: /direct message from the bot/ }) as HTMLInputElement;
      const hook = screen.getByRole('radio', { name: /channel webhook/ }) as HTMLInputElement;
      expect(dm.checked).toBe(true);
      expect(hook.checked).toBe(false);

      fireEvent.click(hook);
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(screen.getByLabelText('Webhook address')).toBeTruthy();
    });

    it('goes straight to the only way that is open', async () => {
      replies['GET /api/notifications/destinations'] = () => json({ available, discord: { webhook: false, dm: true }, destinations });
      await open();
      expect(await screen.findByLabelText('Your Discord user ID')).toBeTruthy();
      expect(screen.queryByRole('radio')).toBeNull();
    });

    it('says so when no way is open', async () => {
      replies['GET /api/notifications/destinations'] = () => json({ available, discord: { webhook: false, dm: false }, destinations });
      await open();
      expect(await screen.findByText(/hasn’t opened a way to connect Discord/)).toBeTruthy();
    });

    it('sends a code to the account, then connects when the person types it back', async () => {
      withBoth();
      replies['POST /api/notifications/destinations/discord/dm'] = () => {
        destinations = [dest({ id: 8, channel: 'discord', kind: 'dm', label: 'Discord · direct message', state: 'unverified', verified: false })];
        return json({ id: 8, label: 'Discord · direct message', kind: 'dm', expiresUtc: '2026-11-10T09:10:00Z' });
      };
      replies['POST /api/notifications/destinations/discord/dm/confirm'] = () => {
        destinations = [dest({ id: 8, channel: 'discord', kind: 'dm', label: 'Discord · direct message' })];
        return new Response(null, { status: 204 });
      };
      await open();
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

      expect(screen.getByText(/Copy User ID/)).toBeTruthy();
      const send = screen.getByRole('button', { name: 'Send me a code' }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText('Your Discord user ID'), { target: { value: ' 123456789012345678 ' } });
      fireEvent.click(send);

      const code = await screen.findByLabelText('Code from the bot');
      expect(calls.find(c => c.url.endsWith('/discord/dm'))?.body).toEqual({ userId: '123456789012345678' });
      fireEvent.change(code, { target: { value: 'abcd-efgh' } });
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

      await waitFor(() => expect(calls.find(c => c.url.endsWith('/dm/confirm'))?.body).toEqual({ code: 'abcd-efgh' }));
      await waitFor(() => expect(tile('Discord').textContent).toContain('Connected'));
      expect(screen.getByRole('switch', { name: 'Send notifications here' })).toBeTruthy();
    });

    it('shows why a code could not be sent', async () => {
      withBoth();
      replies['POST /api/notifications/destinations/discord/dm'] = () =>
        json({ error: 'Discord won’t let the bot message you. Share a server with the bot, and allow direct messages from server members in Discord’s privacy settings.' }, 409);
      await open();
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      fireEvent.change(screen.getByLabelText('Your Discord user ID'), { target: { value: '123456789012345678' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send me a code' }));
      expect((await screen.findByRole('alert')).textContent).toContain('allow direct messages');
    });

    it('shows a wrong code’s reason and keeps the box', async () => {
      destinations = [dest({ id: 8, channel: 'discord', kind: 'dm', label: 'Discord · direct message', state: 'unverified', verified: false })];
      replies['POST /api/notifications/destinations/discord/dm/confirm'] = () =>
        json({ error: 'That code doesn’t match, or it has expired. Ask for a new one.' }, 400);
      replies['DELETE /api/notifications/destinations/8'] = () => new Response(null, { status: 204 });
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(choose('Discord').getByRole('button', { name: 'Finish' }));
      fireEvent.change(screen.getByLabelText('Code from the bot'), { target: { value: 'AAAA-AAAA' } });
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
      expect((await screen.findByRole('alert')).textContent).toContain('doesn’t match');
      expect(screen.getByLabelText('Code from the bot')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
      await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/destinations/8'))).toBe(true));
    });
  });

  describe('Telegram', () => {
    it('gives a link to open, and turns into "connected" by itself when the person presses Start', async () => {
      replies['POST /api/notifications/destinations/telegram/link'] = () =>
        json({ url: 'https://t.me/PapyraBot?start=abcdefghij', expiresUtc: '2026-11-10T09:10:00Z', botUsername: 'PapyraBot' });
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(choose('Telegram').getByRole('button', { name: 'Set up' }));
      fireEvent.click(screen.getByRole('button', { name: 'Get a link' }));

      const open = await screen.findByRole('link', { name: /Open Telegram/ });
      expect(open.getAttribute('href')).toBe('https://t.me/PapyraBot?start=abcdefghij');
      expect(open.getAttribute('rel')).toContain('noopener');
      expect(screen.getByText(/Waiting for you to press Start/)).toBeTruthy();

      // The person presses Start in Telegram: the next look finds the chat.
      destinations = [dest({ id: 9, channel: 'telegram', kind: 'chat', label: 'Telegram · @rahul' })];
      await waitFor(() => expect(tile('Telegram').textContent).toContain('Connected'));
      expect(screen.queryByRole('link', { name: /Open Telegram/ })).toBeNull();
      expect(screen.getByRole('switch', { name: 'Send notifications here' })).toBeTruthy();
    });

    it('says what is wrong when no link can be made', async () => {
      replies['POST /api/notifications/destinations/telegram/link'] = () => json({ error: 'Telegram isn’t turned on for this Papyra. Ask an administrator.' }, 409);
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(choose('Telegram').getByRole('button', { name: 'Set up' }));
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

    // A connected place shows what you can do with it as soon as its tile is chosen.
    async function open() {
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      await waitFor(() => expect(tile('ntfy').textContent).toContain('Connected'));
      choose('ntfy');
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
      await waitFor(() => expect(tile('ntfy').textContent).toContain('Needs attention'));
      const panel = choose('ntfy');
      expect(panel.getByText('Paused.')).toBeTruthy();
      expect(panel.getByText('The webhook was deleted.')).toBeTruthy();
      fireEvent.click(panel.getByRole('button', { name: 'Turn back on' }));
      await waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ enabled: true }));
    });

    it('shows a place that needs attention with what went wrong', async () => {
      destinations = [dest({ id: 5, state: 'attention', lastError: 'ntfy had a problem (500).' })];
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      await waitFor(() => expect(tile('ntfy').textContent).toContain('Needs attention'));
      expect(choose('ntfy').getByText('Needs attention: ntfy had a problem (500).')).toBeTruthy();
    });
  });

  describe('the tiles', () => {
    it('are a real tab list: one stop, arrows and Home/End move and choose', async () => {
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      const tabs = screen.getAllByRole('tab');
      expect(screen.getByRole('tablist', { name: 'Where to send' })).toBeTruthy();
      expect(tabs.map(t => t.tabIndex)).toEqual([0, -1, -1, -1]);          // only the chosen tab is a Tab stop
      expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
      expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[0].id);
      expect(tabs[0].getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id);

      tabs[0].focus();
      fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
      expect(document.activeElement).toBe(tabs[1]);
      expect(tabs[1].getAttribute('aria-selected')).toBe('true');
      fireEvent.keyDown(tabs[1], { key: 'End' });
      expect(document.activeElement).toBe(tabs[3]);
      fireEvent.keyDown(tabs[3], { key: 'ArrowRight' });                      // wraps
      expect(document.activeElement).toBe(tabs[0]);
      fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' });
      expect(document.activeElement).toBe(tabs[3]);
      fireEvent.keyDown(tabs[3], { key: 'Home' });
      expect(document.activeElement).toBe(tabs[0]);
    });

    it('keep the chosen service in the address, and open from it', async () => {
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      fireEvent.click(tile('Telegram'));
      expect(where()).toBe('?tab=notifications&service=telegram');
      cleanup();
      mount('/settings?tab=notifications&service=discord');
      await screen.findByRole('heading', { name: 'Where to send' });
      expect(tile('Discord').getAttribute('aria-selected')).toBe('true');
      expect(within(screen.getByRole('tabpanel')).getByText('Get notifications as a Discord message.')).toBeTruthy();
    });

    it('fall back to email for a service that is not there', async () => {
      mount('/settings?tab=notifications&service=carrier-pigeon');
      await screen.findByRole('heading', { name: 'Where to send' });
      expect(tile('Email').getAttribute('aria-selected')).toBe('true');
    });

    it('colour a mark only while the service is connected', async () => {
      destinations = [dest({ id: 5, channel: 'ntfy' })];
      mount();
      await screen.findByRole('heading', { name: 'Where to send' });
      await waitFor(() => expect(tile('ntfy').textContent).toContain('Connected'));
      const colour = (name: string) => (tile(name).querySelector('.service-mark') as SVGElement).style.color;
      expect(colour('ntfy')).toBe('var(--brand-ntfy)');
      expect(colour('Discord')).toBe('');                                     // at rest: the heading ink
      expect(colour('Telegram')).toBe('');
    });
  });
});
