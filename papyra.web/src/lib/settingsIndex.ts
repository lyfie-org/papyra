/**
 * The settings pages, as searchable entries.
 *
 * Settings are UI concepts, not stored records — the server has no table to
 * search. So the index lives here, next to the page that renders it, and search
 * merges these results with the note results the API returns.
 *
 * Keeping it client-side also makes the admin gate fall out for free: the same
 * `isAdmin` that hides a rail item hides its entries, so a non-admin can never
 * discover an admin page by searching for it.
 *
 * Every `tab` must exist in `NAV` and every `section` must match the `id` on a
 * `.settings__subhead` heading in `SettingsPage.tsx` — that id is what the page
 * scrolls to when a result is opened. `settingsIndex.test.ts` asserts both.
 */

import { AI_ENABLED } from './features';
import { areaOf, type Area, type Tab } from './settingsAreas';
import { t, type MessageKey } from '../i18n/store';

/** One searchable place, as written below. Labels that the catalog owns are keys; the search turns them into words. */
export interface SettingsSource {
  /** `?tab=` value. The tab's own label is `settings.nav.<tab>` in the catalog. */
  tab: Tab;
  /** Heading id within the tab; omitted for an entry that means the whole tab. */
  section?: string;
  /** The heading's visible text, shown as the last breadcrumb. */
  sectionLabel?: string;
  /** Same, for a heading whose text lives in the catalog. */
  sectionKey?: MessageKey;
  adminOnly?: boolean;
  /** Part of the journal's own settings: not offered while the journal is switched off. */
  journalOnly?: boolean;
  /** Set when the entry is a page of its own rather than a tab under Settings. */
  href?: string;
  /**
   * Words a person might type instead of the heading. Never rendered, only matched: "smtp" finds a page whose
   * visible name says "email", and the old name of a renamed page still finds it.
   */
  keywords?: string[];
}

/** A source entry with its words filled in, and the area it lives in. */
export interface SettingsEntry extends SettingsSource {
  /** The tab's name in the rail, shown as the first breadcrumb after the area. */
  tabLabel: string;
  sectionLabel?: string;
  area: Area;
}

const AI_ENTRIES: SettingsSource[] = AI_ENABLED ? [
    { tab: 'ai', adminOnly: true, keywords: ['assistant', 'chat'] },
    { tab: 'ai', section: 'assistant', sectionLabel: 'Assistant', adminOnly: true, keywords: ['chat', 'answers', 'semantic search'] },
    { tab: 'ai', section: 'local-models', sectionLabel: 'On this machine', adminOnly: true, keywords: ['local', 'offline', 'ollama', 'download model', 'install'] },
    { tab: 'ai', section: 'hosted-models', sectionLabel: 'Or use a paid service', adminOnly: true, keywords: ['openai', 'anthropic', 'api key', 'hosted'] },
  ] : [];

