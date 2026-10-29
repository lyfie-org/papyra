// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installDemoBackend } from './backend';
import { resetState } from './store';
import { addDays, todayIn } from '../lib/journalDay';
import type { JournalEntry, JournalRange, JournalStats, JournalSummary, JournalToday } from '../types/journal';

// Node's Request wants an absolute URL; the app's own relative ones are resolved the way a browser would.
const api = (path: string, init?: RequestInit) => fetch(new URL(path, window.location.origin).href, init);
const get = async <T,>(url: string, init?: RequestInit): Promise<T> => (await api(url, init)).json() as Promise<T>;
const put = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  api(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

const now = () => todayIn(new Date(), undefined, 0);

beforeAll(() => installDemoBackend());
beforeEach(() => resetState());

describe('the demo journal', () => {
  it('lands a visitor on today, with a streak and a month of moods already behind it', async () => {
    const today = await get<JournalToday>('/api/journal/today');
    expect(today.date).toBe(now());
    expect(today.entry.exists).toBe(false); // today is theirs to begin
    expect(today.stats.current).toBeGreaterThanOrEqual(6); // the last six days are written
    expect(today.settings.promptsOn).toBe(true);

    const month = await get<JournalRange>(`/api/journal?from=${addDays(now(), -30)}&to=${now()}`);
    expect(month.entries.filter((e) => e.mood !== null).length).toBeGreaterThan(10);
  });

  it('keeps a locked day’s words back until the vault is opened', async () => {
    const day = addDays(now(), -5);
    const closed = await get<JournalEntry>(`/api/journal/${day}`);
    expect(closed.locked).toBe(true);
    expect(closed.body).toBe('');
    expect(closed.words).toBeGreaterThan(0); // its size is still known
    const open = await get<JournalEntry>(`/api/journal/${day}`, { headers: { 'X-Unlock-Token': 'demo' } });
    expect(open.body).toMatch(/locked day/);
  });

  it('writes a day on first words, never before, and counts it toward today’s streak', async () => {
    const before = await get<JournalStats>('/api/journal/stats');
    expect(before.todayWritten).toBe(false);
    expect((await put(`/api/journal/${now()}`, { body: '   ' })).status).toBe(200);
    expect((await get<JournalEntry>(`/api/journal/${now()}`)).exists).toBe(false);

    const saved = await put(`/api/journal/${now()}`, { body: 'First words of the day.', mood: 5 });
    expect(saved.headers.get('ETag')).toBeTruthy();
    const after = await get<JournalStats>('/api/journal/stats');
    expect(after.todayWritten).toBe(true);
    expect(after.current).toBe(before.current + 1);
  });

  it('refuses a day that has not begun, and a day in the Trash', async () => {
    const tomorrow = addDays(now(), 1);
    expect((await put(`/api/journal/${tomorrow}`, { body: 'too soon' })).status).toBe(422);
    const trashed = addDays(now(), -13);
    expect((await put(`/api/journal/${trashed}`, { body: 'hello' })).status).toBe(409);
  });

  it('lists what is archived and trashed, and restoring them takes them off the lists', async () => {
    const archived = await get<{ entries: JournalSummary[] }>('/api/journal/bin?state=archived');
    const trashed = await get<{ entries: JournalSummary[] }>('/api/journal/bin?state=trashed');
    expect(archived.entries).toHaveLength(1);
    expect(trashed.entries).toHaveLength(1);
    expect(trashed.entries[0].trashedAt).toBeTruthy();

    await api(`/api/notes/journal-${trashed.entries[0].date}/untrash`, { method: 'POST' });
    await put(`/api/journal/${archived.entries[0].date}`, { archived: false });
    expect((await get<{ entries: unknown[] }>('/api/journal/bin?state=trashed')).entries).toHaveLength(0);
    expect((await get<{ entries: unknown[] }>('/api/journal/bin?state=archived')).entries).toHaveLength(0);
  });

  it('lists the locked days for the Vault, never in the Trash', async () => {
    const locked = await get<{ state: string; entries: JournalSummary[] }>('/api/journal/bin?state=locked');
    expect(locked.state).toBe('locked');
    expect(locked.entries.length).toBeGreaterThan(0);
    expect(locked.entries.every((e) => e.locked && !e.trashed)).toBe(true);
  });

  it('keeps templates and a default, and lets go of the default when it is removed', async () => {
    expect((await get<{ templates: { name: string }[] }>('/api/journal/templates')).templates.map((t) => t.name)).toEqual(['Evening review']);
    await put('/api/journal/templates/Morning', { body: '## {{date}}' });
    await put('/api/journal/settings', { defaultTemplate: 'Morning' });
    expect((await get<{ defaultTemplate: string | null }>('/api/journal/templates')).defaultTemplate).toBe('Morning');
    await api('/api/journal/templates/Morning', { method: 'DELETE' });
    expect((await get<{ defaultTemplate: string | null }>('/api/journal/templates')).defaultTemplate).toBeNull();
    expect((await put('/api/journal/templates/..%2Fbad', { body: 'x' })).status).toBe(422);
  });

  it('shows earlier years on this day, and finds days by their words', async () => {
    const { entries } = await get<{ entries: JournalSummary[] }>(`/api/journal/on-this-day?date=${now()}`);
    expect(entries.length).toBeGreaterThan(0);
    const hits = await get<{ id: string; kind?: string }[]>('/api/search?q=river');
    expect(hits.some((h) => h.kind === 'journal' && h.id.startsWith('journal-'))).toBe(true);
  });

  it('locks every open day on request', async () => {
    const { locked } = await get<{ locked: number }>('/api/journal/lock-all', { method: 'POST' });
    expect(locked).toBeGreaterThan(5);
    expect((await get<{ locked: number }>('/api/journal/lock-all', { method: 'POST' })).locked).toBe(0);
  });
});
