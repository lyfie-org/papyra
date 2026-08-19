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

export interface SettingsEntry {
  /** `?tab=` value. */
  tab: string;
  /** Rail label, shown as the first breadcrumb after "Settings". */
  tabLabel: string;
  /** Heading id within the tab; omitted for an entry that means the whole tab. */
  section?: string;
  /** The heading's visible text, shown as the last breadcrumb. */
  sectionLabel?: string;
  adminOnly?: boolean;
  /** Set when the entry is a page of its own rather than a tab under Settings. */
  href?: string;
  /**
   * Words a person might type instead of the heading. Never rendered — only
   * matched — so "smtp" can find a page whose visible name says "email".
   */
  keywords?: string[];
}

export const SETTINGS_INDEX: SettingsEntry[] = [
  { tab: 'profile', tabLabel: 'Profile', keywords: ['account', 'avatar', 'profile picture', 'name', 'email'] },
  { tab: 'profile', tabLabel: 'Profile', section: 'account', sectionLabel: 'Account', keywords: ['display name', 'email address'] },
  { tab: 'profile', tabLabel: 'Profile', section: 'change-password', sectionLabel: 'Change password', keywords: ['password', 'new password'] },
  {
    tab: 'profile', tabLabel: 'Profile', section: 'activity', sectionLabel: 'Your writing, day by day',
    keywords: ['heatmap', 'activity', 'streak', 'history', 'stats', 'calendar'],
  },

  { tab: 'appearance', tabLabel: 'Appearance', keywords: ['look', 'colours', 'colors'] },
  { tab: 'appearance', tabLabel: 'Appearance', section: 'theme', sectionLabel: 'Theme', keywords: ['dark mode', 'light mode', 'night'] },

  { tab: 'notifications', tabLabel: 'Notifications', keywords: ['alerts'] },
  { tab: 'notifications', tabLabel: 'Notifications', section: 'email-notifications', sectionLabel: 'Email notifications', keywords: ['mentions', 'shares', 'digest'] },

  { tab: 'security', tabLabel: 'Security', keywords: ['privacy', 'lock'] },
  { tab: 'security', tabLabel: 'Security', section: 'biometric-unlock', sectionLabel: 'Biometric unlock', keywords: ['passkey', 'fingerprint', 'face', 'vault', 'webauthn', 'device'] },

  { tab: 'data', tabLabel: 'Data & Storage', keywords: ['storage', 'files'] },
  { tab: 'data', tabLabel: 'Data & Storage', section: 'import', sectionLabel: 'Import', keywords: ['obsidian', 'google keep', 'migrate', 'bring notes in'] },
  { tab: 'data', tabLabel: 'Data & Storage', section: 'export', sectionLabel: 'Export', keywords: ['download all notes', 'zip'] },
  { tab: 'data', tabLabel: 'Data & Storage', section: 'encrypted-backup', sectionLabel: 'Encrypted backup', keywords: ['password protected', 'archive'] },
  { tab: 'data', tabLabel: 'Data & Storage', section: 'restore-backup', sectionLabel: 'Restore from encrypted backup', keywords: ['recover', 'restore'] },
  { tab: 'data', tabLabel: 'Data & Storage', section: 'maintenance', sectionLabel: 'Maintenance', keywords: ['rebuild search', 'reindex', 'missing notes'] },
  { tab: 'data', tabLabel: 'Data & Storage', section: 'trash-retention', sectionLabel: 'Trash auto-delete', keywords: ['trash', 'retention', 'delete after'] },

  { tab: 'keys', tabLabel: 'API Keys', keywords: ['api'] },
  { tab: 'keys', tabLabel: 'API Keys', section: 'access-tokens', sectionLabel: 'Personal access tokens', keywords: ['token', 'api key', 'integration', 'webhook'] },

  { tab: 'sync', tabLabel: 'Backup', keywords: ['git', 'backup'] },
  { tab: 'sync', tabLabel: 'Backup', section: 'git-backup', sectionLabel: 'Back up to a git repository', keywords: ['git', 'repository', 'remote', 'github', 'ssh key'] },
  { tab: 'sync', tabLabel: 'Backup', section: 'run-a-sync', sectionLabel: 'Run a sync', keywords: ['push', 'pull', 'sync now'] },

  { tab: 'sso', tabLabel: 'SSO', adminOnly: true, keywords: ['single sign-on', 'login'] },
  { tab: 'sso', tabLabel: 'SSO', section: 'oidc', sectionLabel: 'Single sign-on (OIDC)', adminOnly: true, keywords: ['oidc', 'oauth', 'identity provider', 'client id'] },

  { tab: 'email', tabLabel: 'Email', adminOnly: true, keywords: ['mail'] },
  { tab: 'email', tabLabel: 'Email', section: 'smtp', sectionLabel: 'Outbound email (SMTP)', adminOnly: true, keywords: ['smtp', 'mail server', 'sending mail'] },
  { tab: 'email', tabLabel: 'Email', section: 'send-a-test', sectionLabel: 'Send a test', adminOnly: true, keywords: ['test email'] },
  { tab: 'email', tabLabel: 'Email', section: 'invite', sectionLabel: 'Invite someone', adminOnly: true, keywords: ['invitation', 'new person', 'join'] },

  { tab: 'ai', tabLabel: 'AI', adminOnly: true, keywords: ['assistant', 'chat'] },
  { tab: 'ai', tabLabel: 'AI', section: 'assistant', sectionLabel: 'Assistant', adminOnly: true, keywords: ['chat', 'answers', 'semantic search'] },
  { tab: 'ai', tabLabel: 'AI', section: 'local-models', sectionLabel: 'On this machine', adminOnly: true, keywords: ['local', 'offline', 'ollama', 'download model', 'install'] },
  { tab: 'ai', tabLabel: 'AI', section: 'hosted-models', sectionLabel: 'Or use a paid service', adminOnly: true, keywords: ['openai', 'anthropic', 'api key', 'hosted'] },

  // Managing people moved out of Settings to its own page, so its entries carry
  // an href rather than a tab. They stay in this index because a person looking
  // for "add a user" types it into the same box either way.
  {
    tab: 'admin', tabLabel: 'Manage Users', href: '/admin', adminOnly: true,
    keywords: ['admin', 'administration', 'accounts', 'people', 'create user', 'add user', 'new account', 'roles', 'reset password', 'recovery link'],
  },

  { tab: 'about', tabLabel: 'About', keywords: ['version', 'licence', 'license'] },
  { tab: 'about', tabLabel: 'About', section: 'about-papyra', sectionLabel: 'Papyra', keywords: ['version', 'build'] },
];

/** Where a settings result navigates to. */
export function settingsHref(entry: SettingsEntry): string {
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
export function searchSettings(query: string, isAdmin: boolean): Array<SettingsEntry & { rank: number }> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const matches: Array<SettingsEntry & { rank: number }> = [];
  for (const entry of SETTINGS_INDEX) {
    if (entry.adminOnly && !isAdmin) continue;
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
