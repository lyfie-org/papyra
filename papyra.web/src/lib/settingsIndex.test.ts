import { describe, it, expect } from 'vitest';
// The page's own source is the fixture: these tests assert the index still
// describes what SettingsPage actually renders.
import settingsPage from '../pages/SettingsPage.tsx?raw';
import aboutPanel from '../components/AboutPanel.tsx?raw';
import logsPanel from '../components/LogsPanel.tsx?raw';
import instanceBackup from '../components/InstanceBackupPanel.tsx?raw';
import deleteAccount from '../components/DeleteAccountSection.tsx?raw';
import authenticator from '../components/AuthenticatorSection.tsx?raw';
import sessions from '../components/SessionsSection.tsx?raw';
import usersPanel from '../pages/ManageUsersPage.tsx?raw';
import account from '../components/AccountDetails.tsx?raw';
import sso from '../components/SsoGuide.tsx?raw';
import journalSettings from '../components/journal/JournalSettingsPanel.tsx?raw';
import journalTemplates from '../components/journal/JournalTemplatesGroup.tsx?raw';
import channelCards from '../components/ChannelCards.tsx?raw';
import channelsAdmin from '../components/ChannelsAdminPanel.tsx?raw';
import { SETTINGS_INDEX, searchSettings, settingsHref } from './settingsIndex';
import { areaOf, SERVER_TABS, YOUR_TABS } from './settingsAreas';

