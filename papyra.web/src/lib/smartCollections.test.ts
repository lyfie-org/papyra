import { describe, expect, it } from 'vitest';
import type { Note } from '../types/note';
import { describeRules, matchesRules, parseRules } from './smartCollections';
import { buildTags, tagProblem, MAX_TAGS_PER_NOTE } from './tags';

const note = (over: Partial<Note>): Note => ({
  id: 'n', title: 'Plan', tags: [], color: null, pinned: false, archived: false,
  kind: 'note', trashed: false, updated: '', body: '', ...over,
});

describe('matchesRules (mirrors SmartCollectionEvaluator)', () => {
  it('matches tags case-insensitively, colour, pinned and kind', () => {
    const n = note({ tags: ['Work'], color: '#dfe9df', pinned: true, kind: 'todo' });
    expect(matchesRules(n, { match: 'all', conditions: [{ field: 'tag', value: 'work' }] })).toBe(true);
    expect(matchesRules(n, { match: 'all', conditions: [{ field: 'color', value: '#DFE9DF' }] })).toBe(true);
    expect(matchesRules(n, { match: 'all', conditions: [{ field: 'pinned', value: 'true' }] })).toBe(true);
    expect(matchesRules(n, { match: 'all', conditions: [{ field: 'pinned', value: 'false' }] })).toBe(false);
    expect(matchesRules(n, { match: 'all', conditions: [{ field: 'kind', value: 'todo' }] })).toBe(true);
  });

  it('combines with all / any', () => {
    const n = note({ tags: ['work'] });
    const rules = [{ field: 'tag' as const, value: 'work' }, { field: 'pinned' as const, value: 'true' }];
    expect(matchesRules(n, { match: 'all', conditions: rules })).toBe(false);
    expect(matchesRules(n, { match: 'any', conditions: rules })).toBe(true);
    expect(matchesRules(n, { match: 'all', conditions: [] })).toBe(false);
  });

  it('never matches a secure note on its body', () => {
    const locked = note({ title: 'Bank', body: 'zebracode', secure: true });
    expect(matchesRules(locked, { match: 'all', conditions: [{ field: 'text', value: 'zebracode' }] })).toBe(false);
    expect(matchesRules(locked, { match: 'all', conditions: [{ field: 'text', value: 'bank' }] })).toBe(true);
  });

  it('describes rules in words, colours by name', () => {
    const rules = parseRules(JSON.stringify({ match: 'any', conditions: [
      { field: 'tag', value: 'work' }, { field: 'color', value: '#dfe9df' }, { field: 'kind', value: 'todo' },
    ] }))!;
    expect(describeRules(rules)).toBe('tagged work or coloured Sage or a to-do list');
    expect(parseRules('not json')).toBeNull();
  });
});

describe('tags', () => {
  it('counts live notes, merges registry colours and empty registered tags', () => {
    const tags = buildTags(
      [note({ tags: ['Work', 'home'] }), note({ tags: ['work'] }), note({ tags: ['work'], trashed: true })],
      [{ name: 'work', color: '#dfe9df' }, { name: 'Later', color: null }],
    );
    expect(tags).toEqual([
      { name: 'Work', color: '#dfe9df', count: 2 },
      { name: 'home', color: null, count: 1 },
      { name: 'Later', color: null, count: 0 },
    ]);
  });

  it('refuses a tag past the per-note limit or over-long', () => {
    expect(tagProblem('x', Array.from({ length: MAX_TAGS_PER_NOTE }, (_, i) => `t${i}`))).toMatch(/at most/);
    expect(tagProblem('y'.repeat(41), [])).toMatch(/characters/);
    expect(tagProblem('ok', [])).toBeNull();
  });
});
