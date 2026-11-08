import { describe, expect, it } from 'vitest';
import { channelRoutes, demoChatFor, setDemoChatSwitch } from './channels';
import type { Destination } from '../hooks/useChannels';

// The demo's chat notifications: connect, test, confirm in memory; nothing leaves the browser.
const routes = channelRoutes();

interface Listed { available: string[]; discord?: { webhook: boolean; dm: boolean }; destinations: Destination[] }
interface Made { id: number; topic: string }

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const route = routes.find(([m, re]) => m === method && re.test(path));
  if (!route) throw new Error(`no demo route for ${method} ${path}`);
  const res = await route[2]({
    match: path.match(route[1])!, url: new URL(path, 'http://demo.invalid'),
    request: new Request('http://demo.invalid' + path), body: async () => body ?? {},
  });
  return { status: res.status, data: (res.status === 204 ? null : await res.json()) as T };
}

describe('demo chat notifications', () => {
  it('offers ntfy, Discord and Telegram, none connected to begin with', async () => {
    const { data } = await call<Listed>('GET', '/api/notifications/destinations');
    expect(data.available).toEqual(['discord', 'telegram', 'ntfy']);
    expect(data.destinations).toEqual([]);
  });

  it('connects ntfy only after a test and a confirmation', async () => {
    const made = (await call<Made>('POST', '/api/notifications/destinations/ntfy', { topic: null })).data;
    expect(made.topic).toMatch(/^papyra-demo-/);
    expect((await call<Listed>('GET', '/api/notifications/destinations')).data.destinations[0].state).toBe('unverified');

    expect((await call('POST', `/api/notifications/destinations/${made.id}/confirm`)).status).toBe(409);
    expect((await call<{ ok: boolean }>('POST', `/api/notifications/destinations/${made.id}/test`)).data.ok).toBe(true);
    expect((await call('POST', `/api/notifications/destinations/${made.id}/confirm`)).status).toBe(204);
    expect((await call<Listed>('GET', '/api/notifications/destinations')).data.destinations[0].state).toBe('connected');
    expect((await call<Made>('GET', `/api/notifications/destinations/ntfy/${made.id}/address`)).data.topic).toBe(made.topic);
  });

  it('turns away a bad topic and anything that is not a Discord webhook', async () => {
    expect((await call('POST', '/api/notifications/destinations/ntfy', { topic: 'has space' })).status).toBe(400);
    expect((await call('POST', '/api/notifications/destinations/discord/webhook', { url: 'https://example.com/x' })).status).toBe(400);
    const ok = await call('POST', '/api/notifications/destinations/discord/webhook', {
      url: 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz',
    });
    expect(ok.status).toBe(200);
  });

  it('connects Discord direct messages with a code, and turns away a bad id or code', async () => {
    expect((await call<Listed>('GET', '/api/notifications/destinations')).data.discord).toEqual({ webhook: true, dm: true });
    expect((await call('POST', '/api/notifications/destinations/discord/dm', { userId: 'rahul' })).status).toBe(400);

    const made = (await call<Made>('POST', '/api/notifications/destinations/discord/dm', { userId: '123456789012345678' })).data;
    expect(made.id).toBeGreaterThan(0);
    expect((await call('POST', '/api/notifications/destinations/discord/dm/confirm', { code: 'nope' })).status).toBe(400);
    expect((await call('POST', '/api/notifications/destinations/discord/dm/confirm', { code: 'ABCD-EFGH' })).status).toBe(204);
    const after = (await call<Listed>('GET', '/api/notifications/destinations')).data.destinations.find((d) => d.id === made.id);
    expect(after).toMatchObject({ kind: 'dm', state: 'connected' });
  });

  it('says Telegram needs a real server', async () => {
    const res = await call<{ error: string }>('POST', '/api/notifications/destinations/telegram/link');
    expect(res.status).toBe(501);
    expect(res.data.error).toContain('real Papyra server');
  });

  it('switches, changes the privacy level and disconnects', async () => {
    const made = (await call<Made>('POST', '/api/notifications/destinations/ntfy', { topic: 'a-long-enough-topic' })).data;
    await call('PATCH', `/api/notifications/destinations/${made.id}`, { enabled: false, privacyTier: 'titles' });
    const after = (await call<Listed>('GET', '/api/notifications/destinations')).data.destinations.find((d) => d.id === made.id);
    expect(after).toMatchObject({ enabled: false, privacyTier: 'titles' });
    expect((await call('DELETE', `/api/notifications/destinations/${made.id}`)).status).toBe(204);
  });

  it('keeps always-on notices email only, and remembers a chat switch', () => {
    expect(demoChatFor('security.new_sign_in', true)).toEqual({});
    setDemoChatSwitch('ntfy', 'collab.mention', false);
    expect(demoChatFor('collab.mention', false).ntfy).toBe(false);
    expect(demoChatFor('collab.mention', false).discord).toBe(true);
    setDemoChatSwitch('ntfy', 'collab.mention', true);
    expect(demoChatFor('collab.mention', false).ntfy).toBe(true);
  });
});
