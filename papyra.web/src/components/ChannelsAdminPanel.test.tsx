// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import ChannelsAdminPanel from './ChannelsAdminPanel';
import type { ChannelAdmin } from '../hooks/useChannels';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const admin = (over: Partial<ChannelAdmin> = {}): ChannelAdmin => ({
  ntfy: { enabled: false, serverUrl: '', defaultServerUrl: 'https://ntfy.sh', hasToken: false },
  discord: { enabled: false, webhooksAllowed: true, hasBotToken: false, botUsername: '' },
  telegram: { enabled: false, hasToken: false, botUsername: '', pollError: null },
  allowedHosts: [],
  ...over,
});

let calls: { url: string; method: string; body?: unknown }[];
let current: ChannelAdmin;
let replies: Record<string, () => Response>;

function Where() { const l = useLocation(); return <output data-testid="where">{l.search}</output>; }

function mount(url = '/settings?tab=channels') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={[url]}><QueryClientProvider client={client}><ChannelsAdminPanel /><Where /></QueryClientProvider></MemoryRouter>);
}

// One tile per service; only the chosen service's panel is on screen. `groupFor` chooses it and returns its group.
const tile = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });
const groupFor = (title: string) => {
  fireEvent.click(tile(title));
  return screen.getByRole('heading', { name: title }).closest('section') as HTMLElement;
};

