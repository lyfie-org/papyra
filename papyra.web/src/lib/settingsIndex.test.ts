import { describe, it, expect } from 'vitest';
// The page's own source is the fixture: these tests assert the index still
// describes what SettingsPage actually renders.
import settingsPage from '../pages/SettingsPage.tsx?raw';
import { SETTINGS_INDEX, searchSettings, settingsHref } from './settingsIndex';

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

  it('sends the Manage Users entry to its own page', () => {
    const [entry] = searchSettings('add user', true);
    expect(entry.tabLabel).toBe('Manage Users');
    expect(settingsHref(entry)).toBe('/admin');
  });

  it('keeps Manage Users out of a non-admin search', () => {
    expect(searchSettings('manage users', false)).toEqual([]);
    expect(searchSettings('manage users', true).length).toBeGreaterThan(0);
  });

  it('points every section at a heading id that exists', () => {
    const ids = new Set(
      [...settingsPage.matchAll(/id="([a-z-]+)" className="settings__subhead"/g)].map(m => m[1]),
    );
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
    expect(asUser.some(e => e.tab === 'admin')).toBe(false);
    const asAdmin = searchSettings('users', true);
    expect(asAdmin.some(e => e.tab === 'admin')).toBe(true);
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
    expect(passkey.map(h => h.sectionLabel)).toContain('Biometric unlock');

    const smtp = searchSettings('smtp', true);
    expect(smtp.map(h => h.sectionLabel)).toContain('Outbound email (SMTP)');
  });

  it('returns nothing for an empty query', () => {
    expect(searchSettings('   ', true)).toEqual([]);
  });

  it('builds hrefs the page can read back', () => {
    expect(settingsHref({ tab: 'profile', tabLabel: 'Profile' })).toBe('/settings');
    expect(settingsHref({ tab: 'ai', tabLabel: 'AI', section: 'local-models' }))
      .toBe('/settings?tab=ai&s=local-models');
    expect(settingsHref({ tab: 'profile', tabLabel: 'Profile', section: 'change-password' }))
      .toBe('/settings?s=change-password');
  });
});