describe('settingsIndex', () => {
  // The index is hand-written, so it can drift from the page it describes.
  // These two tests are the thing that notices.
  it('points every entry at a tab the page actually renders', () => {
    const tabs = new Set(
      [...settingsPage.matchAll(/\{ id: '([a-z]+)', label:/g)].map(m => m[1]),
    );
    expect(tabs.size).toBeGreaterThan(0);
    // An entry with its own href is a page, not a tab — Manage Users left
    // Settings, and this test would otherwise demand it come back.
    for (const entry of SETTINGS_INDEX) {
      if (!entry.href) expect(tabs).toContain(entry.tab);
    }
  });

  it('sends the users entry to Settings → Users', () => {
    const [entry] = searchSettings('add user', true);
    expect(entry.tabLabel).toBe('Users');
    expect(settingsHref(entry)).toBe('/settings?tab=users&s=people');
  });

  it('keeps Users out of a non-admin search', () => {
    expect(searchSettings('manage users', false)).toEqual([]);
    expect(searchSettings('disable account', false)).toEqual([]);
    expect(searchSettings('manage users', true).length).toBeGreaterThan(0);
  });

  it('points every section at a heading id that exists', () => {
    // A heading, or a SettingGroup / SettingRow carrying the section's id.
    const anchors = (src: string) => [
      ...[...src.matchAll(/id="([a-z-]+)" className="settings__subhead"/g)].map(m => m[1]),
      ...[...src.matchAll(/<Setting(?:Group|Row)[^>]*?id="([a-z-]+)"/gs)].map(m => m[1]),
    ];
    const ids = new Set([
      ...anchors(settingsPage), ...anchors(logsPanel), ...anchors(instanceBackup), ...anchors(account), ...anchors(sso), ...anchors(authenticator), ...anchors(sessions), ...anchors(journalSettings), ...anchors(journalTemplates), ...anchors(channelCards), ...anchors(channelsAdmin),
      // The About tab is its own component.
      ...[...aboutPanel.matchAll(/<h2 id="([a-z-]+)"/g)].map(m => m[1]),
      ...[...deleteAccount.matchAll(/<h2 id="([a-z-]+)"/g)].map(m => m[1]),
      ...[...authenticator.matchAll(/<h2 id="([a-z-]+)"/g)].map(m => m[1]),
      ...[...sessions.matchAll(/<h2 id="([a-z-]+)"/g)].map(m => m[1]),
      ...[...usersPanel.matchAll(/<h2 id="([a-z-]+)"/g)].map(m => m[1]),
    ]);
    for (const entry of SETTINGS_INDEX) {
      if (entry.section) expect(ids).toContain(entry.section);
    }
  });

  it('marks an entry admin-only whenever its tab is', () => {
    const adminTabs = new Set(
      SETTINGS_INDEX.filter(e => e.adminOnly).map(e => e.tab),
    );
    for (const entry of SETTINGS_INDEX) {
      if (adminTabs.has(entry.tab)) expect(entry.adminOnly).toBe(true);
    }
  });

  it('hides admin pages from someone who is not an admin', () => {
    const asUser = searchSettings('users', false);
    expect(asUser.some(e => e.tab === 'users')).toBe(false);
    const asAdmin = searchSettings('users', true);
    expect(asAdmin.some(e => e.tab === 'users')).toBe(true);
  });

  it('ranks a heading match above a keyword-only match', () => {
    const hits = searchSettings('theme', false);
    expect(hits[0].sectionLabel).toBe('Theme');
    expect(hits[0].rank).toBe(0);
  });

  it('finds a page by what a person would call it', () => {
    const dark = searchSettings('dark mode', false);
    expect(dark.map(h => h.sectionLabel)).toContain('Theme');

    const passkey = searchSettings('passkey', false);
    expect(passkey.map(h => h.sectionLabel)).toContain('Passkeys');

    const smtp = searchSettings('smtp', true);
    expect(smtp.map(h => h.sectionLabel)).toContain('Mail server (SMTP)');
  });

  it('offers the journal switch always, and the rest of its settings only while the journal is on', () => {
    expect(searchSettings('turn off', false).map(h => h.sectionLabel)).toContain('Use the journal');
    expect(searchSettings('turn off', false, false).map(h => h.sectionLabel)).toContain('Use the journal');

    expect(searchSettings('day starts', false).map(h => h.sectionLabel)).toContain('The day');
    expect(searchSettings('day starts', false, false)).toEqual([]);
    expect(searchSettings('reminder', false, false).map(h => h.sectionLabel)).not.toContain('Reminder');
    // The journal's export lives under Data and stays findable.
    expect(searchSettings('journal export', false, false).map(h => h.sectionLabel)).toContain('Journal export');
  });

  it('returns nothing for an empty query', () => {
    expect(searchSettings('   ', true)).toEqual([]);
  });

  it('builds hrefs the page can read back', () => {
    expect(settingsHref({ tab: 'profile' })).toBe('/settings');
    expect(settingsHref({ tab: 'ai', section: 'local-models' }))
      .toBe('/settings?tab=ai&s=local-models');
    expect(settingsHref({ tab: 'profile', section: 'change-password' }))
      .toBe('/settings?s=change-password');
  });
});

describe('settings areas', () => {
  it('puts every tab in exactly one area, and every rail item in the page in one of them', () => {
    const inRail = [...settingsPage.matchAll(/\{ id: '([a-z]+)', label: 'settings\.nav\./g)].map(m => m[1]);
    expect(new Set([...YOUR_TABS, ...SERVER_TABS]).size).toBe(YOUR_TABS.length + SERVER_TABS.length);
    expect(inRail.sort()).toEqual([...YOUR_TABS, ...SERVER_TABS].sort());
  });

  it('marks an index entry admin-only exactly when its tab is in Server settings', () => {
    for (const entry of SETTINGS_INDEX) {
      if (entry.href) continue;
      expect(!!entry.adminOnly, `${entry.tab}/${entry.section ?? ''}`).toBe(areaOf(entry.tab) === 'server');
    }
  });

  it('tells a result which area it is in, so the breadcrumb can say so', () => {
    const smtp = searchSettings('smtp', true).find(e => e.section === 'smtp')!;
    expect(smtp.area).toBe('server');
    expect(smtp.tabLabel).toBe('Email delivery');
    expect(smtp.sectionLabel).toBe('Mail server (SMTP)');
    const theme = searchSettings('dark mode', true)[0];
    expect(theme.area).toBe('you');
  });

  it('finds a renamed page by its old name too', () => {
    const find = (q: string, tab: string) => searchSettings(q, true).some(e => e.tab === tab);
    expect(find('instance backup', 'instance')).toBe(true);
    expect(find('chat notifications', 'channels')).toBe(true);
    expect(find('data & storage', 'data')).toBe(true);
    expect(find('outbound email', 'email')).toBe(true);
    expect(find('encrypted backup', 'data')).toBe(true);
    expect(find('back up to github', 'sync')).toBe(true);
  });

  it('shows the new names', () => {
    const label = (q: string, tab: string, section?: string) => {
      const hit = searchSettings(q, true).find(e => e.tab === tab && e.section === section)!;
      return section ? hit.sectionLabel : hit.tabLabel;
    };
    expect(label('your data', 'data')).toBe('Your data');
    expect(label('git backup', 'sync')).toBe('Git backup');
    expect(label('server backup', 'instance')).toBe('Server backup');
    expect(label('chat services', 'channels')).toBe('Chat services');
    expect(label('backup file', 'data', 'encrypted-backup')).toBe('Backup file');
  });
});
