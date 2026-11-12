// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import SettingsPage from './SettingsPage';

// The two areas of Settings. The panels themselves are not what is under test, so each is a stand-in that says its name.
const auth = vi.hoisted(() => ({ role: 'Admin' }));
const panel = vi.hoisted(() => (name: string) => ({ default: () => <p>{`panel:${name}`}</p> }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 1, role: auth.role, name: 'Ada', username: 'ada' } }) }));
vi.mock('../hooks/useNotes', () => ({ useNotes: () => ({ data: [] }) }));
vi.mock('../components/AboutPanel', () => panel('about'));
vi.mock('../components/AccountDetails', () => panel('account'));
vi.mock('../components/KnowledgeHeatmap', () => panel('heatmap'));
vi.mock('../components/DayNotesOverlay', () => panel('day'));
vi.mock('../components/ChannelsAdminPanel', () => panel('channels'));
vi.mock('../components/InstanceBackupPanel', () => panel('instance'));
vi.mock('../components/LogsPanel', () => panel('logs'));
vi.mock('./ManageUsersPage', () => panel('users'));

function Where() { const l = useLocation(); return <output data-testid="where">{l.pathname}{l.search}</output>; }

function open(url: string, routes: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal('fetch', vi.fn(async (path: string) =>
    new Response(JSON.stringify(routes[path] ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  return render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}><SettingsPage /><Where /></QueryClientProvider>
    </MemoryRouter>,
  );
}

const rail = (name: string) => screen.getByRole('navigation', { name });
const railNames = (name: string) => within(rail(name)).getAllByRole('button').map(b => b.textContent!.trim());
const where = () => screen.getByTestId('where').textContent;

beforeEach(() => { auth.role = 'Admin'; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Settings page arrows', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows arrows on a row too narrow for its pages; they scroll without opening a page', () => {
    // jsdom has no layout, so the row's widths are set by hand.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(900);
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
    open('/settings?tab=profile');
    expect(screen.queryByRole('button', { name: 'Show earlier settings pages' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show more settings pages' }));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ left: 225 }));
    expect(where()).toBe('/settings?tab=profile');
  });

  it('shows none when the pages fit', () => {
    open('/settings?tab=profile');
    expect(screen.queryByRole('button', { name: 'Show more settings pages' })).toBeNull();
  });
});

describe('Settings areas', () => {
  const tabs = () => screen.getByRole('tablist', { name: 'Settings area' });
  const tab = (name: string) => within(tabs()).getByRole('tab', { name });

  it('opens an administrator on Personal, with two tabs and no sign of the administration note', () => {
    open('/settings?tab=about');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings');
    expect(tab('Personal').getAttribute('aria-selected')).toBe('true');
    expect(tab('Administration').getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByText('Changes here apply to everyone on this server.')).toBeNull();
  });

  it('holds the pages of the chosen area in the tab’s own panel', () => {
    open('/settings?tab=about');
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tab('Personal').id);
    expect(tab('Personal').getAttribute('aria-controls')).toBe(panel.id);
    expect(within(panel).getByRole('navigation', { name: 'Personal' })).toBeTruthy();
  });

  it('shows only your own pages while in Personal, under their new names', () => {
    open('/settings?tab=about');
    expect(railNames('Personal')).toEqual([
      'Profile', 'Appearance', 'Journal', 'Notifications', 'Security', 'Your data', 'API Keys', 'Git backup', 'About',
    ]);
  });

  it('switches to Administration: the line that says who it affects, and only server pages', () => {
    open('/settings?tab=about');
    fireEvent.click(tab('Administration'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings');
    expect(tab('Administration').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Changes here apply to everyone on this server.')).toBeTruthy();
    expect(railNames('Administration')).toEqual([
      'Users', 'Single sign-on', 'Email', 'Notifications', 'Server backup', 'Jobs', 'Logs',
    ]);
    expect(screen.getByText('panel:users')).toBeTruthy();                 // landed on its first page
    expect(where()).toBe('/settings?tab=users');
    expect(document.querySelector('.settings--server')).not.toBeNull();
  });

  it('moves between the tabs with the arrow keys, Home and End, and focus goes with the choice', () => {
    open('/settings?tab=about');
    tab('Personal').focus();
    fireEvent.keyDown(tabs(), { key: 'ArrowRight' });
    expect(where()).toBe('/settings?tab=users');
    expect(document.activeElement).toBe(tab('Administration'));
    expect(tab('Administration').tabIndex).toBe(0);
    expect(tab('Personal').tabIndex).toBe(-1);
    fireEvent.keyDown(tabs(), { key: 'Home' });
    expect(where()).toBe('/settings?tab=about');
    expect(document.activeElement).toBe(tab('Personal'));
    fireEvent.keyDown(tabs(), { key: 'End' });
    expect(tab('Administration').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tabs(), { key: 'ArrowRight' });                    // wraps round to the first
    expect(tab('Personal').getAttribute('aria-selected')).toBe('true');
  });

  it('goes back to the page you had open when you return to an area', () => {
    open('/settings?tab=about');
    fireEvent.click(tab('Administration'));
    fireEvent.click(within(rail('Administration')).getByRole('button', { name: 'Notifications' }));
    expect(screen.getByText('panel:channels')).toBeTruthy();
    fireEvent.click(tab('Personal'));
    expect(screen.getByText('panel:about')).toBeTruthy();
    expect(where()).toBe('/settings?tab=about');
    fireEvent.click(tab('Administration'));
    expect(screen.getByText('panel:channels')).toBeTruthy();
  });

  it('opens straight into Administration from an old link, as ?tab= always did', () => {
    open('/settings?tab=instance');
    expect(tab('Administration').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('panel:instance')).toBeTruthy();
    expect(within(rail('Administration')).getByRole('button', { name: 'Server backup' }).getAttribute('aria-current')).toBe('true');
  });

  it('does not change the address when the current area is chosen again', () => {
    open('/settings?tab=logs');
    fireEvent.click(tab('Administration'));
    expect(where()).toBe('/settings?tab=logs');
  });

  it('shows everyone else nothing new: no tabs, no note, no server pages, even by address', () => {
    auth.role = 'User';
    open('/settings?tab=users');                                        // an admin-only tab, typed in
    expect(screen.queryByRole('tablist', { name: 'Settings area' })).toBeNull();
    expect(screen.queryByText(/everyone on this server/)).toBeNull();
    expect(screen.queryByText(/Administration/)).toBeNull();
    expect(screen.queryByText('panel:users')).toBeNull();
    expect(document.querySelector('.settings__title')!.textContent).toBe('Settings');   // (the Profile page has its own h1)
    expect(railNames('Personal')).not.toContain('Users');
    expect(railNames('Personal')).toContain('Git backup');
  });

  it('keeps an ordinary person on their own pages when they ask for one directly', () => {
    auth.role = 'User';
    open('/settings?tab=about');
    expect(screen.getByText('panel:about')).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Settings area' })).toBeNull();
  });
});

// What the Git backup screen says about locked notes has to be what the server does (BackupLayout: a readable backup
// keeps locked notes encrypted; an encrypted one encrypts everything). It used to say "locked notes included" as plain text.
describe('Git backup: what it says about your notes', () => {
  const git = (mode: 'plain' | 'encrypted') => ({
    '/api/git': { remoteUrl: 'https://github.com/me/notes.git', branch: 'main', hasToken: true, conflict: false, lastSyncUtc: null, lastError: null, mode },
  });

  it('says a readable backup is plain Markdown but keeps locked notes locked', async () => {
    auth.role = 'User';
    open('/settings?tab=sync', git('plain'));
    expect(await screen.findByText('Anyone who can read the repository can read your notes.')).toBeTruthy();
    expect(screen.getByText('They are saved as plain Markdown files. Locked notes stay locked. Keep the repository private, or switch on encryption above.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('locked notes included');
  });

  it('says an encrypted backup seals everything', async () => {
    auth.role = 'User';
    open('/settings?tab=sync', git('encrypted'));
    expect(await screen.findByText('Your backup is encrypted.')).toBeTruthy();
    expect(screen.queryByText('Anyone who can read the repository can read your notes.')).toBeNull();
  });
});