beforeEach(() => {
  calls = [];
  current = admin();
  replies = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const key = `${method} ${url}`;
    if (replies[key]) return replies[key]();
    if (key === 'GET /api/admin/notifications') return json(current);
    if (method === 'PUT') return new Response(null, { status: 204 });
    return json({}, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ChannelsAdminPanel', () => {
  it('shows each service at rest: off, with its server, and no secret', async () => {
    current = admin({
      ntfy: { enabled: true, serverUrl: 'https://ntfy.home.lan', defaultServerUrl: 'https://ntfy.sh', hasToken: true },
      telegram: { enabled: true, hasToken: true, botUsername: 'PapyraBot', pollError: null },
      allowedHosts: ['ntfy.home.lan'],
    });
    mount();
    const ntfy = within(await screen.findByRole('tablist').then(() => groupFor('ntfy')));
    expect(ntfy.getByText('On')).toBeTruthy();
    expect(ntfy.getByText('https://ntfy.home.lan')).toBeTruthy();
    expect(ntfy.getByText('Saved')).toBeTruthy();                                   // the token: saved, never shown
    expect(within(groupFor('Discord')).getByText('Off')).toBeTruthy();
    expect(within(groupFor('Telegram')).getByText('@PapyraBot')).toBeTruthy();
    expect(within(groupFor('Network access')).getByText('ntfy.home.lan')).toBeTruthy();
  });

  it('says the public ntfy is used when no server is set', async () => {
    mount();
    await screen.findByRole('tablist');
    expect(within(groupFor('ntfy')).getByText('ntfy.sh (public)')).toBeTruthy();
  });

  describe('ntfy', () => {
    async function openEditor() {
      mount();
      await screen.findByRole('tablist');
      fireEvent.click(within(groupFor('ntfy')).getAllByRole('button', { name: 'Edit' })[0]);
    }

    it('turns it on with a server and a token', async () => {
      await openEditor();
      fireEvent.click(screen.getByRole('switch', { name: /Let people use ntfy/ }));
      fireEvent.change(screen.getByLabelText('Server'), { target: { value: 'https://ntfy.example.com' } });
      fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'tk_secret' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({
        enabled: true, serverUrl: 'https://ntfy.example.com', token: 'tk_secret',
      }));
    });

    it('keeps a saved token when the field is left blank', async () => {
      current = admin({ ntfy: { enabled: true, serverUrl: '', defaultServerUrl: 'https://ntfy.sh', hasToken: true } });
      await openEditor();
      expect((screen.getByLabelText('Access token') as HTMLInputElement).placeholder).toBe('Saved — leave blank to keep');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ enabled: true, serverUrl: '' }));
    });

    it('removes the token on request', async () => {
      current = admin({ ntfy: { enabled: true, serverUrl: '', defaultServerUrl: 'https://ntfy.sh', hasToken: true } });
      await openEditor();
      fireEvent.click(screen.getByRole('button', { name: 'Remove token' }));
      await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ token: '' }));
    });

    it('offers to allow a server on the admin’s own network — only when asked', async () => {
      let attempts = 0;
      replies['PUT /api/admin/notifications/ntfy'] = () => {
        attempts++;
        return attempts === 1
          ? json({ code: 'host_not_allowed', host: 'ntfy.lan', error: 'That server is on your own network. Allow it first so Papyra may connect to it.' }, 400)
          : new Response(null, { status: 204 });
      };
      await openEditor();
      fireEvent.change(screen.getByLabelText('Server'), { target: { value: 'https://ntfy.lan' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('That server is on your own network.')).toBeTruthy();
      expect(calls.find(c => c.method === 'PUT')?.body).not.toHaveProperty('allowHost'); // nothing was allowed by itself
      fireEvent.click(screen.getByRole('button', { name: 'Allow ntfy.lan and save' }));

      await waitFor(() => expect(calls.filter(c => c.method === 'PUT').at(-1)?.body).toMatchObject({ serverUrl: 'https://ntfy.lan', allowHost: true }));
      await waitFor(() => expect(screen.queryByLabelText('Server')).toBeNull());       // saved: the editor folds away
    });

    it('explains an address that can never be used', async () => {
      replies['PUT /api/admin/notifications/ntfy'] = () =>
        json({ code: 'blocked', host: '169.254.169.254', error: 'Papyra can never connect to that address (this machine itself, a link-local or reserved address).' }, 400);
      await openEditor();
      fireEvent.change(screen.getByLabelText('Server'), { target: { value: 'https://169.254.169.254' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('That server can’t be used.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Allow/ })).toBeNull();
    });

    it('sends a test message to a topic', async () => {
      replies['POST /api/admin/notifications/ntfy/test'] = () => json({ ok: true, error: null });
      mount();
      await screen.findByRole('tablist');
      fireEvent.click(within(groupFor('ntfy')).getByRole('button', { name: 'Send…' }));
      const send = screen.getByRole('button', { name: /^Send$/ }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'my-trial' } });
      fireEvent.click(send);

      expect(await screen.findByText('Sent. Look for it in the ntfy app.')).toBeTruthy();
      expect(calls.find(c => c.url.endsWith('/ntfy/test'))?.body).toEqual({ topic: 'my-trial' });
    });
  });

  describe('Discord', () => {
    it('turns Discord on and decides about webhooks', async () => {
      mount();
      await screen.findByRole('tablist');
      fireEvent.click(within(groupFor('Discord')).getAllByRole('button', { name: 'Edit' })[0]);
      fireEvent.click(screen.getByRole('switch', { name: /Let people use Discord/ }));
      fireEvent.click(screen.getByRole('switch', { name: /Allow channel messages/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ enabled: true, webhooksAllowed: false }));
    });

    it('saves a bot token with the switches, and keeps it when the field is left blank', async () => {
      mount();
      await screen.findByRole('tablist');
      expect(within(groupFor('Discord')).getByText('No bot yet')).toBeTruthy();
      fireEvent.click(within(groupFor('Discord')).getAllByRole('button', { name: 'Edit' })[0]);
      fireEvent.change(screen.getByLabelText('Bot token (for direct messages)'), { target: { value: 'BOT.token.value' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ enabled: false, webhooksAllowed: true, botToken: 'BOT.token.value' }));
    });

    it('shows the bot at rest, never its token, and can check or remove it', async () => {
      current = admin({ discord: { enabled: true, webhooksAllowed: true, hasBotToken: true, botUsername: 'PapyraBot' } });
      replies['POST /api/admin/notifications/discord/check-bot'] = () => json({ ok: true, botUsername: 'PapyraBot', error: null });
      mount();
      await screen.findByRole('tablist');
      expect(within(groupFor('Discord')).getByText('Bot PapyraBot')).toBeTruthy();

      fireEvent.click(within(groupFor('Discord')).getByRole('button', { name: 'Check' }));
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
      expect(await screen.findByText('Discord knows the bot PapyraBot.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));

      fireEvent.click(within(groupFor('Discord')).getAllByRole('button', { name: 'Edit' })[0]);
      expect((screen.getByLabelText('Bot token (for direct messages)') as HTMLInputElement).placeholder).toBe('Saved — leave blank to keep');
      fireEvent.click(screen.getByRole('button', { name: 'Remove bot' }));
      await waitFor(() => expect(calls.filter(c => c.method === 'PUT').at(-1)?.body).toEqual({ botToken: '' }));
    });

    it('shows Discord’s verdict on a wrong bot token and stays open', async () => {
      replies['PUT /api/admin/notifications/discord'] = () => json({ error: 'Discord doesn’t accept that token. Copy it again from the Discord developer portal (Bot → Reset Token).' }, 400);
      mount();
      await screen.findByRole('tablist');
      fireEvent.click(within(groupFor('Discord')).getAllByRole('button', { name: 'Edit' })[0]);
      fireEvent.change(screen.getByLabelText('Bot token (for direct messages)'), { target: { value: 'wrong' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect((await screen.findByRole('alert')).textContent).toContain('Reset Token');
    });

    it('tries a webhook without saving it, and shows what went wrong', async () => {
      replies['POST /api/admin/notifications/discord/test'] = () => json({ ok: false, error: 'The Discord webhook was deleted or changed. Make a new one in Discord and connect it again.' });
      mount();
      await screen.findByRole('tablist');
      fireEvent.click(within(groupFor('Discord')).getByRole('button', { name: 'Send…' }));
      fireEvent.change(screen.getByLabelText('Webhook address'), { target: { value: 'https://discord.com/api/webhooks/1/x' } });
      fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
      expect((await screen.findByRole('alert')).textContent).toContain('was deleted or changed');
    });
  });

  describe('Telegram', () => {
    async function openEditor() {
      mount();
      await screen.findByRole('tablist');
      fireEvent.click(within(groupFor('Telegram')).getAllByRole('button', { name: 'Edit' })[0]);
    }

    it('saves the bot token with the switch', async () => {
      await openEditor();
      fireEvent.click(screen.getByRole('switch', { name: /Let people use Telegram/ }));
      fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: '123:abc' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ enabled: true, token: '123:abc' }));
    });

    it('shows Telegram’s verdict on a wrong token and stays open', async () => {
      replies['PUT /api/admin/notifications/telegram'] = () => json({ error: 'Telegram doesn’t accept that token. Copy it again from BotFather.' }, 400);
      await openEditor();
      fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: 'wrong' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect((await screen.findByRole('alert')).textContent).toContain('BotFather');
      expect(screen.getByLabelText('Bot token')).toBeTruthy();
    });

    it('reports a problem reading the bot’s messages', async () => {
      current = admin({ telegram: { enabled: true, hasToken: true, botUsername: 'PapyraBot', pollError: 'Something else is already reading this bot’s messages.' } });
      mount();
      await screen.findByRole('tablist');
      expect(within(groupFor('Telegram')).getByText(/Not reading messages: Something else/)).toBeTruthy();
    });

    it('asks Telegram whether the bot still works', async () => {
      current = admin({ telegram: { enabled: true, hasToken: true, botUsername: 'PapyraBot', pollError: null } });
      replies['POST /api/admin/notifications/telegram/check'] = () => json({ ok: true, botUsername: 'PapyraBot', error: null });
      mount();
      await screen.findByRole('tablist');
      fireEvent.click(within(groupFor('Telegram')).getByRole('button', { name: 'Check' }));
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
      expect(await screen.findByText('Telegram knows the bot @PapyraBot.')).toBeTruthy();
    });

    it('offers no check until there is a bot', async () => {
      mount();
      await screen.findByRole('tablist');
      expect(within(groupFor('Telegram')).queryByRole('button', { name: 'Check' })).toBeNull();
      expect(within(groupFor('Telegram')).getByText('No bot yet')).toBeTruthy();
    });
  });

  describe('servers on the network', () => {
    it('saves one name or address per line, without blanks', async () => {
      current = admin({ allowedHosts: ['ntfy.lan'] });
      mount();
      await screen.findByRole('tablist');
      fireEvent.click(within(groupFor('Network access')).getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByLabelText('One name or address per line'), { target: { value: 'ntfy.lan\n\n  192.168.1.5  \n' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ hosts: ['ntfy.lan', '192.168.1.5'] }));
    });

    it('shows the server’s complaint about an entry', async () => {
      replies['PUT /api/admin/notifications/allowed-hosts'] = () => json({ error: '“https://x” isn’t a host name or address. Enter just the name or IP, without https:// or a port.' }, 400);
      mount();
      await screen.findByRole('tablist');
      fireEvent.click(within(groupFor('Network access')).getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByLabelText('One name or address per line'), { target: { value: 'https://x' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect((await screen.findByRole('alert')).textContent).toContain('without https://');
    });
  });

  describe('the tiles', () => {
    const chip = (name: string) => tile(name).querySelector('.service-tab__chip')!.textContent;

    it('show ntfy, Discord, Telegram and Network access, each saying where it stands', async () => {
      current = admin({
        ntfy: { enabled: true, serverUrl: '', defaultServerUrl: 'https://ntfy.sh', hasToken: false },
        discord: { enabled: true, webhooksAllowed: false, hasBotToken: false, botUsername: '' },     // on, but nobody can connect
        telegram: { enabled: false, hasToken: false, botUsername: '', pollError: null },
        allowedHosts: ['a.lan', 'b.lan'],
      });
      mount();
      await screen.findByRole('tablist');
      expect(screen.getAllByRole('tab').map(t => t.querySelector('.service-tab__name')!.textContent)).toEqual(['ntfy', 'Discord', 'Telegram', 'Network access']);
      expect(chip('ntfy')).toBe('On');
      expect(chip('Discord')).toBe('Needs attention');
      expect(chip('Telegram')).toBe('Not set up');
      expect(chip('Network access')).toBe('2 servers added');
      expect(tile('ntfy').getAttribute('data-tone')).toBe('on');
      expect(tile('Discord').getAttribute('data-tone')).toBe('attention');
    });

    it('tell Off from Not set up, and flag a Telegram that cannot read its messages', async () => {
      current = admin({
        ntfy: { enabled: false, serverUrl: '', defaultServerUrl: 'https://ntfy.sh', hasToken: false },
        discord: { enabled: false, webhooksAllowed: true, hasBotToken: true, botUsername: 'Bot' },
        telegram: { enabled: true, hasToken: true, botUsername: 'PapyraBot', pollError: 'Something else is reading this bot.' },
      });
      mount();
      await screen.findByRole('tablist');
      expect(chip('ntfy')).toBe('Off');
      expect(chip('Discord')).toBe('Off');
      expect(chip('Telegram')).toBe('Needs attention');
      expect(chip('Network access')).toBe('None added');
    });

    it('open the first service by default, and keep the chosen one in the address', async () => {
      mount();
      await screen.findByRole('tablist');
      expect(tile('ntfy').getAttribute('aria-selected')).toBe('true');
      fireEvent.click(tile('Telegram'));
      expect(screen.getByTestId('where').textContent).toBe('?tab=channels&service=telegram');
      expect(screen.getByRole('tabpanel').textContent).toContain('Create one with BotFather');
    });

    it('open from the old section links, so nothing already shared breaks', async () => {
      mount('/settings?tab=channels&s=channels-hosts');
      await screen.findByRole('tablist');
      expect(tile('Network access').getAttribute('aria-selected')).toBe('true');
      cleanup();
      mount('/settings?tab=channels&s=channels-discord');
      await screen.findByRole('tablist');
      expect(tile('Discord').getAttribute('aria-selected')).toBe('true');
      cleanup();
      mount('/settings?tab=channels&service=telegram&s=channels-discord');       // an explicit service wins
      await screen.findByRole('tablist');
      expect(tile('Telegram').getAttribute('aria-selected')).toBe('true');
    });

    it('move with the arrow keys, Home and End, and keep the panel in step', async () => {
      mount();
      await screen.findByRole('tablist');
      tile('ntfy').focus();
      fireEvent.keyDown(tile('ntfy'), { key: 'ArrowRight' });
      expect(document.activeElement).toBe(tile('Discord'));
      expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tile('Discord').id);
      fireEvent.keyDown(tile('Discord'), { key: 'End' });
      expect(document.activeElement).toBe(tile('Network access'));
      expect(screen.getByRole('heading', { name: 'Network access' })).toBeTruthy();
    });
  });
});
