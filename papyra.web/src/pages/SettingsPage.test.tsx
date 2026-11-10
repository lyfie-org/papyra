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

function open(url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
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

describe('Settings areas', () => {
  it('opens an administrator on Your settings, with a switch and no sign of the server area’s note', () => {
    open('/settings?tab=about');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings');
    const group = screen.getByRole('group', { name: 'Settings area' });
    expect(within(group).getByRole('button', { name: 'Your settings' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(group).getByRole('button', { name: 'Server settings' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('Changes here apply to everyone on this server.')).toBeNull();
  });

  it('shows only your own pages while in Your settings, under their new names', () => {
    open('/settings?tab=about');
    expect(railNames('Your settings')).toEqual([
      'Profile', 'Appearance', 'Journal', 'Notifications', 'Security', 'Your data', 'API Keys', 'Git backup', 'About',
    ]);
  });

  it('switches to Server settings: its own title, the line that says who it affects, and only server pages', () => {
    open('/settings?tab=about');
    fireEvent.click(screen.getByRole('button', { name: 'Server settings' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Server settings');
    expect(screen.getByText('Changes here apply to everyone on this server.')).toBeTruthy();
    expect(railNames('Server settings')).toEqual([
      'Users', 'Single sign-on', 'Email delivery', 'Chat services', 'Server backup', 'Jobs', 'Logs',
    ]);
    expect(screen.getByText('panel:users')).toBeTruthy();                 // landed on its first page
    expect(where()).toBe('/settings?tab=users');
    expect(document.querySelector('.settings--server')).not.toBeNull();
  });

  it('goes back to the page you had open when you return to an area', () => {
    open('/settings?tab=about');
    fireEvent.click(screen.getByRole('button', { name: 'Server settings' }));
    fireEvent.click(within(rail('Server settings')).getByRole('button', { name: 'Chat services' }));
    expect(screen.getByText('panel:channels')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Your settings' }));
    expect(screen.getByText('panel:about')).toBeTruthy();
    expect(where()).toBe('/settings?tab=about');
    fireEvent.click(screen.getByRole('button', { name: 'Server settings' }));
    expect(screen.getByText('panel:channels')).toBeTruthy();
  });

  it('opens straight into Server settings from an old link, as ?tab= always did', () => {
    open('/settings?tab=instance');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Server settings');
    expect(within(screen.getByRole('group', { name: 'Settings area' })).getByRole('button', { name: 'Server settings' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('panel:instance')).toBeTruthy();
    expect(within(rail('Server settings')).getByRole('button', { name: 'Server backup' }).getAttribute('aria-current')).toBe('true');
  });

  it('does not change the pressed state when the current area is chosen again', () => {
    open('/settings?tab=logs');
    fireEvent.click(screen.getByRole('button', { name: 'Server settings' }));
    expect(where()).toBe('/settings?tab=logs');
  });

  it('shows everyone else nothing new: no switch, no note, no server pages, even by address', () => {
    auth.role = 'User';
    open('/settings?tab=users');                                        // an admin-only tab, typed in
    expect(screen.queryByRole('group', { name: 'Settings area' })).toBeNull();
    expect(screen.queryByText(/everyone on this server/)).toBeNull();
    expect(screen.queryByText(/Server settings/)).toBeNull();
    expect(screen.queryByText('panel:users')).toBeNull();
    expect(document.querySelector('.settings__title')!.textContent).toBe('Settings');   // (the Profile page has its own h1)
    expect(railNames('Your settings')).not.toContain('Users');
    expect(railNames('Your settings')).toContain('Git backup');
  });

  it('keeps an ordinary person on their own pages when they ask for one directly', () => {
    auth.role = 'User';
    open('/settings?tab=about');
    expect(screen.getByText('panel:about')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Settings area' })).toBeNull();
  });
});