export const SETTINGS_INDEX: SettingsSource[] = [
  { tab: 'profile', keywords: ['account', 'avatar', 'profile picture', 'name', 'email'] },
  { tab: 'profile', section: 'account', sectionLabel: 'Account', keywords: ['display name', 'email address', 'time zone', 'timezone', 'last edited'] },
  { tab: 'profile', section: 'change-password', sectionLabel: 'Change password', keywords: ['password', 'new password'] },
  {
    tab: 'profile', section: 'activity', sectionLabel: 'Your writing, day by day',
    keywords: ['heatmap', 'activity', 'streak', 'history', 'stats', 'calendar'],
  },

  { tab: 'appearance', keywords: ['look', 'colours', 'colors'] },
  { tab: 'appearance', section: 'theme', sectionLabel: 'Theme', keywords: ['dark mode', 'light mode', 'night'] },
  { tab: 'appearance', section: 'sidebar-order', sectionLabel: 'Sidebar order', keywords: ['navigation', 'menu', 'left bar', 'notes', 'to do', 'journal', 'reorder', 'arrange'] },
  { tab: 'appearance', section: 'formatting-toolbar', sectionLabel: 'Formatting toolbar', keywords: ['editor', 'toolbar', 'table', 'bullet list', 'heading', 'embed', 'always show'] },

  { tab: 'journal', keywords: ['diary', 'day', 'write'] },
  { tab: 'journal', section: 'journal-use', sectionLabel: 'Use the journal', keywords: ['turn off', 'turn on', 'hide', 'disable', 'enable', 'switch', 'diary'] },
  { tab: 'journal', section: 'journal-day', journalOnly: true, sectionLabel: 'The day', keywords: ['day starts', 'midnight', 'night owl', 'prompts', 'streak', 'hide streak'] },
  { tab: 'journal', section: 'journal-templates', journalOnly: true, sectionLabel: 'Templates', keywords: ['template', 'prompt', 'start from', 'daily page', 'morning pages'] },
  { tab: 'journal', section: 'journal-reminder', journalOnly: true, sectionLabel: 'Reminder', keywords: ['remind', 'nudge', 'email', 'daily', 'notification'] },
  { tab: 'journal', section: 'journal-locking', journalOnly: true, sectionLabel: 'Locking', keywords: ['lock', 'private', 'pin', 'seal', 'encrypt', 'lock all', 'lock new'] },

  { tab: 'notifications', keywords: ['alerts'] },
  { tab: 'notifications', section: 'where-to-send', sectionLabel: 'Where to send', keywords: ['discord', 'telegram', 'ntfy', 'chat', 'phone', 'push', 'webhook', 'connect', 'channel'] },
  { tab: 'notifications', section: 'email-notifications', sectionLabel: 'What Papyra tells you about', keywords: ['email', 'mentions', 'shares', 'backup', 'new sign-in', 'login alert', 'security email', 'push'] },

  { tab: 'security', keywords: ['privacy', 'lock'] },
  { tab: 'security', section: 'biometric-unlock', sectionLabel: 'Passkeys', keywords: ['passkey', 'biometric', 'fingerprint', 'face', 'vault', 'webauthn', 'device'] },
  { tab: 'security', section: 'authenticator', sectionLabel: 'Two-step sign-in', keywords: ['totp', '2fa', 'two-factor', 'otp', 'code', 'authenticator', 'google authenticator', 'authy'] },
  { tab: 'security', section: 'signed-in-devices', sectionLabel: 'Signed-in devices', keywords: ['sessions', 'devices', 'sign out', 'log out', 'logged in', 'remember'] },
  { tab: 'security', section: 'delete-account', sectionLabel: 'Delete account', keywords: ['delete account', 'close account', 'remove my data', 'erase', 'gdpr'] },

  { tab: 'data', keywords: ['data & storage', 'storage', 'files'] },
  { tab: 'data', section: 'import', sectionLabel: 'Import', keywords: ['obsidian', 'google keep', 'migrate', 'bring notes in'] },
  { tab: 'data', section: 'export', sectionLabel: 'Export', keywords: ['download all notes', 'zip'] },
  { tab: 'data', section: 'journal-export', sectionLabel: 'Journal export', keywords: ['journal', 'diary', 'pdf', 'book', 'markdown', 'download', 'zip', 'backup'] },
  { tab: 'data', section: 'encrypted-backup', sectionKey: 'settings.backupFile.title', keywords: ['encrypted backup', 'password protected', 'archive'] },
  { tab: 'data', section: 'restore-backup', sectionKey: 'settings.backupFile.restore', keywords: ['restore from encrypted backup', 'recover', 'restore'] },
  { tab: 'data', section: 'trash-retention', sectionLabel: 'Trash auto-delete', keywords: ['trash', 'retention', 'delete after'] },

  { tab: 'keys', keywords: ['api'] },
  { tab: 'keys', section: 'access-tokens', sectionLabel: 'Personal access tokens', keywords: ['token', 'api key', 'integration', 'webhook'] },

  { tab: 'sync', keywords: ['backup', 'git', 'back up to github'] },
  { tab: 'sync', section: 'git-backup', sectionKey: 'settings.git.title', keywords: ['back up to github', 'git', 'repository', 'remote', 'github', 'set up backup', 'token', 'gitlab', 'back up now', 'sync now', 'push'] },

  { tab: 'sso', adminOnly: true, keywords: ['sso', 'login'] },
  { tab: 'sso', section: 'oidc', sectionLabel: 'Single sign-on (OIDC)', adminOnly: true, keywords: ['oidc', 'oauth', 'identity provider', 'client id'] },

  { tab: 'email', adminOnly: true, keywords: ['email', 'mail', 'smtp'] },
  { tab: 'email', section: 'smtp', sectionKey: 'settings.mail.titleSmtp', adminOnly: true, keywords: ['outbound email', 'smtp', 'mail server', 'sending mail'] },
  { tab: 'email', section: 'send-a-test', sectionLabel: 'Send a test', adminOnly: true, keywords: ['test email'] },
  { tab: 'channels', adminOnly: true, keywords: ['chat notifications', 'discord', 'telegram', 'ntfy', 'chat', 'bot', 'push'] },
  { tab: 'channels', section: 'channels-ntfy', sectionLabel: 'ntfy', adminOnly: true, keywords: ['push', 'topic', 'notification server', 'self-hosted'] },
  { tab: 'channels', section: 'channels-discord', sectionLabel: 'Discord', adminOnly: true, keywords: ['webhook', 'channel', 'discord server'] },
  { tab: 'channels', section: 'channels-telegram', sectionLabel: 'Telegram', adminOnly: true, keywords: ['bot', 'botfather', 'token'] },
  { tab: 'channels', section: 'channels-hosts', sectionLabel: 'Servers on your network', adminOnly: true, keywords: ['allowed hosts', 'allow list', 'lan', 'private address', 'self-hosted', 'tailscale'] },
  { tab: 'email', section: 'invite', sectionLabel: 'Invite someone', adminOnly: true, keywords: ['invitation', 'new person', 'join'] },

  // The assistant is held back for a later release. Its entries drop out of the
  // index with it: a search hit that lands on a tab which no longer renders is a
  // worse answer than no hit at all.
  ...AI_ENTRIES,

  { tab: 'users', adminOnly: true, keywords: ['admin', 'administration', 'accounts', 'manage users', 'people'] },
  {
    tab: 'users', section: 'people', sectionLabel: 'People', adminOnly: true,
    keywords: ['create user', 'add user', 'new account', 'roles', 'make admin', 'promote', 'demote', 'disable account', 'lock account', 'suspend', 'reset password', 'recovery link'],
  },

  { tab: 'instance', adminOnly: true, keywords: ['instance backup', 'accounts', 'database', 'disaster recovery', 'papyra.db', 'passkeys', 'settings backup'] },
  { tab: 'instance', section: 'instance-backup', sectionKey: 'settings.serverBackup.title', adminOnly: true, keywords: ['instance backup', 'passphrase', 'download', 'back up now', 'encrypted', 'keys'] },
  { tab: 'instance', section: 'instance-destinations', sectionLabel: 'Where it goes', adminOnly: true, keywords: ['git', 'github', 'local copy', 'retention', 'schedule'] },
  { tab: 'instance', section: 'instance-restore', sectionKey: 'settings.serverBackup.restore', adminOnly: true, keywords: ['restore an instance backup', 'restore', 'recover', 'new server', 'migrate'] },

  { tab: 'jobs', adminOnly: true, keywords: ['background', 'housekeeping', 'maintenance', 'tasks'] },
  { tab: 'jobs', section: 'scheduled-jobs', sectionLabel: 'Housekeeping', adminOnly: true, keywords: ['empty trash', 'cleanup', 'sweep', 'run now', 'schedule', 'rebuild search', 'reindex', 'missing notes'] },
  { tab: 'logs', section: 'log-retention', sectionLabel: 'Logs', adminOnly: true, keywords: ['errors', 'log', 'warnings', 'diagnostics', 'debug', 'report a bug', 'issue', 'retention', 'activity'] },
  { tab: 'jobs', section: 'always-on-jobs', sectionLabel: 'Always running', adminOnly: true, keywords: ['watcher', 'mentions', 'webhooks', 'search index'] },

  { tab: 'about', keywords: ['version', 'licence', 'license'] },
  { tab: 'about', section: 'about-papyra', sectionLabel: 'Papyra', keywords: ['version', 'build', 'github', 'star', 'license', 'source code', 'report a bug'] },
];

