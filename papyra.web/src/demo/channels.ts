// Notification services in the browser demo. Nothing is ever sent: ntfy and Discord can be "connected",
// tested and confirmed so the screens can be tried out; Telegram needs a real server (it has to talk to
// Telegram). Kept in memory like the demo's other notification switches.

import type { Destination, PrivacyTier } from '../hooks/useChannels';
import type { Route } from './backend';

/** The notification services the demo offers. */
export const DEMO_AVAILABLE_CHANNELS = ['discord', 'telegram', 'ntfy'];

let nextId = 1;
let destinations: Destination[] = [];
/** "channel:eventId" → switched off. Chat channels start from each event's default, which is on. */
const chatOff = new Set<string>(['ntfy:data.backup_succeeded', 'discord:data.backup_succeeded', 'telegram:data.backup_succeeded']);

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const noContent = (): Response => new Response(null, { status: 204 });

/** Each chat channel's switch for one event. */
export function demoChatFor(eventId: string, critical: boolean): Record<string, boolean> {
  if (critical) return {};
  return Object.fromEntries(DEMO_AVAILABLE_CHANNELS.map((c) => [c, !chatOff.has(`${c}:${eventId}`)]));
}

export function setDemoChatSwitch(channel: string, eventId: string, enabled: boolean): void {
  if (enabled) chatOff.delete(`${channel}:${eventId}`);
  else chatOff.add(`${channel}:${eventId}`);
}

function stateOf(d: Destination): Destination['state'] {
  if (!d.verified) return 'unverified';
  if (d.pausedUtc) return 'paused';
  if (!d.enabled) return 'off';
  return 'connected';
}

function create(channel: Destination['channel'], kind: string, label: string): Destination {
  // One place per channel: connecting again replaces it.
  destinations = destinations.filter((d) => d.channel !== channel);
  const made: Destination = {
    id: nextId++, channel, kind, label, verified: false, enabled: true, privacyTier: 'minimal', state: 'unverified',
    lastOkUtc: null, lastErrorUtc: null, lastError: null, pausedUtc: null,
  };
  destinations.push(made);
  return made;
}

const find = (match: RegExpMatchArray) => destinations.find((d) => d.id === Number(match[1]));

export function channelRoutes(): Route[] {
  return [
    ['GET', /^\/api\/notifications\/destinations$/, () =>
      json({
        available: DEMO_AVAILABLE_CHANNELS, discord: { webhook: true, dm: true },
        destinations: destinations.map((d) => ({ ...d, state: stateOf(d) })),
      })],

    ['POST', /^\/api\/notifications\/destinations\/ntfy$/, async ({ body }) => {
      const { topic } = (await body()) as { topic?: string | null };
      const chosen = topic?.trim() || `papyra-demo-${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(chosen)) {
        return json({ error: 'A topic can use letters, digits, - and _ (up to 64 characters).' }, 400);
      }
      const made = create('ntfy', 'topic', 'ntfy · ntfy.sh');
      demoTopics.set(made.id, chosen);
      return json({ id: made.id, topic: chosen, subscribeUrl: `https://ntfy.sh/${chosen}`, weakTopic: chosen.length < 12 });
    }],
    ['GET', /^\/api\/notifications\/destinations\/ntfy\/(\d+)\/address$/, ({ match }) => {
      const topic = demoTopics.get(Number(match[1]));
      return topic ? json({ topic, subscribeUrl: `https://ntfy.sh/${topic}` }) : json({ error: 'Not found' }, 404);
    }],

    ['POST', /^\/api\/notifications\/destinations\/discord\/webhook$/, async ({ body }) => {
      const { url } = (await body()) as { url?: string };
      if (!/^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d{15,25}\/[\w.-]{20,}$/.test(url?.trim() ?? '')) {
        return json({ error: 'That isn’t a Discord webhook address. In Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.' }, 400);
      }
      const made = create('discord', 'webhook', 'Discord · channel');
      return json({ id: made.id, label: made.label, kind: made.kind, sharedWithChannel: true });
    }],

    // Direct messages: the demo "sends" a code you can type back. Any code with 8 letters or digits works.
    ['POST', /^\/api\/notifications\/destinations\/discord\/dm$/, async ({ body }) => {
      const { userId } = (await body()) as { userId?: string };
      if (!/^\d{15,25}$/.test(userId?.trim() ?? '')) {
        return json({ error: 'That doesn’t look like a Discord user ID. In Discord: Settings → Advanced → turn on Developer Mode, then right-click your name → Copy User ID.' }, 400);
      }
      const made = create('discord', 'dm', 'Discord · direct message');
      return json({ id: made.id, label: made.label, kind: made.kind, expiresUtc: new Date(Date.now() + 600_000).toISOString() });
    }],
    ['POST', /^\/api\/notifications\/destinations\/discord\/dm\/confirm$/, async ({ body }) => {
      const { code } = (await body()) as { code?: string };
      const d = destinations.find((x) => x.channel === 'discord' && x.kind === 'dm');
      if (!d || (code ?? '').replace(/[^a-z0-9]/gi, '').length !== 8) return json({ error: 'That code doesn’t match, or it has expired. Ask for a new one.' }, 400);
      d.verified = true;
      return noContent();
    }],

    ['POST', /^\/api\/notifications\/destinations\/telegram\/link$/, () => json(
      { error: 'Connecting Telegram needs a real Papyra server. This demo runs entirely in your browser — install Papyra to use it for real.' }, 501)],

    ['POST', /^\/api\/notifications\/destinations\/(\d+)\/test$/, ({ match }) => {
      const d = find(match);
      if (!d) return json({ error: 'Not found' }, 404);
      d.lastOkUtc = new Date().toISOString();
      d.lastError = null;
      return json({ ok: true, error: null });
    }],
    ['POST', /^\/api\/notifications\/destinations\/(\d+)\/confirm$/, ({ match }) => {
      const d = find(match);
      if (!d) return json({ error: 'Not found' }, 404);
      if (!d.lastOkUtc) return json({ error: 'Send the test message first.' }, 409);
      d.verified = true;
      return noContent();
    }],
    ['PATCH', /^\/api\/notifications\/destinations\/(\d+)$/, async ({ match, body }) => {
      const d = find(match);
      if (!d) return json({ error: 'Not found' }, 404);
      const patch = (await body()) as { enabled?: boolean; privacyTier?: PrivacyTier };
      if (patch.privacyTier) d.privacyTier = patch.privacyTier;
      if (patch.enabled !== undefined) { d.enabled = patch.enabled; if (patch.enabled) d.pausedUtc = null; }
      return noContent();
    }],
    ['DELETE', /^\/api\/notifications\/destinations\/(\d+)$/, ({ match }) => {
      destinations = destinations.filter((d) => d.id !== Number(match[1]));
      return noContent();
    }],
  ];
}

const demoTopics = new Map<number, string>();
