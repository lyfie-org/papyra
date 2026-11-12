import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// Notifications beyond email (ntfy, Discord, Telegram), from both ends. A person connects their own place to
// send to; an administrator turns each service on once. Secrets (a webhook address, a bot token) only
// ever go up, never come back down.

export type ChatChannel = 'ntfy' | 'discord' | 'telegram';

/** The order the cards are shown in. */
export const CHAT_CHANNELS: ChatChannel[] = ['discord', 'telegram', 'ntfy'];

export const CHANNEL_NAMES: Record<string, string> = {
  email: 'Email', discord: 'Discord', telegram: 'Telegram', ntfy: 'ntfy',
};

/** How often, in milliseconds, to look for a Telegram chat while its link is open. Tests make it short. */
export const telegramPolling = { ms: 3000 };

export type DestinationState = 'unverified' | 'paused' | 'off' | 'attention' | 'connected';
export type PrivacyTier = 'minimal' | 'titles';

export interface Destination {
  id: number;
  channel: ChatChannel;
  kind: string;
  label: string;
  verified: boolean;
  enabled: boolean;
  privacyTier: PrivacyTier;
  state: DestinationState;
  lastOkUtc: string | null;
  lastErrorUtc: string | null;
  lastError: string | null;
  pausedUtc: string | null;
}

export interface Destinations {
  /** The chat channels an administrator has switched on. */
  available: string[];
  /** Which ways of connecting Discord are open: a channel webhook, a direct message from the bot. */
  discord?: { webhook: boolean; dm: boolean };
  destinations: Destination[];
}

/** A server's refusal, with the machine-readable bits the screen can act on. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly host?: string;

  constructor(message: string, status: number, code?: string, host?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.host = host;
  }
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? `${method} ${url} failed: ${res.status}`, res.status, data?.code, data?.host);
  return data as T;
}

export const DESTINATIONS_KEY = ['notification-destinations'] as const;
export const CHANNEL_ADMIN_KEY = ['channel-admin'] as const;
const NOTIFY_KEY = ['notification-prefs'] as const;

// ── A person's own destinations ───────────────────────────────────────────────

/** `pollMs` re-reads on a timer — used while waiting for a Telegram link to be pressed. */
export function useDestinations(pollMs: number | false = false) {
  return useQuery({
    queryKey: DESTINATIONS_KEY,
    queryFn: () => send<Destinations>('GET', '/api/notifications/destinations'),
    refetchInterval: pollMs,
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: DESTINATIONS_KEY }),
    // The per-event columns depend on what is connected.
    qc.invalidateQueries({ queryKey: NOTIFY_KEY }),
  ]);
}

export interface NtfySetup { id: number; topic: string; subscribeUrl: string; weakTopic: boolean }

export function useSetupNtfy() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (topic: string) => send<NtfySetup>('POST', '/api/notifications/destinations/ntfy', { topic: topic.trim() || null }),
    onSuccess: refresh,
  });
}

export function useNtfyAddress() {
  return useMutation({
    mutationFn: (id: number) => send<{ topic: string; subscribeUrl: string }>('GET', `/api/notifications/destinations/ntfy/${id}/address`),
  });
}

export function useSetupDiscordWebhook() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (url: string) => send<{ id: number; label: string }>('POST', '/api/notifications/destinations/discord/webhook', { url }),
    onSuccess: refresh,
  });
}

export function useSetupDiscordDirect() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (userId: string) =>
      send<{ id: number; label: string; expiresUtc: string }>('POST', '/api/notifications/destinations/discord/dm', { userId: userId.trim() }),
    onSuccess: refresh,
  });
}

export function useConfirmDiscordDirect() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (code: string) => send<null>('POST', '/api/notifications/destinations/discord/dm/confirm', { code }),
    onSuccess: refresh,
  });
}

export interface TelegramLink { url: string; expiresUtc: string; botUsername: string }

export function useTelegramLink() {
  return useMutation({
    mutationFn: () => send<TelegramLink>('POST', '/api/notifications/destinations/telegram/link'),
  });
}