/** Where a settings result navigates to. */
export function settingsHref(entry: Pick<SettingsSource, 'tab' | 'section' | 'href'>): string {
  if (entry.href) return entry.href;
  const tab = entry.tab === 'profile' ? '' : `tab=${encodeURIComponent(entry.tab)}`;
  const section = entry.section ? `s=${encodeURIComponent(entry.section)}` : '';
  const query = [tab, section].filter(Boolean).join('&');
  return query ? `/settings?${query}` : '/settings';
}

/**
 * Ranked settings matches. Lower rank sorts first:
 * 0 the heading starts with the query, 1 it contains it, 2 only a keyword does.
 */
export function searchSettings(query: string, isAdmin: boolean, journalOn = true): Array<SettingsEntry & { rank: number }> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const matches: Array<SettingsEntry & { rank: number }> = [];
  for (const source of SETTINGS_INDEX) {
    if (source.adminOnly && !isAdmin) continue;
    if (source.journalOnly && !journalOn) continue;
    const entry = resolve(source);
    const label = (entry.sectionLabel ?? entry.tabLabel).toLowerCase();
    const tabLabel = entry.tabLabel.toLowerCase();
    let rank: number;
    if (label.startsWith(q) || tabLabel.startsWith(q)) rank = 0;
    else if (label.includes(q) || tabLabel.includes(q)) rank = 1;
    else if (entry.keywords?.some(k => k.includes(q))) rank = 2;
    else continue;
    matches.push({ ...entry, rank });
  }
  return matches.sort((a, b) => a.rank - b.rank);
}

function resolve(source: SettingsSource): SettingsEntry {
  return {
    ...source,
    tabLabel: t(`settings.nav.${source.tab}`),
    sectionLabel: source.sectionKey ? t(source.sectionKey) : source.sectionLabel,
    area: areaOf(source.tab),
  };
}
