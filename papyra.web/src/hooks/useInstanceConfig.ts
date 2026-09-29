import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// Admin-editable instance configuration: SSO and outbound email.
//
// Both live in the database rather than appsettings.json, because someone
// running the published container has no practical way to edit a config file or
// add environment variables. Secrets are write-only over this API — the server
// reports whether one is stored, never its value — so a blank secret field on
// save means "keep what you have".

export type SsoKind = 'authentik' | 'keycloak' | 'google' | 'entra' | 'other';

/** One identity provider as Settings → SSO sees it. The secret never comes back. */
export interface SsoProvider {
  id: string;
  kind: SsoKind;
  displayName: string;
  authority: string;
  clientId: string;
  hasClientSecret: boolean;
  enabled: boolean;
  ready: boolean;
  /** A built-in icon key; null = the kind's own. */
  icon: string | null;
  /** An uploaded icon (data: URL); wins over `icon`. */
  iconData: string | null;
  /** Null = "Continue with {displayName}". */
  hoverText: string | null;
  redirectUri: string;
}

export type SsoDisplay = 'buttons' | 'icons';

export interface OidcConfig {
  display: SsoDisplay;
  /** This Papyra's public address (the Launch URL some providers ask for). */
  origin: string;
  /** A new provider's redirect URI is this plus its id. */
  redirectUriPrefix: string;
  providers: SsoProvider[];
}

export interface SsoProviderWrite {
  kind: SsoKind;
  displayName: string;
  authority: string;
  clientId: string;
  /** Omit to keep the stored secret. */
  clientSecret?: string;
  enabled: boolean;
  icon?: string | null;
  iconData?: string | null;
  hoverText?: string | null;
}

export interface SmtpConfig {
  enabled: boolean;
  host: string;
  port: number;
  useSsl: boolean;
  username: string;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string;
  publicUrl: string;
}

export interface SmtpConfigWrite extends Omit<SmtpConfig, 'hasPassword'> {
  /** Omit to keep the stored password. */
  password?: string;
}

/** One thing Papyra can tell you about, and whether it emails you. */
export interface NotificationEvent {
  id: string;
  group: string;
  label: string;
  description: string;
  /** Always sent; shown switched on and locked. */
  critical: boolean;
  email: boolean;
}

export interface NotificationPrefs {
  mention: boolean;
  share: boolean;
  emailConfigured: boolean;
  hasAddress: boolean;
  /** Delivery channels the server knows. Email today; push joins later. */
  channels: string[];
  groups: { id: string; label: string }[];
  events: NotificationEvent[];
}

export interface NotificationSwitch { id: string; enabled: boolean; channel?: string }

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json();
}

async function putJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? `PUT ${url} failed: ${res.status}`);
  }
}

export const OIDC_KEY = ['oidc-config'] as const;
export const SMTP_KEY = ['smtp-config'] as const;
export const NOTIFY_KEY = ['notification-prefs'] as const;

export function useOidcConfig(enabled = true) {
  return useQuery({ queryKey: OIDC_KEY, queryFn: () => getJson<OidcConfig>('/api/auth/oidc'), enabled });
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `${method} ${url} failed: ${res.status}`);
  return data as T;
}

/** Add a provider (no id) or change one. Answers with its id and redirect URI. */
export function useSaveSsoProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, provider }: { id?: string; provider: SsoProviderWrite }) =>
      send<{ id: string; redirectUri: string }>(id ? 'PUT' : 'POST', id ? `/api/auth/oidc/providers/${id}` : '/api/auth/oidc/providers', provider),
    onSuccess: () => qc.invalidateQueries({ queryKey: OIDC_KEY }),
  });
}

export function useDeleteSsoProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => send<null>('DELETE', `/api/auth/oidc/providers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: OIDC_KEY }),
  });
}

export function useSaveSsoDisplay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (display: SsoDisplay) => putJson('/api/auth/oidc/display', { display }),
    onSuccess: () => qc.invalidateQueries({ queryKey: OIDC_KEY }),
  });
}

export function useSmtpConfig(enabled = true) {
  return useQuery({ queryKey: SMTP_KEY, queryFn: () => getJson<SmtpConfig>('/api/auth/smtp'), enabled });
}

export function useSaveSmtpConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (next: SmtpConfigWrite) => putJson('/api/auth/smtp', next),
    onSuccess: () => qc.invalidateQueries({ queryKey: SMTP_KEY }),
  });
}

/** Send a test message so the settings are proven before a reset link depends on them. */
export function useSendTestEmail() {
  return useMutation({
    mutationFn: async (to: string): Promise<string> => {
      const res = await fetch('/api/auth/smtp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: to.trim() || null }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Test send failed: ${res.status}`);
      return data?.to ?? to;
    },
  });
}

export function useInviteUser() {
  return useMutation({
    mutationFn: async (invite: { username: string; email: string; role: string }) => {
      const res = await fetch('/api/auth/smtp/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invite),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Invite failed: ${res.status}`);
      return data;
    },
  });
}

export function useNotificationPrefs() {
  return useQuery({ queryKey: NOTIFY_KEY, queryFn: () => getJson<NotificationPrefs>('/api/auth/notifications') });
}

export function useSaveNotificationPrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (next: { mention?: boolean; share?: boolean; events?: NotificationSwitch[] }) =>
      putJson('/api/auth/notifications', next),
    // Flip the switch at once; the server's answer follows.
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: NOTIFY_KEY });
      const prev = qc.getQueryData<NotificationPrefs>(NOTIFY_KEY);
      if (prev && next.events) {
        const on = new Map(next.events.map(e => [e.id, e.enabled]));
        qc.setQueryData<NotificationPrefs>(NOTIFY_KEY, {
          ...prev,
          events: prev.events.map(e => (on.has(e.id) ? { ...e, email: on.get(e.id)! } : e)),
        });
      }
      return { prev };
    },
    onError: (_err, _next, context) => {
      if (context?.prev) qc.setQueryData(NOTIFY_KEY, context.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: NOTIFY_KEY }),
  });
}
