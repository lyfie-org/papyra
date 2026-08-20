import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// Admin-editable instance configuration: SSO and outbound email.
//
// Both live in the database rather than appsettings.json, because someone
// running the published container has no practical way to edit a config file or
// add environment variables. Secrets are write-only over this API — the server
// reports whether one is stored, never its value — so a blank secret field on
// save means "keep what you have".

export interface OidcConfig {
  enabled: boolean;
  authority: string;
  clientId: string;
  hasClientSecret: boolean;
  displayName: string;
  redirectUri: string;
  ready: boolean;
}

export interface OidcConfigWrite {
  enabled: boolean;
  authority: string;
  clientId: string;
  /** Omit to keep the stored secret. */
  clientSecret?: string;
  displayName: string;
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

export interface NotificationPrefs {
  mention: boolean;
  share: boolean;
  emailConfigured: boolean;
  hasAddress: boolean;
}

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

export function useSaveOidcConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (next: OidcConfigWrite) => putJson('/api/auth/oidc', next),
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
    mutationFn: (next: { mention?: boolean; share?: boolean }) =>
      putJson('/api/auth/notifications', next),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFY_KEY }),
  });
}