export function useTestDestination() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: number) => send<{ ok: boolean; error: string | null }>('POST', `/api/notifications/destinations/${id}/test`),
    onSettled: refresh,
  });
}

export function useConfirmDestination() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: number) => send<null>('POST', `/api/notifications/destinations/${id}/confirm`),
    onSuccess: refresh,
  });
}

export function useUpdateDestination() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number; enabled?: boolean; privacyTier?: PrivacyTier }) =>
      send<null>('PATCH', `/api/notifications/destinations/${id}`, patch),
    onSuccess: refresh,
  });
}

export function useRemoveDestination() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: number) => send<null>('DELETE', `/api/notifications/destinations/${id}`),
    onSuccess: refresh,
  });
}

// ── Administrators ────────────────────────────────────────────────────────────

export interface ChannelAdmin {
  ntfy: { enabled: boolean; serverUrl: string; defaultServerUrl: string; hasToken: boolean };
  discord: { enabled: boolean; webhooksAllowed: boolean; hasBotToken: boolean; botUsername: string };
  telegram: { enabled: boolean; hasToken: boolean; botUsername: string; pollError: string | null };
  allowedHosts: string[];
}

export function useChannelAdmin(enabled = true) {
  return useQuery({
    queryKey: CHANNEL_ADMIN_KEY,
    queryFn: () => send<ChannelAdmin>('GET', '/api/admin/notifications'),
    enabled,
  });
}

function useAdminRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: CHANNEL_ADMIN_KEY }),
    qc.invalidateQueries({ queryKey: DESTINATIONS_KEY }),
  ]);
}

export interface NtfyAdminWrite { enabled?: boolean; serverUrl?: string; token?: string; allowHost?: boolean }

export function useSaveNtfyAdmin() {
  const refresh = useAdminRefresh();
  return useMutation({
    mutationFn: (body: NtfyAdminWrite) => send<null>('PUT', '/api/admin/notifications/ntfy', body),
    onSuccess: refresh,
  });
}

export function useTestNtfyAdmin() {
  return useMutation({
    mutationFn: (topic: string) => send<{ ok: boolean; error: string | null }>('POST', '/api/admin/notifications/ntfy/test', { topic }),
  });
}

export function useSaveDiscordAdmin() {
  const refresh = useAdminRefresh();
  return useMutation({
    mutationFn: (body: { enabled?: boolean; webhooksAllowed?: boolean; botToken?: string }) => send<null>('PUT', '/api/admin/notifications/discord', body),
    onSuccess: refresh,
  });
}

export function useTestDiscordAdmin() {
  return useMutation({
    mutationFn: (url: string) => send<{ ok: boolean; error: string | null }>('POST', '/api/admin/notifications/discord/test', { url }),
  });
}

export function useCheckDiscordBotAdmin() {
  const refresh = useAdminRefresh();
  return useMutation({
    mutationFn: () => send<{ ok: boolean; botUsername?: string | null; error?: string | null }>('POST', '/api/admin/notifications/discord/check-bot'),
    onSettled: refresh,
  });
}

export function useSaveTelegramAdmin() {
  const refresh = useAdminRefresh();
  return useMutation({
    mutationFn: (body: { enabled?: boolean; token?: string }) =>
      send<{ botUsername: string | null }>('PUT', '/api/admin/notifications/telegram', body),
    onSuccess: refresh,
  });
}

export function useCheckTelegramAdmin() {
  const refresh = useAdminRefresh();
  return useMutation({
    mutationFn: () => send<{ ok: boolean; botUsername?: string | null; error?: string | null }>('POST', '/api/admin/notifications/telegram/check'),
    onSettled: refresh,
  });
}

export function useSaveAllowedHosts() {
  const refresh = useAdminRefresh();
  return useMutation({
    mutationFn: (hosts: string[]) => send<null>('PUT', '/api/admin/notifications/allowed-hosts', { hosts }),
    onSuccess: refresh,
  });
}
