import { describe, it, expect } from 'vitest';
import {
  GROUP_ORDER, tagResults, collectionResults, dayJumpResults, noteResult, orderResults, settingsResults,
  type SearchResult,
} from './searchRegistry';

const hit = (id: string, title: string) => ({ id, title, snippet: 'body', secure: false });

describe('searchRegistry', () => {
  it('labels a note, a to-do and the inbox differently', () => {
    expect(noteResult(hit('a', 'Info'), 'note', 0).breadcrumb).toEqual(['Note']);
    expect(noteResult(hit('b', 'Shopping list'), 'todo', 0).breadcrumb).toEqual(['To Do']);
    expect(noteResult(hit('c', 'Inbox'), 'inbox', 0).breadcrumb).toEqual(['Inbox']);
  });

  it('says where a note lives when it is not on the Notes desk', () => {
    const on = (kind: 'note' | 'todo', state: { archived?: boolean; trashed?: boolean; secure?: boolean }) =>
      noteResult(hit('a', 'Info'), kind, 0, { archived: false, trashed: false, secure: false, ...state });
    expect(on('note', { archived: true }).breadcrumb).toEqual(['Archive', 'Note']);
    expect(on('todo', { archived: true }).breadcrumb).toEqual(['Archive', 'To Do']);
    expect(on('note', { secure: true }).breadcrumb).toEqual(['Vault', 'Note']);
    expect(on('note', {}).breadcrumb).toEqual(['Note']);
  });

  it('offers to show a note in the page it lives on, not the inbox', () => {
    const state = { archived: true, trashed: false, secure: false };
    expect(noteResult(hit('a b', 'Info'), 'note', 0, state).locate)
      .toEqual({ to: '/archive?locate=a%20b', label: 'Archive' });
    expect(noteResult(hit('a', 'Info'), 'todo', 0).locate?.to).toBe('/todo?locate=a');
    expect(noteResult(hit('c', 'Inbox'), 'inbox', 0).locate).toBeUndefined();
  });

  it('sends the inbox to its own page, not the note editor', () => {
    expect(noteResult(hit('c', 'Inbox'), 'inbox', 0).to).toBe('/inbox');
    expect(noteResult(hit('a b', 'Info'), 'note', 0).to).toBe('/note/a%20b');
  });

  it('falls back to Untitled rather than showing an empty row', () => {
    expect(noteResult(hit('a', ''), 'note', 0).title).toBe('Untitled');
  });

  it('files Users under Settings now that it is a tab', () => {
    const [users] = settingsResults('manage users', true);
    expect(users.source).toBe('settings');
    expect(users.breadcrumb[0]).toBe('Settings');
    expect(users.to).toBe('/settings?tab=users');
  });

  it('breadcrumbs a settings section under its tab', () => {
    const smtp = settingsResults('outbound email', true)
      .find(r => r.title === 'Outbound email (SMTP)');
    expect(smtp?.breadcrumb).toEqual(['Settings', 'Email']);
    expect(smtp?.to).toBe('/settings?tab=email&s=smtp');
  });

  // The assistant ships later; until it does, nothing may point at a tab that
  // SettingsPage no longer renders.
  it('does not surface the AI settings while the assistant is switched off', () => {
    expect(settingsResults('assistant', true)).toEqual([]);
    expect(settingsResults('ollama', true)).toEqual([]);
  });

  it('keeps groups in a fixed order regardless of relevance', () => {
    const results: SearchResult[] = [
      { key: 'c1', source: 'collection', title: 'Work', breadcrumb: [], to: '/collections', rank: 0 },
      { key: 's1', source: 'settings', title: 'Theme', breadcrumb: [], to: '/settings', rank: 0 },
      { key: 'n1', source: 'note', title: 'Work notes', breadcrumb: [], to: '/note/1', rank: 5 },
      { key: 't1', source: 'todo', title: 'Work list', breadcrumb: [], to: '/note/2', rank: 3 },
    ];
    expect(orderResults(results).map(r => r.source)).toEqual(['note', 'todo', 'settings', 'collection']);
  });

  it('ranks within a group', () => {
    const results: SearchResult[] = [
      { key: 'n2', source: 'note', title: 'B', breadcrumb: [], to: '/note/2', rank: 2 },
      { key: 'n1', source: 'note', title: 'A', breadcrumb: [], to: '/note/1', rank: 0 },
    ];
    expect(orderResults(results).map(r => r.title)).toEqual(['A', 'B']);
  });

  it('caps each group so one source cannot bury the others', () => {
    const many: SearchResult[] = Array.from({ length: 20 }, (_, i) => ({
      key: `n${i}`, source: 'note' as const, title: `N${i}`, breadcrumb: [], to: `/note/${i}`, rank: i,
    }));
    expect(orderResults(many).length).toBe(6);
    expect(orderResults(many, 2).length).toBe(2);
  });

  it('matches tags and collections by name, prefix first', () => {
    const cats = tagResults(
      [
        { name: 'Recipes', color: null, count: 3 },
        { name: 'Work recipes', color: null, count: 1 },
      ],
      'recipes',
    );
    expect(cats.map(c => c.title)).toEqual(['Recipes', 'Work recipes']);
    expect(cats[0].rank).toBe(0);
    expect(cats[1].rank).toBe(1);
    expect(cats[0].snippet).toBe('3 notes');
    expect(cats[0].to).toBe('/?tag=Recipes');

    const cols = collectionResults(
      [{ id: 7, name: 'Pinned ideas', rulesJson: '{}', createdUtc: '' }],
      'ideas',
    );
    expect(cols[0].to).toBe('/?collection=7');
    expect(cols[0].breadcrumb).toEqual(['Collection']);
  });

  it('singularises a one-note tag', () => {
    const cats = tagResults([{ name: 'Solo', color: null, count: 1 }], 'solo');
    expect(cats[0].snippet).toBe('1 note');
  });

  it('returns nothing for a blank query', () => {
    expect(tagResults([{ name: 'Any', color: null, count: 1 }], '  ')).toEqual([]);
    expect(collectionResults([{ id: 1, name: 'Any', rulesJson: '{}', createdUtc: '' }], '')).toEqual([]);
  });

  describe('jumping to a day', () => {
    const today = '2026-10-25';
    const go = (q: string) => dayJumpResults(q, today).map((r) => r.to);

    it('understands the dates people type', () => {
      expect(go('2024-03-02')).toEqual(['/journal/2024-03-02']);
      expect(go('sep 14')).toEqual(['/journal/2026-09-14']);
      expect(go('14 sep')).toEqual(['/journal/2026-09-14']);
      expect(go('yesterday')).toEqual(['/journal/2026-10-24']);
      expect(go('3 days ago')).toEqual(['/journal/2026-10-22']);
      expect(go('last fri')).toEqual(['/journal/2026-10-23']);
    });

    it('reads as a day of the journal, named in full', () => {
      const [result] = dayJumpResults('2024-03-02', today);
      expect(result.source).toBe('journal');
      expect(result.title).toMatch(/March 2, 2024/);
      expect(result.breadcrumb).toEqual(['Journal', 'Go to day']);
    });

    it('leaves a plain word to the note search, and never jumps ahead', () => {
      expect(go('mon')).toEqual([]);
      expect(go('march')).toEqual([]);
      expect(go('groceries')).toEqual([]);
      expect(go('2999-01-01')).toEqual([]);
      expect(go('   ')).toEqual([]);
      expect(dayJumpResults('yesterday', null)).toEqual([]);
    });

    it('comes first in its group', () => {
      const ordered = orderResults([
        { key: 'n', source: 'journal', title: 'A day', breadcrumb: ['Journal'], to: '/journal/2020-01-01', rank: 0 },
        ...dayJumpResults('2024-03-02', today),
      ]);
      expect(ordered[0].key).toBe('journal-day:2024-03-02');
    });
  });

  it('has a label for every group it can order', () => {
    expect(new Set(GROUP_ORDER).size).toBe(GROUP_ORDER.length);
  });
});
