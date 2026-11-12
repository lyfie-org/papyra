/**
 * Settings has two areas, shown one at a time.
 *
 * - **Personal**: what changes things for you. Everyone has it.
 * - **Administration**: what changes things for everyone on this server. Administrators only.
 *
 * The area is *derived from the tab*, so `?tab=users` has always meant "administration" and every link already
 * in the app, in emails and in the docs keeps working: nothing in the address says which area, and nothing needs a
 * redirect. Which tabs belong where is decided here and nowhere else.
 */

export const YOUR_TABS = ['profile', 'appearance', 'journal', 'notifications', 'security', 'data', 'keys', 'sync', 'about'] as const;
export const SERVER_TABS = ['users', 'sso', 'email', 'channels', 'instance', 'ai', 'jobs', 'logs'] as const;

export type YourTab = (typeof YOUR_TABS)[number];
export type ServerTab = (typeof SERVER_TABS)[number];
export type Tab = YourTab | ServerTab;
export type Area = 'you' | 'server';

/** Where a person lands when they switch to an area they haven't visited yet. */
export const DEFAULT_TAB: Record<Area, Tab> = { you: 'profile', server: 'users' };

const SERVER = new Set<string>(SERVER_TABS);
const ALL = new Set<string>([...YOUR_TABS, ...SERVER_TABS]);

/** The area a tab belongs to. An unknown tab is nobody's: it falls back to the person's own settings. */
export function areaOf(tab: string | null | undefined): Area {
  return tab && SERVER.has(tab) ? 'server' : 'you';
}

export function isTab(value: string | null | undefined): value is Tab {
  return !!value && ALL.has(value);
}
