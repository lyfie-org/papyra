import { describe, expect, it } from 'vitest';
import { baseKey, bestMatch, compareCatalogs, directionOf, fill, parseRich, pick, placeholders, pseudo, tags } from './core';

describe('baseKey', () => {
  it('strips a plural suffix and nothing else', () => {
    expect(baseKey('notes.count_one')).toBe('notes.count');
    expect(baseKey('notes.count_other')).toBe('notes.count');
    expect(baseKey('notes.count')).toBe('notes.count');
    expect(baseKey('settings.git_backup')).toBe('settings.git_backup');   // "backup" is not a plural form
    expect(baseKey('_one')).toBe('_one');
  });
});

describe('pick', () => {
  const en = { 'n_one': '{count} note', 'n_other': '{count} notes', 'plain': 'Hello' };
  it('chooses the plural form by the language’s own rules', () => {
    expect(pick(en, 'n', 'en', 1)).toBe('{count} note');
    expect(pick(en, 'n', 'en', 0)).toBe('{count} notes');
    expect(pick(en, 'n', 'en', 5)).toBe('{count} notes');
  });
  it('knows languages with more forms', () => {
    const pl = { 'n_one': 'one', 'n_few': 'few', 'n_many': 'many', 'n_other': 'other' };
    expect(pick(pl, 'n', 'pl', 1)).toBe('one');
    expect(pick(pl, 'n', 'pl', 3)).toBe('few');
    expect(pick(pl, 'n', 'pl', 5)).toBe('many');
    expect(pick(pl, 'n', 'pl', 1.5)).toBe('other');
  });
  it('falls back to _other, then to the plain key, then null', () => {
    expect(pick({ 'n_other': 'x' }, 'n', 'en', 1)).toBe('x');
    expect(pick({ 'n': 'x' }, 'n', 'ja', 4)).toBe('x');
    expect(pick({}, 'n', 'en', 1)).toBeNull();
    expect(pick(en, 'plain', 'en')).toBe('Hello');
    expect(pick(en, 'missing', 'en')).toBeNull();
  });
  it('survives a language code it has never heard of', () => {
    expect(pick(en, 'n', 'xx-not-real-123', 1)).toBe('{count} note');
  });
});

describe('fill', () => {
  it('fills values and leaves unknown names visible', () => {
    expect(fill('Hi {name}, you have {count}', { name: 'Bea', count: 3 })).toBe('Hi Bea, you have 3');
    expect(fill('Hi {name}', {})).toBe('Hi {name}');
    expect(fill('Hi {name}')).toBe('Hi {name}');
  });
  it('fills once: a value that looks like a placeholder stays as typed', () => {
    expect(fill('Hi {a}', { a: '{b}', b: 'no' })).toBe('Hi {b}');
  });
  it('does not mistake other braces for values', () => {
    expect(fill('Use {} and { x } here', { x: 1 })).toBe('Use {} and { x } here');
  });
});

describe('placeholders and tags', () => {
  it('list each once, in order', () => {
    expect(placeholders('{b} then {a} then {b}')).toEqual(['b', 'a']);
    expect(tags('<link>x</link> <b>y</b> <link>z</link>')).toEqual(['link', 'b']);
  });
});

describe('parseRich', () => {
  it('splits text and tags, nested', () => {
    expect(parseRich('Read the <link>release <b>notes</b></link> now')).toEqual([
      'Read the ',
      { tag: 'link', children: ['release ', { tag: 'b', children: ['notes'] }] },
      ' now',
    ]);
  });
  it('is plain text when there is no markup', () => {
    expect(parseRich('Just words')).toEqual(['Just words']);
    expect(parseRich('')).toEqual([]);
  });
  it('shows a broken tag as text instead of failing', () => {
    expect(parseRich('a </link> b')).toEqual(['a </link> b']);
    expect(parseRich('a <link>b')).toEqual(['a <link>b']);
    expect(parseRich('a <b>x <i>y</b>')).toEqual(['a <b>x <i>y</b>']);
  });
  it('treats angle brackets that are not tags as text', () => {
    expect(parseRich('1 < 2 and 3 > 2')).toEqual(['1 < 2 and 3 > 2']);
  });
});

describe('language helpers', () => {
  it('reads direction', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('he-IL')).toBe('rtl');
    expect(directionOf('de')).toBe('ltr');
    expect(directionOf('en-XA')).toBe('ltr');
  });
  it('matches the browser’s wishes to what exists', () => {
    const have = ['en', 'de', 'pt-BR'];
    expect(bestMatch(['de-AT', 'en'], have)).toBe('de');
    expect(bestMatch(['pt'], have)).toBe('pt-BR');
    expect(bestMatch(['PT-br'], have)).toBe('pt-BR');
    expect(bestMatch(['fr'], have)).toBeNull();
    expect(bestMatch([], have)).toBeNull();
  });
});

describe('pseudo', () => {
  it('accents the words and keeps values and tags intact', () => {
    const out = pseudo('Read the <link>notes</link>, {name}!');
    expect(out).toContain('<link>');
    expect(out).toContain('</link>');
    expect(out).toContain('{name}');
    expect(out).not.toMatch(/\bRead\b/);
    expect(out.startsWith('⟦')).toBe(true);
    expect(placeholders(out)).toEqual(['name']);
    expect(tags(out)).toEqual(['link']);
  });
});

describe('compareCatalogs', () => {
  const en = { 'meta.name': 'English', 'a': 'Hi {name}', 'link': 'See <link>this</link>', 'n_one': '{count} note', 'n_other': '{count} notes' };
  it('accepts a sound translation, leaving things out is fine', () => {
    expect(compareCatalogs(en, { 'meta.name': 'Deutsch', 'a': '{name}, hallo' })).toEqual([]);
    expect(compareCatalogs(en, { 'n_one': 'Eine Notiz', 'n_other': '{count} Notizen' })).toEqual([]);
  });
  it('rejects invented keys, empty text, renamed values and changed tags', () => {
    const bad = compareCatalogs(en, { 'x': 'nope', 'a': 'Hallo {nom}', 'link': 'Siehe <a>das</a>' });
    expect(bad).toContain('x: no such message in English');
    expect(bad).toContain('a: unknown value {nom}');
    expect(bad).toContain('a: missing value {name}');
    expect(bad.some(p => p.startsWith('link: tags'))).toBe(true);
    expect(compareCatalogs(en, { 'a': '  ' })).toEqual(['a: empty']);
  });
  it('needs _other whenever a plural has forms', () => {
    expect(compareCatalogs(en, { 'n_one': 'Eine' })).toEqual(['n: plural forms need n_other']);
  });
  it('lets a plural form drop {count} but not add other values', () => {
    expect(compareCatalogs(en, { 'n_one': 'Eine Notiz', 'n_other': '{count} Notizen' })).toEqual([]);
    expect(compareCatalogs(en, { 'n_one': '{who} Notiz', 'n_other': '{count}' })).toEqual(['n_one: unknown value {who}']);
  });
});
